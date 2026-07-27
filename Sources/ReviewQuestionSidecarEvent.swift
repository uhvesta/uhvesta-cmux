import Foundation

/// A native projection of the existing agent-chat WebSocket event protocol.
enum ReviewQuestionSidecarEvent: Sendable, Equatable {
    case status(String)
    case delta(String)
    case thinking(String)
    case toolStarted(name: String)
    case toolFinished(name: String, succeeded: Bool?)
    case completed
    case failed(String)

    var isTerminal: Bool {
        switch self {
        case .completed, .failed:
            true
        default:
            false
        }
    }

    /// Decodes every matching event emitted by the same WebSocket protocol used by agent-chat.
    static func events(messageData: Data, sessionID: String) -> [ReviewQuestionSidecarEvent] {
        guard let raw = try? JSONSerialization.jsonObject(with: messageData) as? [String: Any],
              raw["sessionId"] as? String == sessionID,
              let kind = raw["kind"] as? String else {
            return []
        }
        if kind == "session-status", let status = raw["status"] as? String {
            return [status == "error" || status == "exited" ? .failed("Copilot session \(status)") : .status(status)]
        }
        if kind == "history", let events = raw["events"] as? [[String: Any]] {
            return events.compactMap(event(from:))
        }
        guard kind == "event", let payload = raw["evt"] as? [String: Any] else { return [] }
        return event(from: payload).map { [$0] } ?? []
    }

    private static func event(from event: [String: Any]) -> ReviewQuestionSidecarEvent? {
        guard let eventKind = event["kind"] as? String else { return nil }
        switch eventKind {
        case "status":
            guard let text = event["text"] as? String else { return nil }
            return .status(text)
        case "delta", "assistant":
            guard let text = event["text"] as? String else { return nil }
            return .delta(text)
        case "thinking":
            guard let text = event["text"] as? String else { return nil }
            return .thinking(text)
        case "tool-start":
            return .toolStarted(name: event["name"] as? String ?? "tool")
        case "tool-end":
            return .toolFinished(name: event["name"] as? String ?? "tool", succeeded: event["ok"] as? Bool)
        case "done":
            return .completed
        case "error":
            return .failed(event["message"] as? String ?? "Copilot review request failed")
        default:
            return nil
        }
    }
}
