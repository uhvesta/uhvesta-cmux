import Foundation

/// The explicit review context submitted to the sidecar's one-turn Copilot API.
struct ReviewQuestionSidecarRequest: Codable, Sendable, Equatable {
    let repoRoot: String
    let reviewPrompt: String
    let question: String?
    let title: String?

    init(repoRoot: String, reviewPrompt: String, question: String? = nil, title: String? = nil) {
        self.repoRoot = repoRoot
        self.reviewPrompt = reviewPrompt
        self.question = question
        self.title = title
    }
}
