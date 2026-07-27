import Foundation
import SQLite3
import XCTest

#if canImport(cmux_DEV)
@testable import cmux_DEV
#elseif canImport(cmux)
@testable import cmux
#endif

@MainActor
final class DiffCommentStoreTests: XCTestCase {
    func testLegacySubmissionTextIsReducedToSelectedLines() {
        let comment = DiffComment(
            id: UUID(),
            filePath: "vendor/difit/src/server/server.ts",
            side: "additions",
            startLine: 124,
            endLine: 129,
            endSide: nil,
            lineText: "}",
            message: "dislike this",
            submissionText: """
            ## Review feedback

            **File:** `vendor/difit/src/server/server.ts`
            **Location:** new lines 124-129

            **Diff context**

            ```diff
            @@ -120,4 +120,12 @@
             unchanged
            +export interface DiffApp {
            +  app: Express;
            +  fileWatcher: FileWatcherService;
            +  invalidateCache: () => void;
            +  outputFinalComments: () => void;
            +}
            ```

            **Review comment**

            > dislike this
            """,
            consumedAt: nil,
            createdAt: Date(),
            updatedAt: Date()
        )

        XCTAssertEqual(
            comment.focusedSubmissionText,
            """
            **File:** `vendor/difit/src/server/server.ts`
            **Location:** new lines 124-129

            **Selected code**

            ```text
            export interface DiffApp {
              app: Express;
              fileWatcher: FileWatcherService;
              invalidateCache: () => void;
              outputFinalComments: () => void;
            }
            ```

            **Review comment**

            > dislike this

            """
        )
    }

    private struct LegacyCommentsFile: Codable {
        let repoRoot: String
        let comments: [DiffComment]
    }

