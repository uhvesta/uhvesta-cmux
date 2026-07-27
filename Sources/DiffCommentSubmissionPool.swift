import Foundation

/// Workspace-scoped pool of saved-but-unsent diff review comments.
///
/// Every terminal TextBox in the workspace shows one "[N comments]" chip
/// while the pool is non-empty; whichever TextBox submits first consumes the
/// whole pool (its submission gets the formatted comments appended) and the
/// chip clears everywhere. Diff viewer pages repopulate the pool through the
/// comments bridge on load and on every save/delete.
@MainActor
final class DiffCommentSubmissionPool: ObservableObject {
    static let shared = DiffCommentSubmissionPool()

    struct Entry: Equatable {
        let commentId: UUID
        let repoRoot: String
        let submissionText: String
        /// Every persisted comment this entry consumes after the TextBox submit succeeds.
        /// Ordinary entries contain one target; an explicit review bundle contains
        /// all feedback comments while still flowing through the same rollback path.
        let consumptionTargets: [ConsumptionTarget]
        let isReviewBundle: Bool

        struct ConsumptionTarget: Equatable, Hashable {
            let commentId: UUID
            let repoRoot: String
        }

        init(
            commentId: UUID,
            repoRoot: String,
            submissionText: String,
            consumptionTargets: [ConsumptionTarget]? = nil,
            isReviewBundle: Bool = false
        ) {
            self.commentId = commentId
            self.repoRoot = repoRoot
            self.submissionText = submissionText
            self.consumptionTargets = consumptionTargets ?? [
                ConsumptionTarget(commentId: commentId, repoRoot: repoRoot)
            ]
            self.isReviewBundle = isReviewBundle
        }
    }

    @Published private(set) var entriesByWorkspace: [UUID: [Entry]] = [:]

    func setPending(_ entry: Entry, workspaceId: UUID) {
        var entries = entriesByWorkspace[workspaceId] ?? []
        // An explicit review bundle is the sole document that should be
        // delivered. Viewer reloads re-register individual comments, but they
        // must not split a deliberately queued aggregate back apart.
        if entries.contains(where: \.isReviewBundle) && !entry.isReviewBundle {
            return
        }
        if let index = entries.firstIndex(where: { $0.commentId == entry.commentId }) {
            entries[index] = entry
        } else {
            entries.append(entry)
        }
        entriesByWorkspace[workspaceId] = entries
    }

    func removePending(commentId: UUID) {
        for (workspaceId, entries) in entriesByWorkspace {
            let remaining = entries.filter { entry in
                entry.commentId != commentId && !entry.consumptionTargets.contains(where: { $0.commentId == commentId })
            }
            if remaining.count != entries.count {
                entriesByWorkspace[workspaceId] = remaining.isEmpty ? nil : remaining
            }
        }
    }

    func pendingCount(workspaceId: UUID?) -> Int {
        guard let workspaceId else { return 0 }
        return entriesByWorkspace[workspaceId]?.count ?? 0
    }

    /// Claims every pending comment for the workspace; the caller appends the
    /// entries' submission text to its outgoing submission and either marks
    /// them consumed in the store or restores them on a failed submit.
    func consumeAll(workspaceId: UUID) -> [Entry] {
        guard let entries = entriesByWorkspace[workspaceId], !entries.isEmpty else { return [] }
        entriesByWorkspace[workspaceId] = nil
        return entries
    }

    /// Puts entries claimed by `consumeAll` back (failed submit rollback).
    func restorePending(_ entries: [Entry], workspaceId: UUID) {
        for entry in entries {
            setPending(entry, workspaceId: workspaceId)
        }
    }

    /// Replaces individual pending comments with one structured review document.
    /// The document remains subject to the ordinary `consumeAll`/rollback flow.
    func queueReviewBundle(
        submissionText: String,
        consumptionTargets: [Entry.ConsumptionTarget],
        workspaceId: UUID
    ) {
        let uniqueTargets = Array(Set(consumptionTargets)).sorted {
            if $0.repoRoot != $1.repoRoot { return $0.repoRoot < $1.repoRoot }
            return $0.commentId.uuidString < $1.commentId.uuidString
        }
        guard !submissionText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !uniqueTargets.isEmpty else {
            return
        }
        entriesByWorkspace[workspaceId] = [
            Entry(
                commentId: UUID(),
                repoRoot: uniqueTargets[0].repoRoot,
                submissionText: submissionText,
                consumptionTargets: uniqueTargets,
                isReviewBundle: true
            )
        ]
    }
}
