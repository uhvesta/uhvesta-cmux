import AppKit
import Foundation
import WebKit

/// Native bridge for the diff viewer webview's review comments: per-repo
/// comment persistence plus registration into the workspace's pending
/// submission pool (consumed by whichever terminal TextBox submits first).
///
/// Only main-frame pages served from a registered diff viewer session (custom
/// `cmux-diff-viewer://` scheme or the local HTTP server form) may call it;
/// every other page gets a `not_allowed` reply.
@MainActor
final class DiffCommentsBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "cmuxDiffComments"
    static let shared = DiffCommentsBridge()

    private static var handlerInstalledKey: UInt8 = 0
    private static var panelAssociationKey: UInt8 = 0

    private final class PanelAssociation: NSObject {
        let panelId: UUID
        let workspaceId: UUID

        init(panelId: UUID, workspaceId: UUID) {
            self.panelId = panelId
            self.workspaceId = workspaceId
        }
    }

    private enum BridgeError: Error {
        case notAllowed
        case invalidRequest(String)

        var code: String {
            switch self {
            case .notAllowed: return "not_allowed"
            case .invalidRequest: return "invalid_request"
            }
        }

        var userMessage: String {
            switch self {
            case .notAllowed:
                return String(
                    localized: "diffComments.bridge.notAllowed",
                    defaultValue: "This page cannot use diff comments."
                )
            case .invalidRequest(let detail):
                return detail
            }
        }
    }

    private struct QuestionTaskKey: Hashable {
        let workspaceScope: UUID
        let commentID: UUID
    }

    private struct ActiveQuestionTask {
        let runID: UUID
        let requestID: String
        let client: ReviewQuestionSidecarClient
        let task: Task<Void, Never>
    }

    private let store: DiffCommentStore
    /// Live sidecar observation is scoped exactly like the SQLite comment
    /// store. Equal comment UUIDs are valid in separate workspace scopes.
    private var questionTasks: [QuestionTaskKey: ActiveQuestionTask] = [:]

    init(store: DiffCommentStore? = nil) {
        // Default resolved in the MainActor body: a `.shared` default argument
        // would evaluate in the caller's nonisolated context and warn.
        self.store = store ?? DiffCommentStore.shared
    }

    /// Adds the reply handler to a user content controller exactly once.
    static func installIfNeeded(on userContentController: WKUserContentController) {
        guard objc_getAssociatedObject(userContentController, &handlerInstalledKey) == nil else {
            return
        }
        userContentController.addScriptMessageHandler(
            shared,
            contentWorld: .page,
            name: handlerName
        )
        objc_setAssociatedObject(
            userContentController,
            &handlerInstalledKey,
            NSNumber(value: true),
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
    }

    /// Records which browser panel owns a web view so the bridge can resolve
    /// the diff viewer's workspace for the pending submission pool.
    static func associate(panelId: UUID, workspaceId: UUID, with webView: WKWebView) {
        objc_setAssociatedObject(
            webView,
            &panelAssociationKey,
            PanelAssociation(panelId: panelId, workspaceId: workspaceId),
            .OBJC_ASSOCIATION_RETAIN_NONATOMIC
        )
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard Self.isTrustedDiffViewerFrame(message.frameInfo) else {
            replyHandler(Self.errorReply(BridgeError.notAllowed), nil)
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let value = try await self.handle(body: message.body, webView: message.webView)
                replyHandler(["ok": true, "value": value], nil)
            } catch let error as BridgeError {
                replyHandler(Self.errorReply(error), nil)
            } catch {
                replyHandler(["ok": false, "error": [:]] as [String: Any], nil)
            }
        }
    }

    private static func errorReply(_ error: BridgeError) -> [String: Any] {
        ["ok": false, "error": ["code": error.code, "userMessage": error.userMessage]]
    }

    static func isTrustedDiffViewerFrame(_ frameInfo: WKFrameInfo) -> Bool {
        frameInfo.isMainFrame && isTrustedDiffViewerURL(frameInfo.request.url)
    }

    static func isTrustedDiffViewerURL(_ url: URL?) -> Bool {
        DiffViewerSessionTrustRegistry.shared.isTrustedDiffViewerURL(url)
    }

    /// Extracts the diff viewer session token from a live page URL. Unlike
    /// `diffViewerComponents(from:)` this ignores the fragment: the viewer's
    /// in-page router rewrites `#cmux-diff-viewer` to `#/cmux-diff-viewer`
    /// once the app boots, so live bridge messages carry a different fragment
    /// than the URL the page was opened with. Token registration (checked by
    /// the caller) remains the trust authority.
    static func diffViewerToken(from url: URL?) -> String? {
        if let components = CmuxDiffViewerURLSchemeHandler.diffViewerComponents(from: url) {
            return components.token
        }
        guard let url,
              url.scheme == "http" || url.scheme == "https",
              url.host == "127.0.0.1" else {
            return nil
        }
        let rawPath = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        let parts = rawPath.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard parts.count >= 2,
              CmuxDiffViewerURLSchemeHandler.isValidToken(parts[0]),
              CmuxDiffViewerURLSchemeHandler.isValidRequestPath("/" + parts.dropFirst().joined(separator: "/")) else {
            return nil
        }
        return parts[0]
    }

    /// Chooses a terminal without changing the workspace's focused panel.
    ///
    /// A review panel normally owns focus while this action runs, so the most
    /// recently used terminal is preferred before the stable visual ordering.
    static func reviewPromptTerminalPanelID(
        focusedPanelID: UUID?,
        rememberedTerminalPanelID: UUID?,
        orderedPanelIDs: [UUID],
        terminalPanelIDs: Set<UUID>
    ) -> UUID? {
        if let focusedPanelID, terminalPanelIDs.contains(focusedPanelID) {
            return focusedPanelID
        }
        if let rememberedTerminalPanelID, terminalPanelIDs.contains(rememberedTerminalPanelID) {
            return rememberedTerminalPanelID
        }
        return orderedPanelIDs.first(where: terminalPanelIDs.contains)
    }

    private func handle(body: Any, webView: WKWebView?) async throws -> Any {
        guard let body = body as? [String: Any],
              let method = body["method"] as? String else {
            throw BridgeError.invalidRequest("Malformed bridge request")
        }
        let params = body["params"] as? [String: Any] ?? [:]
        let repoRoot = (params["repoRoot"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)

        switch method {
        case "comments.list":
            guard let repoRoot, !repoRoot.isEmpty else { throw BridgeError.invalidRequest("Missing repoRoot") }
            // Viewer loads repopulate the workspace's pending pool so the
            // TextBox chips survive app restarts and page reloads.
            let workspace = try? resolveWorkspace(for: webView)
            let scopedStore = workspace.map { store.workspaceStore(for: $0.stableId) } ?? store
            var comments = scopedStore.comments(repoRoot: repoRoot)
            if let workspace {
                for comment in comments {
                    registerPending(comment, repoRoot: repoRoot, workspaceId: workspace.id)
                }
                await resumeUnfinishedQuestions(
                    comments,
                    repoRoot: repoRoot,
                    workspace: workspace,
                    panelId: try? resolvePanelID(for: webView)
                )
                comments = scopedStore.comments(repoRoot: repoRoot)
            }
            return ["comments": comments.map(Self.commentJSON)]
        case "comments.save":
            guard let repoRoot, !repoRoot.isEmpty else { throw BridgeError.invalidRequest("Missing repoRoot") }
            guard let commentParams = params["comment"] as? [String: Any],
                  let comment = Self.comment(fromJSON: commentParams),
                  comment.parentId == nil,
                  !comment.readOnly else {
                throw BridgeError.invalidRequest("Malformed comment")
            }
            let workspace = try? resolveWorkspace(for: webView)
            let scopedStore = workspace.map { store.workspaceStore(for: $0.stableId) } ?? store
            let existing = scopedStore.comments(repoRoot: repoRoot).first { $0.id == comment.id }
            guard !Self.isReviewQuestion(comment), !Self.isReviewQuestion(existing) else {
                throw BridgeError.invalidRequest(String(
                    localized: "diffComments.bridge.reviewQuestionsCannotEdit",
                    defaultValue: "Review questions cannot be edited. Delete the question and ask again."
                ))
            }
            let saved = scopedStore.upsert(comment, repoRoot: repoRoot)
            if let workspace {
                registerPending(saved, repoRoot: repoRoot, workspaceId: workspace.id)
            }
            return ["comment": Self.commentJSON(saved)]
        case "comments.delete":
            guard let repoRoot, !repoRoot.isEmpty else { throw BridgeError.invalidRequest("Missing repoRoot") }
            guard let rawId = params["id"] as? String, let id = UUID(uuidString: rawId) else {
                throw BridgeError.invalidRequest("Missing comment id")
            }
            let workspace = try? resolveWorkspace(for: webView)
            let scopedStore = workspace.map { store.workspaceStore(for: $0.stableId) } ?? store
            let existing = scopedStore.comments(repoRoot: repoRoot).first { $0.id == id }
            let deleted = scopedStore.delete(id: id, repoRoot: repoRoot)
            if let workspace {
                DiffCommentSubmissionPool.shared.removePending(commentId: id, workspaceId: workspace.id)
                if deleted, Self.isReviewQuestion(existing) {
                    await cancelQuestion(
                        workspace: workspace,
                        commentID: id,
                        requestID: existing?.sidecarRequestID
                    )
                }
            }
            return ["deleted": deleted]
        case "comments.sendReviewPrompt":
            guard let reviewPrompt = params["reviewPrompt"] as? String,
                  !reviewPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let rawTargets = params["commentTargets"] as? [[String: Any]] else {
                throw BridgeError.invalidRequest(String(
                    localized: "diffComments.bridge.missingReviewPrompt",
                    defaultValue: "Missing review prompt."
                ))
            }
            let workspace = try resolveWorkspace(for: webView)
            let scopedStore = store.workspaceStore(for: workspace.stableId)
            let targets = rawTargets.compactMap { target -> DiffCommentSubmissionPool.Entry.ConsumptionTarget? in
                guard let rawID = target["id"] as? String,
                      let id = UUID(uuidString: rawID),
                      let rawRepoRoot = (target["repoRoot"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !rawRepoRoot.isEmpty else { return nil }
                let canonicalRoot = DiffCommentStore.canonicalRepoRoot(rawRepoRoot)
                let known = scopedStore.comments(repoRoot: canonicalRoot).contains { comment in
                    comment.id == id && comment.parentId == nil && !comment.readOnly &&
                        !Self.isReviewQuestion(comment) && comment.consumedAt == nil
                }
                return known ? DiffCommentSubmissionPool.Entry.ConsumptionTarget(commentId: id, repoRoot: canonicalRoot) : nil
            }
            guard !targets.isEmpty else {
                throw BridgeError.invalidRequest(String(
                    localized: "diffComments.bridge.noPendingReviewComments",
                    defaultValue: "There are no pending review comments to send."
                ))
            }
            let terminalPanelIDs = Set(workspace.panels.compactMap { id, panel in
                panel is TerminalPanel ? id : nil
            })
            guard let terminalPanelID = Self.reviewPromptTerminalPanelID(
                focusedPanelID: workspace.focusedPanelId,
                rememberedTerminalPanelID: workspace.lastTerminalConfigInheritancePanelId,
                orderedPanelIDs: workspace.orderedPanelIds,
                terminalPanelIDs: terminalPanelIDs
            ),
            let terminalPanel = workspace.terminalPanel(for: terminalPanelID) else {
                throw BridgeError.invalidRequest(String(
                    localized: "diffComments.bridge.noTerminalForReviewPrompt",
                    defaultValue: "Open a terminal in this workspace before sending the review prompt."
                ))
            }
            let terminalAgentContext = WorkspaceContentView.terminalAgentContext(
                panel: terminalPanel,
                workspace: workspace
            )
            let didSubmit = await withCheckedContinuation { continuation in
                TextBoxSubmit.send(
                    reviewPrompt,
                    via: terminalPanel.surface,
                    terminalAgentContext: terminalAgentContext
                ) { completion in
                    continuation.resume(returning: completion.didSubmit)
                }
            }
            guard didSubmit else {
                throw BridgeError.invalidRequest(String(
                    localized: "diffComments.bridge.sendReviewPromptFailed",
                    defaultValue: "Could not send the review prompt to the terminal."
                ))
            }
            for (repoRoot, repoTargets) in Dictionary(grouping: targets, by: \.repoRoot) {
                scopedStore.markConsumed(ids: repoTargets.map(\.commentId), repoRoot: repoRoot)
            }
            for target in targets {
                DiffCommentSubmissionPool.shared.removePending(
                    commentId: target.commentId,
                    workspaceId: workspace.id
                )
            }
            return ["sent": targets.count]
        case "comments.ask":
            guard let repoRoot, !repoRoot.isEmpty else { throw BridgeError.invalidRequest("Missing repoRoot") }
            return try await ask(
                params: params,
                repoRoot: repoRoot,
                webView: webView
            )
        default:
            throw BridgeError.invalidRequest("Unsupported method '\(method)'")
        }
    }

    private func ask(
        params: [String: Any],
        repoRoot: String,
        webView: WKWebView?
    ) async throws -> [String: Any] {
        guard let rawComment = params["comment"] as? [String: Any],
              var question = Self.comment(fromJSON: rawComment),
              question.parentId == nil,
              !question.readOnly,
              let reviewPrompt = params["reviewPrompt"] as? String,
              !reviewPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let questionText = params["question"] as? String,
              !questionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeError.invalidRequest(String(
                localized: "diffComments.bridge.malformedReviewQuestion",
                defaultValue: "Malformed review question."
            ))
        }
        guard !Self.isRemoteReviewRoot(repoRoot) else {
            throw BridgeError.invalidRequest(String(
                localized: "diffComments.bridge.reviewQuestionsUnavailableForRemote",
                defaultValue: "Copilot questions are unavailable for SSH review. Regular comments and review prompts still work."
            ))
        }
        let workspace = try resolveWorkspace(for: webView)
        let panelId = try resolvePanelID(for: webView)
        let scopedStore = store.workspaceStore(for: workspace.stableId)
        let existing = scopedStore.comments(repoRoot: repoRoot)
        if let existingAnswer = existing.first(where: { $0.parentId == question.id }),
           let existingQuestion = existing.first(where: { $0.id == question.id }) {
            return [
                "question": Self.commentJSON(existingQuestion),
                "answer": Self.commentJSON(existingAnswer),
                "status": existingAnswer.requestStatus ?? "running"
            ]
        }
        // `/ask` is a review question, not feedback for the next TextBox
        // submission. Its durable parent is intentionally not editable: an
        // edit could otherwise turn it into ordinary pending feedback.
        question.submissionText = nil
        question.consumedAt = nil
        question.requestStatus = "running"
        question.updatedAt = Date()
        // Persist the caller-owned request ID before contacting the sidecar.
        // If the sidecar accepts the POST but the connection drops before its
        // response arrives, a retry can safely reattach to this exact turn.
        question.sidecarRequestID = question.id.uuidString
        question.sidecarSessionID = question.id.uuidString
        let savedQuestion = scopedStore.upsert(question, repoRoot: repoRoot)
        // Persist the child before the first suspension point. A repeated
        // click/Cmd-Enter can then observe and return this exact pair instead
        // of creating a second answer while the first POST is in flight.
        let placeholderResult = ReviewQuestionSidecarResult(
            id: savedQuestion.id.uuidString,
            sessionId: savedQuestion.id.uuidString,
            repoRoot: DiffCommentStore.canonicalRepoRoot(repoRoot),
            kind: "review-question",
            readOnly: true,
            status: "running",
            answer: "",
            error: nil
        )
        let pendingAnswer = scopedStore.upsert(
            pendingAnswer(for: savedQuestion, result: placeholderResult),
            repoRoot: repoRoot
        )
        DiffCommentSubmissionPool.shared.removePending(commentId: savedQuestion.id, workspaceId: workspace.id)

        let app = AppDelegate.shared
        guard let app else {
            let failed = markQuestionFailed(savedQuestion, existingAnswer: pendingAnswer, repoRoot: repoRoot, store: scopedStore)
            let savedAnswer = failed.answer
            AppDelegate.postReviewQuestionNotification(
                workspace: workspace,
                panelId: panelId,
                requestID: savedAnswer.id.uuidString,
                succeeded: false,
                body: savedAnswer.message
            )
            return ["question": Self.commentJSON(failed.question), "answer": Self.commentJSON(savedAnswer), "status": "failed"]
        }

        do {
            let request = ReviewQuestionSidecarRequest(
                requestID: savedQuestion.sidecarRequestID ?? savedQuestion.id.uuidString,
                repoRoot: DiffCommentStore.canonicalRepoRoot(repoRoot),
                reviewPrompt: reviewPrompt,
                question: questionText
            )
            let (client, result) = try await startQuestion(
                request,
                app: app,
                workspace: workspace
            )
            var persistedQuestion = savedQuestion
            persistedQuestion.requestStatus = result.status
            persistedQuestion.sidecarRequestID = result.id
            persistedQuestion.sidecarSessionID = result.sessionId
            persistedQuestion.updatedAt = Date()
            persistedQuestion = scopedStore.upsert(persistedQuestion, repoRoot: repoRoot)
            var savedAnswer = pendingAnswer
            savedAnswer.requestStatus = result.status
            savedAnswer.sidecarRequestID = result.id
            savedAnswer.sidecarSessionID = result.sessionId
            savedAnswer.updatedAt = Date()
            savedAnswer = scopedStore.upsert(savedAnswer, repoRoot: repoRoot)
            let taskKey = questionTaskKey(workspace: workspace, commentID: persistedQuestion.id)
            questionTasks[taskKey]?.task.cancel()
            let runID = UUID()
            let task = Task { [weak self, weak app] in
                guard let self else { return }
                await self.observeQuestion(
                    client: client,
                    result: result,
                    question: persistedQuestion,
                    answer: savedAnswer,
                    repoRoot: repoRoot,
                    workspace: workspace,
                    panelId: panelId,
                    app: app,
                    taskKey: taskKey,
                    runID: runID
                )
            }
            questionTasks[taskKey] = ActiveQuestionTask(
                runID: runID,
                requestID: result.id,
                client: client,
                task: task
            )
            return ["question": Self.commentJSON(persistedQuestion), "answer": Self.commentJSON(savedAnswer), "status": result.status]
        } catch {
            let failed = markQuestionFailed(savedQuestion, existingAnswer: pendingAnswer, repoRoot: repoRoot, store: scopedStore)
            let savedAnswer = failed.answer
            app.postReviewQuestionNotification(
                workspace: workspace,
                panelId: panelId,
                requestID: savedAnswer.id.uuidString,
                succeeded: false,
                body: savedAnswer.message
            )
            return ["question": Self.commentJSON(failed.question), "answer": Self.commentJSON(savedAnswer), "status": "failed"]
        }
    }

    private func observeQuestion(
        client: ReviewQuestionSidecarClient,
        result: ReviewQuestionSidecarResult,
        question: DiffComment,
        answer initialAnswer: DiffComment,
        repoRoot: String,
        workspace: Workspace,
        panelId: UUID?,
        app: AppDelegate?,
        taskKey: QuestionTaskKey,
        runID: UUID
    ) async {
        defer { finishQuestionTask(for: taskKey, runID: runID) }
        let scopedStore = store.workspaceStore(for: workspace.stableId)
        var answer = initialAnswer
        var activeClient = client
        var activeResult = result
        var appendStreamedDeltas = true
        var reattachmentAttempts = 0
        while !Task.isCancelled {
            do {
                let initial = try await activeClient.result(id: activeResult.id)
                if initial.status != "running" {
                    guard let persistedQuestion = persistedQuestion(
                        id: question.id,
                        requestID: activeResult.id,
                        repoRoot: repoRoot,
                        store: scopedStore
                    ) else { return }
                    answer = scopedStore.comments(repoRoot: repoRoot).first(where: { $0.parentId == question.id }) ?? answer
                    let saved = completeQuestion(initial, question: persistedQuestion, answer: answer, repoRoot: repoRoot, store: scopedStore)
                    if let panelId {
                        app?.postReviewQuestionNotification(
                            workspace: workspace,
                            panelId: panelId,
                            requestID: activeResult.id,
                            succeeded: initial.status == "completed",
                            body: saved.message
                        )
                    }
                    return
                }
                let eventStream = await activeClient.events(for: activeResult.sessionId)
                for try await event in eventStream {
                    guard !Task.isCancelled else { return }
                    if appendStreamedDeltas, case .delta(let text) = event, !text.isEmpty {
                        guard persistedQuestion(
                            id: question.id,
                            requestID: activeResult.id,
                            repoRoot: repoRoot,
                            store: scopedStore
                        ) != nil else { return }
                        answer.message += text
                        answer.updatedAt = Date()
                        _ = scopedStore.upsert(answer, repoRoot: repoRoot)
                    }
                }
                guard !Task.isCancelled else { return }
                let final = try await activeClient.result(id: activeResult.id)
                guard let persistedQuestion = persistedQuestion(
                    id: question.id,
                    requestID: activeResult.id,
                    repoRoot: repoRoot,
                    store: scopedStore
                ) else { return }
                answer = scopedStore.comments(repoRoot: repoRoot).first(where: { $0.parentId == question.id }) ?? answer
                let saved = completeQuestion(final, question: persistedQuestion, answer: answer, repoRoot: repoRoot, store: scopedStore)
                if let panelId {
                    app?.postReviewQuestionNotification(
                        workspace: workspace,
                        panelId: panelId,
                        requestID: activeResult.id,
                        succeeded: final.status == "completed",
                        body: saved.message
                    )
                }
            } catch {
                guard !Task.isCancelled else { return }
                // A connection error can occur after an app-owned sidecar has
                // accepted durable work but before its replacement is ready.
                // Reacquire the sidecar and poll the same caller-owned ID
                // before turning a running question into a terminal failure.
                guard reattachmentAttempts < Self.questionReattachmentRetryLimit,
                      let app else {
                    break
                }
                reattachmentAttempts += 1
                do {
                    let (reattachedClient, reattachedResult) = try await reattachQuestion(
                        id: activeResult.id,
                        app: app,
                        workspace: workspace
                    )
                    activeClient = reattachedClient
                    activeResult = reattachedResult
                    // A replacement sidecar replays its full event history.
                    // Keep the current partial answer until the authoritative
                    // terminal GET replaces it, rather than duplicating deltas.
                    appendStreamedDeltas = false
                    continue
                } catch {
                    continue
                }
            }
        }
        guard !Task.isCancelled,
              let persistedQuestion = persistedQuestion(
                  id: question.id,
                  requestID: activeResult.id,
                  repoRoot: repoRoot,
                  store: scopedStore
              ) else { return }
        let saved = markQuestionFailed(persistedQuestion, existingAnswer: answer, repoRoot: repoRoot, store: scopedStore).answer
        if let panelId {
            app?.postReviewQuestionNotification(
                workspace: workspace,
                panelId: panelId,
                requestID: activeResult.id,
                succeeded: false,
                body: saved.message
            )
        }
    }

    private func pendingAnswer(for question: DiffComment, result: ReviewQuestionSidecarResult) -> DiffComment {
        DiffComment(
            // The caller-owned request ID is the parent comment UUID. Provider
            // answers need a distinct durable comment identity.
            id: UUID(),
            filePath: question.filePath,
            side: question.side,
            startLine: question.startLine,
            endLine: question.endLine,
            endSide: question.endSide,
            lineText: question.lineText,
            message: String(
                localized: "diffComments.copilot.pendingAnswer",
                defaultValue: "Copilot is preparing an answer…"
            ),
            submissionText: nil,
            consumedAt: nil,
            parentId: question.id,
            readOnly: true,
            author: String(localized: "diffComments.copilot.author", defaultValue: "GitHub Copilot"),
            repositoryLabel: question.repositoryLabel,
            requestStatus: "running",
            sidecarRequestID: result.id,
            sidecarSessionID: result.sessionId,
            createdAt: Date(),
            updatedAt: Date()
        )
    }

    private func failedAnswer(for question: DiffComment) -> DiffComment {
        let result = ReviewQuestionSidecarResult(
            id: question.sidecarRequestID ?? UUID().uuidString,
            sessionId: question.sidecarSessionID ?? "",
            repoRoot: "",
            kind: "review-question",
            readOnly: true,
            status: "failed",
            answer: "",
            error: nil
        )
        var answer = pendingAnswer(for: question, result: result)
        answer.message = failedAnswerMessage()
        answer.requestStatus = "failed"
        return answer
    }

    private func completeQuestion(
        _ result: ReviewQuestionSidecarResult,
        question: DiffComment,
        answer: DiffComment,
        repoRoot: String,
        store: DiffCommentStore
    ) -> DiffComment {
        var persistedQuestion = question
        persistedQuestion.requestStatus = result.status
        persistedQuestion.sidecarRequestID = result.id
        persistedQuestion.sidecarSessionID = result.sessionId
        persistedQuestion.updatedAt = Date()
        _ = store.upsert(persistedQuestion, repoRoot: repoRoot)

        var persistedAnswer = answer
        persistedAnswer.message = result.answer.trimmingCharacters(in: .whitespacesAndNewlines)
        persistedAnswer.requestStatus = result.status
        persistedAnswer.sidecarRequestID = result.id
        persistedAnswer.sidecarSessionID = result.sessionId
        if result.status != "completed" {
            persistedAnswer.message = failedAnswerMessage()
        } else if persistedAnswer.message.isEmpty {
            persistedAnswer.message = String(
                localized: "diffComments.copilot.emptyAnswer",
                defaultValue: "Copilot completed without a text response."
            )
        }
        persistedAnswer.updatedAt = Date()
        return store.upsert(persistedAnswer, repoRoot: repoRoot)
    }

    private func markQuestionFailed(
        _ question: DiffComment,
        existingAnswer: DiffComment?,
        repoRoot: String,
        store: DiffCommentStore
    ) -> (question: DiffComment, answer: DiffComment) {
        var persistedQuestion = question
        persistedQuestion.requestStatus = "failed"
        persistedQuestion.updatedAt = Date()
        persistedQuestion = store.upsert(persistedQuestion, repoRoot: repoRoot)
        var answer = existingAnswer ?? failedAnswer(for: persistedQuestion)
        answer.message = failedAnswerMessage()
        answer.requestStatus = "failed"
        answer.sidecarRequestID = persistedQuestion.sidecarRequestID
        answer.sidecarSessionID = persistedQuestion.sidecarSessionID
        answer.updatedAt = Date()
        return (persistedQuestion, store.upsert(answer, repoRoot: repoRoot))
    }

    private func questionTaskKey(workspace: Workspace, commentID: UUID) -> QuestionTaskKey {
        QuestionTaskKey(workspaceScope: workspace.stableId, commentID: commentID)
    }

    private static let questionReattachmentRetryLimit = 2

    /// Attempts an idempotent POST against a freshly resolved sidecar. Every
    /// retry carries the persisted request ID, so it either creates the turn
    /// once or returns the already accepted durable result.
    private func startQuestion(
        _ request: ReviewQuestionSidecarRequest,
        app: AppDelegate,
        workspace: Workspace
    ) async throws -> (ReviewQuestionSidecarClient, ReviewQuestionSidecarResult) {
        var lastError: Error?
        for _ in 0...Self.questionReattachmentRetryLimit {
            guard !Task.isCancelled else { throw CancellationError() }
            guard let client = await app.reviewQuestionSidecarClient(for: workspace) else {
                continue
            }
            do {
                return (client, try await client.start(request))
            } catch {
                lastError = error
            }
        }
        throw lastError ?? ReviewQuestionStartError.sidecarUnavailable
    }

    /// Reacquires an in-flight request after a transient sidecar connection
    /// loss. App-owned resolution may launch a replacement sidecar, whose
    /// durable checkpoint restores the same request ID before it becomes ready.
    private func reattachQuestion(
        id: String,
        app: AppDelegate,
        workspace: Workspace
    ) async throws -> (ReviewQuestionSidecarClient, ReviewQuestionSidecarResult) {
        var lastError: Error?
        for _ in 0...Self.questionReattachmentRetryLimit {
            guard !Task.isCancelled else { throw CancellationError() }
            guard let client = await app.reviewQuestionSidecarClient(for: workspace) else {
                continue
            }
            do {
                return (client, try await client.result(id: id))
            } catch {
                lastError = error
            }
        }
        throw lastError ?? ReviewQuestionStartError.sidecarUnavailable
    }

    private enum ReviewQuestionStartError: Error {
        case sidecarUnavailable
    }

    private func finishQuestionTask(for key: QuestionTaskKey, runID: UUID) {
        guard questionTasks[key]?.runID == runID else { return }
        questionTasks[key] = nil
    }

    /// Deletes the live sidecar resource after the durable parent was removed.
    /// The parent-existence guards in `observeQuestion` make a late sidecar
    /// terminal event harmless even if DELETE races its completion.
    private func cancelQuestion(workspace: Workspace, commentID: UUID, requestID: String?) async {
        let key = questionTaskKey(workspace: workspace, commentID: commentID)
        let active = questionTasks.removeValue(forKey: key)
        active?.task.cancel()
        let sidecarRequestID = active?.requestID ?? requestID
        guard let sidecarRequestID, !sidecarRequestID.isEmpty else { return }
        let client: ReviewQuestionSidecarClient?
        if let active {
            client = active.client
        } else {
            client = await AppDelegate.shared?.reviewQuestionSidecarClient(for: workspace)
        }
        guard let client else { return }
        try? await client.cancel(id: sidecarRequestID)
    }

    /// Returns the current durable parent only when it still belongs to this
    /// sidecar request. A deleted or superseded question must never be
    /// resurrected by a late event, completion, or notification.
    private func persistedQuestion(
        id: UUID,
        requestID: String,
        repoRoot: String,
        store: DiffCommentStore
    ) -> DiffComment? {
        store.comments(repoRoot: repoRoot).first { comment in
            comment.id == id && Self.isReviewQuestion(comment) && comment.sidecarRequestID == requestID
        }
    }

    /// Restores persisted, unfinished `/ask` work after a page or app restart.
    /// A missing request/session identity cannot be reattached, so it is marked
    /// failed instead of leaving an indeterminate permanent spinner.
    private func resumeUnfinishedQuestions(
        _ comments: [DiffComment],
        repoRoot: String,
        workspace: Workspace,
        panelId: UUID?
    ) async {
        guard !Self.isRemoteReviewRoot(repoRoot) else { return }
        let questions = comments.filter { Self.isReviewQuestion($0) && $0.requestStatus == "running" }
        guard !questions.isEmpty else { return }
        let scopedStore = store.workspaceStore(for: workspace.stableId)
        guard let app = AppDelegate.shared else {
            for question in questions {
                let failed = markQuestionFailed(
                    question,
                    existingAnswer: comments.first { $0.parentId == question.id },
                    repoRoot: repoRoot,
                    store: scopedStore
                )
                if let panelId {
                    AppDelegate.postReviewQuestionNotification(
                        workspace: workspace,
                        panelId: panelId,
                        requestID: question.sidecarRequestID ?? question.id.uuidString,
                        succeeded: false,
                        body: failed.answer.message
                    )
                }
            }
            return
        }
        for question in questions {
            let taskKey = questionTaskKey(workspace: workspace, commentID: question.id)
            guard questionTasks[taskKey] == nil else { continue }
            guard let requestID = question.sidecarRequestID, !requestID.isEmpty,
                  let sessionID = question.sidecarSessionID, !sessionID.isEmpty else {
                let failed = markQuestionFailed(
                    question,
                    existingAnswer: comments.first { $0.parentId == question.id },
                    repoRoot: repoRoot,
                    store: scopedStore
                )
                if let panelId {
                    app.postReviewQuestionNotification(
                        workspace: workspace,
                        panelId: panelId,
                        requestID: question.sidecarRequestID ?? question.id.uuidString,
                        succeeded: false,
                        body: failed.answer.message
                    )
                }
                continue
            }
            do {
                let (client, result) = try await reattachQuestion(
                    id: requestID,
                    app: app,
                    workspace: workspace
                )
                let existingAnswer = comments.first { $0.parentId == question.id }
                    ?? pendingAnswer(for: question, result: result)
                if result.status != "running" {
                    guard let currentQuestion = persistedQuestion(
                        id: question.id,
                        requestID: requestID,
                        repoRoot: repoRoot,
                        store: scopedStore
                    ) else { continue }
                    let currentAnswer = scopedStore.comments(repoRoot: repoRoot).first(where: { $0.parentId == question.id }) ?? existingAnswer
                    let saved = completeQuestion(result, question: currentQuestion, answer: currentAnswer, repoRoot: repoRoot, store: scopedStore)
                    if let panelId {
                        app.postReviewQuestionNotification(workspace: workspace, panelId: panelId, requestID: requestID, succeeded: result.status == "completed", body: saved.message)
                    }
                    continue
                }
                let restoredResult = ReviewQuestionSidecarResult(
                    id: result.id,
                    sessionId: result.sessionId.isEmpty ? sessionID : result.sessionId,
                    repoRoot: result.repoRoot,
                    kind: result.kind,
                    readOnly: result.readOnly,
                    status: result.status,
                    answer: result.answer,
                    error: result.error
                )
                var persistedQuestion = question
                persistedQuestion.sidecarRequestID = restoredResult.id
                persistedQuestion.sidecarSessionID = restoredResult.sessionId
                persistedQuestion.updatedAt = Date()
                persistedQuestion = scopedStore.upsert(persistedQuestion, repoRoot: repoRoot)
                let persistedAnswer = scopedStore.upsert(existingAnswer, repoRoot: repoRoot)
                let runID = UUID()
                let task = Task { [weak self, weak app] in
                    guard let self else { return }
                    await self.observeQuestion(
                        client: client,
                        result: restoredResult,
                        question: persistedQuestion,
                        answer: persistedAnswer,
                        repoRoot: repoRoot,
                        workspace: workspace,
                        panelId: panelId,
                        app: app,
                        taskKey: taskKey,
                        runID: runID
                    )
                }
                questionTasks[taskKey] = ActiveQuestionTask(
                    runID: runID,
                    requestID: restoredResult.id,
                    client: client,
                    task: task
                )
            } catch {
                let failed = markQuestionFailed(
                    question,
                    existingAnswer: comments.first { $0.parentId == question.id },
                    repoRoot: repoRoot,
                    store: scopedStore
                )
                if let panelId {
                    app.postReviewQuestionNotification(
                        workspace: workspace,
                        panelId: panelId,
                        requestID: requestID,
                        succeeded: false,
                        body: failed.answer.message
                    )
                }
            }
        }
    }

    private func failedAnswerMessage() -> String {
        String(
            localized: "diffComments.copilot.failedAnswer",
            defaultValue: "Copilot couldn't answer this question."
        )
    }

    private func registerPending(_ comment: DiffComment, repoRoot: String, workspaceId: UUID) {
        let submissionText = comment.focusedSubmissionText
        guard !Self.isReviewQuestion(comment),
              comment.consumedAt == nil,
              !submissionText.isEmpty else {
            return
        }
        DiffCommentSubmissionPool.shared.setPending(
            DiffCommentSubmissionPool.Entry(
                commentId: comment.id,
                repoRoot: DiffCommentStore.canonicalRepoRoot(repoRoot),
                repositoryLabel: comment.repositoryLabel,
                submissionText: submissionText
            ),
            workspaceId: workspaceId
        )
    }

    nonisolated private static func isReviewQuestion(_ comment: DiffComment?) -> Bool {
        guard let comment else { return false }
        let message = comment.message.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return message == "/ask" || message.hasPrefix("/ask ") ||
            comment.sidecarRequestID != nil || comment.sidecarSessionID != nil
    }

    nonisolated private static func isRemoteReviewRoot(_ repoRoot: String) -> Bool {
        repoRoot.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("ssh://")
    }

    // MARK: - Workspace resolution

    private func resolveWorkspace(for webView: WKWebView?) throws -> Workspace {
        guard let webView,
              let association = objc_getAssociatedObject(
                  webView,
                  &Self.panelAssociationKey
              ) as? PanelAssociation,
              let app = AppDelegate.shared,
              let location = app.workspaceContainingPanel(
                  panelId: association.panelId,
                  preferredWorkspaceId: association.workspaceId
              ) else {
            throw BridgeError.invalidRequest("Diff viewer surface not found")
        }
        return location.workspace
    }

    private func resolvePanelID(for webView: WKWebView?) throws -> UUID {
        guard let webView,
              let association = objc_getAssociatedObject(
                  webView,
                  &Self.panelAssociationKey
              ) as? PanelAssociation else {
            throw BridgeError.invalidRequest("Diff viewer surface not found")
        }
        return association.panelId
    }

    // MARK: - JSON mapping

    nonisolated private static func commentJSON(_ comment: DiffComment) -> [String: Any] {
        let formatter = ISO8601DateFormatter()
        var json: [String: Any] = [
            "id": comment.id.uuidString,
            "filePath": comment.filePath,
            "side": comment.side,
            "startLine": comment.startLine,
            "endLine": comment.endLine,
            "lineText": comment.lineText,
            "message": comment.message,
            "submissionText": comment.submissionText ?? "",
            "createdAt": formatter.string(from: comment.createdAt),
            "updatedAt": formatter.string(from: comment.updatedAt)
        ]
        if let endSide = comment.endSide {
            json["endSide"] = endSide
        }
        if let parentId = comment.parentId {
            json["parentId"] = parentId.uuidString
        }
        if comment.readOnly {
            json["readOnly"] = true
        }
        if let author = comment.author {
            json["author"] = author
        }
        if let repositoryLabel = comment.repositoryLabel {
            json["repositoryLabel"] = repositoryLabel
        }
        if let requestStatus = comment.requestStatus {
            json["requestStatus"] = requestStatus
        }
        if let sidecarRequestID = comment.sidecarRequestID {
            json["sidecarRequestId"] = sidecarRequestID
        }
        if let sidecarSessionID = comment.sidecarSessionID {
            json["sidecarSessionId"] = sidecarSessionID
        }
        if let consumedAt = comment.consumedAt {
            json["consumedAt"] = formatter.string(from: consumedAt)
        }
        return json
    }

    nonisolated private static func comment(fromJSON json: [String: Any]) -> DiffComment? {
        guard let filePath = json["filePath"] as? String, !filePath.isEmpty,
              let side = json["side"] as? String,
              let startLine = json["startLine"] as? Int,
              let endLine = json["endLine"] as? Int,
              let message = json["message"] as? String else {
            return nil
        }
        let id = (json["id"] as? String).flatMap(UUID.init(uuidString:)) ?? UUID()
        let now = Date()
        return DiffComment(
            id: id,
            filePath: filePath,
            side: side == "deletions" ? "deletions" : "additions",
            startLine: startLine,
            endLine: endLine,
            endSide: json["endSide"] as? String,
            lineText: json["lineText"] as? String ?? "",
            message: message,
            submissionText: json["submissionText"] as? String,
            consumedAt: nil,
            parentId: (json["parentId"] as? String).flatMap(UUID.init(uuidString:)),
            readOnly: json["readOnly"] as? Bool ?? false,
            author: json["author"] as? String,
            repositoryLabel: json["repositoryLabel"] as? String,
            requestStatus: json["requestStatus"] as? String,
            sidecarRequestID: json["sidecarRequestId"] as? String,
            sidecarSessionID: json["sidecarSessionId"] as? String,
            createdAt: now,
            updatedAt: now
        )
    }
}

extension BrowserPanel {
    func hasCurrentURL(_ expectedURL: String) -> Bool {
        (webView.url ?? currentURL)?.absoluteString == expectedURL
    }

    @discardableResult
    func navigateFromCLI(_ url: String, expectedURL: String? = nil) -> Bool {
        guard expectedURL.map(hasCurrentURL) != false else { return false }
        if let internalURL = URL(string: url),
           internalURL.scheme == CmuxDiffViewerURLSchemeHandler.scheme {
            guard CmuxDiffViewerURLSchemeHandler.shared.allowsNavigation(to: internalURL) else { return false }
            navigate(to: internalURL)
        } else {
            navigateSmart(url)
        }
        return true
    }
}

extension CmuxDiffViewerURLSchemeHandler {
    func allowsNavigation(to url: URL) -> Bool {
        guard url.scheme == Self.scheme,
              url.user == nil,
              url.password == nil,
              url.port == nil,
              url.query == nil,
              url.fragment == nil else {
            return false
        }
        return registeredFile(for: url) != nil
    }
}