    private func makeStore() throws -> (DiffCommentStore, URL) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("diff-comments-tests-\(UUID().uuidString)", isDirectory: true)
        return (DiffCommentStore(directoryURL: directory), directory)
    }

    private func makeComment(message: String = "needs a guard") -> DiffComment {
        DiffComment(
            id: UUID(),
            filePath: "Sources/App.swift",
            side: "additions",
            startLine: 10,
            endLine: 12,
            endSide: nil,
            lineText: "    let value = compute()",
            message: message,
            submissionText: "Review comment\n",
            consumedAt: nil,
            createdAt: Date(timeIntervalSince1970: 1_000),
            updatedAt: Date(timeIntervalSince1970: 1_000)
        )
    }

    func testUpsertPersistsAcrossStoreInstances() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/example-repo"
        let comment = makeComment()
        store.upsert(comment, repoRoot: repoRoot)

        let reloaded = DiffCommentStore(directoryURL: directory)
        let comments = reloaded.comments(repoRoot: repoRoot)
        XCTAssertEqual(comments.count, 1)
        XCTAssertEqual(comments[0].id, comment.id)
        XCTAssertEqual(comments[0].message, comment.message)
        XCTAssertEqual(comments[0].lineText, comment.lineText)
    }

    func testUpsertExistingPreservesCreatedAt() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/example-repo"
        let comment = makeComment()
        store.upsert(comment, repoRoot: repoRoot)

        var edited = comment
        edited.message = "edited"
        edited.createdAt = Date(timeIntervalSince1970: 9_999)
        let saved = store.upsert(edited, repoRoot: repoRoot)

        XCTAssertEqual(saved.createdAt, comment.createdAt)
        XCTAssertEqual(saved.message, "edited")
        XCTAssertEqual(store.comments(repoRoot: repoRoot).count, 1)
    }

    func testDeleteRemovesComment() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/example-repo"
        let comment = makeComment()
        store.upsert(comment, repoRoot: repoRoot)

        XCTAssertTrue(store.delete(id: comment.id, repoRoot: repoRoot))
        XCTAssertFalse(store.delete(id: comment.id, repoRoot: repoRoot))
        XCTAssertTrue(store.comments(repoRoot: repoRoot).isEmpty)
    }

    func testReposAreIsolated() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        store.upsert(makeComment(), repoRoot: "/tmp/repo-a")
        XCTAssertTrue(store.comments(repoRoot: "/tmp/repo-b").isEmpty)
        XCTAssertEqual(store.comments(repoRoot: "/tmp/repo-a").count, 1)
    }

    func testRepoKeyIsStableForEquivalentPaths() {
        XCTAssertEqual(
            DiffCommentStore.repoKey(forRepoRoot: "/tmp/repo-a"),
            DiffCommentStore.repoKey(forRepoRoot: "/tmp/repo-a/")
        )
        XCTAssertNotEqual(
            DiffCommentStore.repoKey(forRepoRoot: "/tmp/repo-a"),
            DiffCommentStore.repoKey(forRepoRoot: "/tmp/repo-b")
        )
    }

    func testSSHRepositoryRootsRemainStableKeys() {
        XCTAssertEqual(
            DiffCommentStore.canonicalRepoRoot("ssh://review-host/opt/src/repo"),
            "ssh://review-host/opt/src/repo"
        )
    }

    func testMarkConsumedPersists() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/example-repo"
        let comment = makeComment()
        store.upsert(comment, repoRoot: repoRoot)
        store.markConsumed(ids: [comment.id], repoRoot: repoRoot)

        let reloaded = DiffCommentStore(directoryURL: directory)
        XCTAssertNotNil(reloaded.comments(repoRoot: repoRoot).first?.consumedAt)
    }

    func testNilDirectoryStoreStaysInMemory() {
        let store = DiffCommentStore(directoryURL: nil)
        let comment = makeComment()
        store.upsert(comment, repoRoot: "/tmp/repo-a")
        XCTAssertEqual(store.comments(repoRoot: "/tmp/repo-a").count, 1)
    }

    func testWorkspaceStoresAreIsolatedInSQLite() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let workspaceA = store.workspaceStore(for: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!)
        let workspaceB = store.workspaceStore(for: UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")!)
        let comment = makeComment()

        workspaceA.upsert(comment, repoRoot: "/tmp/example-repo")

        XCTAssertEqual(workspaceA.comments(repoRoot: "/tmp/example-repo"), [comment])
        XCTAssertTrue(workspaceB.comments(repoRoot: "/tmp/example-repo").isEmpty)
        XCTAssertTrue(store.comments(repoRoot: "/tmp/example-repo").isEmpty)

        let reloaded = DiffCommentStore(directoryURL: directory)
            .workspaceStore(for: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!)
        XCTAssertEqual(reloaded.comments(repoRoot: "/tmp/example-repo"), [comment])
    }

    func testIdenticalUUIDsRemainIndependentAcrossGlobalAndWorkspaceScopes() throws {
        let (globalStore, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/scope-isolation-repo"
        let id = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
        let workspaceA = globalStore.workspaceStore(for: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!)
        let workspaceB = globalStore.workspaceStore(for: UUID(uuidString: "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB")!)

        var global = makeComment(message: "global")
        global.id = id
        var commentA = makeComment(message: "workspace A")
        commentA.id = id
        var commentB = makeComment(message: "workspace B")
        commentB.id = id
        globalStore.upsert(global, repoRoot: repoRoot)
        workspaceA.upsert(commentA, repoRoot: repoRoot)
        workspaceB.upsert(commentB, repoRoot: repoRoot)

        XCTAssertEqual(globalStore.comments(repoRoot: repoRoot).first?.message, "global")
        XCTAssertEqual(workspaceA.comments(repoRoot: repoRoot).first?.message, "workspace A")
        XCTAssertEqual(workspaceB.comments(repoRoot: repoRoot).first?.message, "workspace B")

        workspaceA.markConsumed(ids: [id], repoRoot: repoRoot)
        XCTAssertNil(globalStore.comments(repoRoot: repoRoot).first?.consumedAt)
        XCTAssertNotNil(workspaceA.comments(repoRoot: repoRoot).first?.consumedAt)
        XCTAssertNil(workspaceB.comments(repoRoot: repoRoot).first?.consumedAt)

        XCTAssertTrue(workspaceB.delete(id: id, repoRoot: repoRoot))
        XCTAssertEqual(globalStore.comments(repoRoot: repoRoot).count, 1)
        XCTAssertEqual(workspaceA.comments(repoRoot: repoRoot).count, 1)
        XCTAssertTrue(workspaceB.comments(repoRoot: repoRoot).isEmpty)
    }

    func testScopePrimaryKeyMigrationPreservesExistingComments() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("diff-comments-scope-migration-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databaseURL = directory.appendingPathComponent("comments.sqlite3")
        let id = UUID(uuidString: "12345678-1234-1234-1234-123456789ABC")!
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(databaseURL.path, &database), SQLITE_OK)
        defer { sqlite3_close_v2(database) }
        let schema = """
            CREATE TABLE comments (
                id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, repo_root TEXT NOT NULL,
                file_path TEXT NOT NULL, side TEXT NOT NULL, start_line INTEGER NOT NULL,
                end_line INTEGER NOT NULL, end_side TEXT, line_text TEXT NOT NULL,
                message TEXT NOT NULL, submission_text TEXT, consumed_at REAL,
                parent_id TEXT, read_only INTEGER NOT NULL DEFAULT 0, author TEXT,
                repository_label TEXT, request_status TEXT, created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            INSERT INTO comments VALUES (
                '\(id.uuidString.lowercased())', 'global', '/tmp/migrated-repo',
                'Sources/App.swift', 'additions', 10, 12, NULL, 'let value = 1',
                'preserve me', 'Review comment\\n', NULL, NULL, 0, NULL, NULL, NULL,
                1000, 1000
            );
            """
        XCTAssertEqual(sqlite3_exec(database, schema, nil, nil, nil), SQLITE_OK)
        sqlite3_close_v2(database)
        database = nil

        let store = DiffCommentStore(directoryURL: directory)
        XCTAssertEqual(store.comments(repoRoot: "/tmp/migrated-repo").first?.message, "preserve me")

        let workspace = store.workspaceStore(for: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!)
        var duplicate = makeComment(message: "workspace copy")
        duplicate.id = id
        workspace.upsert(duplicate, repoRoot: "/tmp/migrated-repo")

        XCTAssertEqual(store.comments(repoRoot: "/tmp/migrated-repo").first?.message, "preserve me")
        XCTAssertEqual(workspace.comments(repoRoot: "/tmp/migrated-repo").first?.message, "workspace copy")
    }

    func testLegacyJSONIsMigratedIntoSQLite() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("diff-comments-migration-(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/migrated-repo"
        let comment = makeComment()
        let legacy = try DiffCommentStore.encoder().encode(
            LegacyCommentsFile(repoRoot: repoRoot, comments: [comment])
        )
        try legacy.write(to: directory.appendingPathComponent("legacy.json"))

        let store = DiffCommentStore(directoryURL: directory)
        XCTAssertEqual(store.comments(repoRoot: repoRoot), [comment])
        let workspace = store.workspaceStore(
            for: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!
        )
        XCTAssertEqual(workspace.comments(repoRoot: repoRoot), [comment])
        XCTAssertTrue(store.comments(repoRoot: repoRoot).isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("comments.sqlite3").path))
    }

    func testVersionFourGlobalCommentsRemainGlobalWhenTheyDidNotComeFromLegacyJSON() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("diff-comments-v4-global-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/global-repo"
        let comment = makeComment(message: "genuine global")
        do {
            let store = DiffCommentStore(directoryURL: directory)
            store.upsert(comment, repoRoot: repoRoot)
        }
        var database: OpaquePointer?
        XCTAssertEqual(
            sqlite3_open(directory.appendingPathComponent("comments.sqlite3").path, &database),
            SQLITE_OK
        )
        XCTAssertEqual(sqlite3_exec(database, "PRAGMA user_version = 4;", nil, nil, nil), SQLITE_OK)
        sqlite3_close_v2(database)

        let store = DiffCommentStore(directoryURL: directory)
        let workspace = store.workspaceStore(
            for: UUID(uuidString: "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA")!
        )
        XCTAssertTrue(workspace.comments(repoRoot: repoRoot).isEmpty)
        XCTAssertEqual(store.comments(repoRoot: repoRoot), [comment])
    }

    func testReadOnlyAnswerPersistsWithItsQuestionMetadata() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/example-repo"
        let question = makeComment(message: "/ask Why is this branch needed?")
        let answer = DiffComment(
            id: UUID(),
            filePath: question.filePath,
            side: question.side,
            startLine: question.startLine,
            endLine: question.endLine,
            endSide: question.endSide,
            lineText: question.lineText,
            message: "It keeps the fallback reachable.",
            submissionText: nil,
            consumedAt: nil,
            parentId: question.id,
            readOnly: true,
            author: "GitHub Copilot",
            repositoryLabel: "cmux",
            requestStatus: "completed",
            sidecarRequestID: "67B40E22-97A0-42A1-82B1-9106BD8A0D05",
            sidecarSessionID: "review-session-123",
            createdAt: question.createdAt,
            updatedAt: question.updatedAt
        )
        store.upsert(question, repoRoot: repoRoot)
        store.upsert(answer, repoRoot: repoRoot)

        let restored = DiffCommentStore(directoryURL: directory).comments(repoRoot: repoRoot)
        XCTAssertEqual(restored.count, 2)
        let restoredAnswer = try XCTUnwrap(restored.first(where: { $0.id == answer.id }))
        XCTAssertEqual(restoredAnswer.parentId, question.id)
        XCTAssertTrue(restoredAnswer.readOnly)
        XCTAssertEqual(restoredAnswer.author, "GitHub Copilot")
        XCTAssertEqual(restoredAnswer.repositoryLabel, "cmux")
        XCTAssertEqual(restoredAnswer.requestStatus, "completed")
        XCTAssertEqual(restoredAnswer.sidecarRequestID, "67B40E22-97A0-42A1-82B1-9106BD8A0D05")
        XCTAssertEqual(restoredAnswer.sidecarSessionID, "review-session-123")
        XCTAssertNil(restoredAnswer.submissionText)
    }

    func testRunningQuestionSidecarIdentitySurvivesStoreReload() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/example-repo"
        var question = makeComment(message: "/ask What makes this safe?")
        question.submissionText = nil
        question.requestStatus = "running"
        question.sidecarRequestID = "request-42"
        question.sidecarSessionID = "session-42"
        store.upsert(question, repoRoot: repoRoot)

        let restored = DiffCommentStore(directoryURL: directory).comments(repoRoot: repoRoot)
        XCTAssertEqual(restored.first?.requestStatus, "running")
        XCTAssertEqual(restored.first?.sidecarRequestID, "request-42")
        XCTAssertEqual(restored.first?.sidecarSessionID, "session-42")
    }

    func testDeletingQuestionAlsoDeletesItsReadOnlyAnswers() throws {
        let (store, directory) = try makeStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let repoRoot = "/tmp/example-repo"
        let question = makeComment(message: "/ask Explain this")
        let answer = DiffComment(
            id: UUID(), filePath: question.filePath, side: question.side,
            startLine: question.startLine, endLine: question.endLine, endSide: nil,
            lineText: question.lineText, message: "Explanation", submissionText: nil,
            consumedAt: nil, parentId: question.id, readOnly: true,
            author: "GitHub Copilot", repositoryLabel: nil, requestStatus: "completed",
            createdAt: question.createdAt, updatedAt: question.updatedAt
        )
        store.upsert(question, repoRoot: repoRoot)
        store.upsert(answer, repoRoot: repoRoot)

        XCTAssertTrue(store.delete(id: question.id, repoRoot: repoRoot))
        XCTAssertTrue(store.comments(repoRoot: repoRoot).isEmpty)
    }
}

