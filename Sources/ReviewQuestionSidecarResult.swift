import Foundation

/// Current state of a one-turn Copilot review request returned by agent-chat.
struct ReviewQuestionSidecarResult: Codable, Sendable, Equatable {
    let id: String
    let sessionId: String
    let repoRoot: String
    let kind: String
    let readOnly: Bool
    let status: String
    let answer: String
    let error: String?
}
