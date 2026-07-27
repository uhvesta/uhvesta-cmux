import Foundation

/// The explicit review context submitted to the sidecar's one-turn Copilot API.
struct ReviewQuestionSidecarRequest: Codable, Sendable, Equatable {
    /// Durable caller-owned correlation key. The sidecar uses this as the
    /// request/session identity so retrying an accepted POST is idempotent.
    let requestID: String
    let repoRoot: String
    let reviewPrompt: String
    let question: String?
    let title: String?

    private enum CodingKeys: String, CodingKey {
        case requestID = "requestId"
        case repoRoot
        case reviewPrompt
        case question
        case title
    }

    init(
        requestID: String,
        repoRoot: String,
        reviewPrompt: String,
        question: String? = nil,
        title: String? = nil
    ) {
        self.requestID = requestID
        self.repoRoot = repoRoot
        self.reviewPrompt = reviewPrompt
        self.question = question
        self.title = title
    }
}