@MainActor
final class DiffBaseRefSettingsTests: XCTestCase {
    func testWorkspaceOverrideFallsBackToGlobalAndCanBeCleared() {
        let suiteName = "diff-base-ref-tests-(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
		defer { defaults.removePersistentDomain(forName: suiteName) }
		let settings = DiffBaseRefSettings(defaults: defaults)
		let stableID = "stable-workspace"
		let runtimeID = "runtime-workspace"
		let globalKey = "diffViewer.branchBaseRef"

		XCTAssertNil(settings.resolvedBaseRef(stableWorkspaceId: stableID, runtimeWorkspaceId: runtimeID))
		defaults.set("origin/main", forKey: globalKey)
        XCTAssertEqual(settings.resolvedBaseRef(stableWorkspaceId: stableID, runtimeWorkspaceId: runtimeID), "origin/main")

        settings.setWorkspaceBaseRef("upstream/main", stableWorkspaceId: stableID, runtimeWorkspaceId: runtimeID)
        XCTAssertEqual(settings.resolvedBaseRef(stableWorkspaceId: stableID, runtimeWorkspaceId: runtimeID), "upstream/main")
        settings.setWorkspaceBaseRef(nil, stableWorkspaceId: stableID, runtimeWorkspaceId: runtimeID)
        XCTAssertEqual(settings.resolvedBaseRef(stableWorkspaceId: stableID, runtimeWorkspaceId: runtimeID), "origin/main")
    }
}


@MainActor
final class DiffCommentSubmissionPoolTests: XCTestCase {
    private func entry(_ id: UUID = UUID(), text: String = "fix this\n") -> DiffCommentSubmissionPool.Entry {
        DiffCommentSubmissionPool.Entry(commentId: id, repoRoot: "/tmp/repo", submissionText: text)
    }

    func testSetPendingUpsertsById() {
        let pool = DiffCommentSubmissionPool()
        let workspace = UUID()
        let id = UUID()
        pool.setPending(entry(id, text: "first\n"), workspaceId: workspace)
        pool.setPending(entry(id, text: "edited\n"), workspaceId: workspace)
        pool.setPending(entry(), workspaceId: workspace)
        XCTAssertEqual(pool.pendingCount(workspaceId: workspace), 2)
        XCTAssertEqual(pool.entriesByWorkspace[workspace]?.first?.submissionText, "edited\n")
    }

    func testConsumeAllClearsTheWorkspaceOnly() {
        let pool = DiffCommentSubmissionPool()
        let workspaceA = UUID()
        let workspaceB = UUID()
        pool.setPending(entry(), workspaceId: workspaceA)
        pool.setPending(entry(), workspaceId: workspaceB)
        let consumed = pool.consumeAll(workspaceId: workspaceA)
        XCTAssertEqual(consumed.count, 1)
        XCTAssertEqual(pool.pendingCount(workspaceId: workspaceA), 0)
        XCTAssertEqual(pool.pendingCount(workspaceId: workspaceB), 1)
    }

    func testRestorePendingAfterFailedSubmit() {
        let pool = DiffCommentSubmissionPool()
        let workspace = UUID()
        pool.setPending(entry(), workspaceId: workspace)
        let consumed = pool.consumeAll(workspaceId: workspace)
        pool.restorePending(consumed, workspaceId: workspace)
        XCTAssertEqual(pool.pendingCount(workspaceId: workspace), 1)
    }

    func testRemovePendingDropsDeletedCommentOnlyFromItsWorkspace() {
        let pool = DiffCommentSubmissionPool()
        let workspace = UUID()
        let otherWorkspace = UUID()
        let id = UUID()
        pool.setPending(entry(id), workspaceId: workspace)
        // The SQLite store permits this exact UUID in a second workspace scope.
        pool.setPending(entry(id), workspaceId: otherWorkspace)
        pool.removePending(commentId: id, workspaceId: workspace)
        XCTAssertEqual(pool.pendingCount(workspaceId: workspace), 0)
        XCTAssertEqual(pool.pendingCount(workspaceId: otherWorkspace), 1)
    }

    func testReviewBundleConsumesEverySourceCommentAsOneEntry() throws {
        let pool = DiffCommentSubmissionPool()
        let workspace = UUID()
        let first = UUID()
        let second = UUID()
        pool.setPending(entry(first), workspaceId: workspace)
        pool.setPending(entry(second), workspaceId: workspace)

        pool.queueReviewBundle(
            submissionText: "# Review feedback\n",
            consumptionTargets: [
                .init(commentId: first, repoRoot: "/tmp/repo-a"),
                .init(commentId: second, repoRoot: "/tmp/repo-b"),
            ],
            workspaceId: workspace
        )

        let bundle = try XCTUnwrap(pool.consumeAll(workspaceId: workspace).first)
        XCTAssertTrue(bundle.isReviewBundle)
        XCTAssertEqual(Set(bundle.consumptionTargets.map(\.commentId)), Set([first, second]))
        pool.restorePending([bundle], workspaceId: workspace)
        XCTAssertEqual(pool.pendingCount(workspaceId: workspace), 1)
    }

    func testOrdinaryPendingCommentsConsumeAsOneRepositoryGroupedMarkdownDocument() throws {
        let pool = DiffCommentSubmissionPool()
        let workspace = UUID()
        let first = UUID()
        let second = UUID()
        pool.setPending(
            .init(
                commentId: first,
                repoRoot: "/tmp/repo-a",
                submissionText: "**File:** `a.swift`\n"
            ),
            workspaceId: workspace
        )
        pool.setPending(
            .init(
                commentId: second,
                repoRoot: "/tmp/repo-b",
                submissionText: "**File:** `b.swift`\n"
            ),
            workspaceId: workspace
        )

        let consumed = pool.consumeAll(workspaceId: workspace)
        let bundle = try XCTUnwrap(consumed.first)
        XCTAssertEqual(consumed.count, 1)
        XCTAssertTrue(bundle.isReviewBundle)
        XCTAssertEqual(Set(bundle.consumptionTargets.map(\.commentId)), Set([first, second]))
        XCTAssertTrue(bundle.submissionText.contains("# Review feedback"))
        XCTAssertTrue(bundle.submissionText.contains("## Repository: `/tmp/repo-a`"))
        XCTAssertTrue(bundle.submissionText.contains("## Repository: `/tmp/repo-b`"))
        XCTAssertTrue(bundle.submissionText.contains("### Feedback 1"))
        XCTAssertTrue(bundle.submissionText.contains("### Feedback 2"))
        XCTAssertEqual(bundle.submissionText.components(separatedBy: "# Review feedback").count - 1, 1)
    }
}

final class ReviewQuestionSidecarHistoryTests: XCTestCase {
    func testHistoryReplayEmitsOnlyEventsNotAlreadyDeliveredLive() {
        let delivered: [ReviewQuestionSidecarEvent] = [
            .status("running"),
            .delta("First sentence."),
        ]
        let replay = delivered + [.delta(" Second sentence."), .completed]

        XCTAssertEqual(
            ReviewQuestionSidecarClient.historyReplayTail(delivered: delivered, replay: replay),
            [.delta(" Second sentence."), .completed]
        )
    }
}

@MainActor
final class DiffCommentsBridgeTokenTests: XCTestCase {
    private let token = "0c33124b-9f59-4ba2-a2c2-9bd3b1cba001"

    func testCustomSchemePageURLYieldsToken() {
        let url = URL(string: "cmux-diff-viewer://\(token)/diff-1-abc.html")
        XCTAssertEqual(DiffCommentsBridge.diffViewerToken(from: url), token)
    }

    func testLocalServerPageWithOriginalFragmentYieldsToken() {
        let url = URL(string: "http://127.0.0.1:5050/\(token)/diff-1-abc.html#cmux-diff-viewer")
        XCTAssertEqual(DiffCommentsBridge.diffViewerToken(from: url), token)
    }

    func testLocalServerPageWithRouterRewrittenFragmentYieldsToken() {
        // The in-page router rewrites the fragment to "/cmux-diff-viewer"
        // after boot; live bridge messages carry this form.
        let url = URL(string: "http://127.0.0.1:5050/\(token)/diff-1-abc.html#/cmux-diff-viewer")
        XCTAssertEqual(DiffCommentsBridge.diffViewerToken(from: url), token)
    }

    func testNonLoopbackAndMalformedURLsAreRejected() {
        XCTAssertNil(DiffCommentsBridge.diffViewerToken(
            from: URL(string: "http://example.com/\(token)/diff-1-abc.html")
        ))
        XCTAssertNil(DiffCommentsBridge.diffViewerToken(
            from: URL(string: "http://127.0.0.1:5050/not-a-token/diff.html")
        ))
        XCTAssertNil(DiffCommentsBridge.diffViewerToken(
            from: URL(string: "http://127.0.0.1:5050/\(token)/../escape.html")
        ))
        XCTAssertNil(DiffCommentsBridge.diffViewerToken(from: nil))
    }
}

final class DiffReviewPromptTerminalTargetTests: XCTestCase {
    func testReviewPanelTargetsTheMostRecentlyUsedTerminalWithoutChangingFocus() {
        let reviewPanelID = UUID()
        let rememberedTerminalID = UUID()
        let fallbackTerminalID = UUID()

        XCTAssertEqual(
            DiffCommentsBridge.reviewPromptTerminalPanelID(
                focusedPanelID: reviewPanelID,
                rememberedTerminalPanelID: rememberedTerminalID,
                orderedPanelIDs: [reviewPanelID, fallbackTerminalID, rememberedTerminalID],
                terminalPanelIDs: [rememberedTerminalID, fallbackTerminalID]
            ),
            rememberedTerminalID
        )
    }
}
