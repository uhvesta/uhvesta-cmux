import Foundation

/// Calls the agent-chat one-turn Copilot review API and subscribes to its normal ACP events.
actor ReviewQuestionSidecarClient {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func start(_ request: ReviewQuestionSidecarRequest) async throws -> ReviewQuestionSidecarResult {
        var urlRequest = URLRequest(url: endpoint())
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONEncoder().encode(request)
        let (data, response) = try await session.data(for: urlRequest)
        try validate(response: response, data: data)
        return try JSONDecoder().decode(ReviewQuestionSidecarResult.self, from: data)
    }

    func result(id: String) async throws -> ReviewQuestionSidecarResult {
        let (data, response) = try await session.data(from: endpoint(id: id))
        try validate(response: response, data: data)
        return try JSONDecoder().decode(ReviewQuestionSidecarResult.self, from: data)
    }

    func cancel(id: String) async throws {
        var request = URLRequest(url: endpoint(id: id))
        request.httpMethod = "DELETE"
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
    }

    /// Streams the established agent-chat session protocol for the request's session ID.
    func events(for sessionID: String) -> AsyncThrowingStream<ReviewQuestionSidecarEvent, Error> {
        let socket = session.webSocketTask(with: websocketURL())
        return AsyncThrowingStream { continuation in
            socket.resume()
            let worker = Task {
                do {
                    var deliveredAgentEvents: [ReviewQuestionSidecarEvent] = []
                    let subscription = try JSONSerialization.data(withJSONObject: ["op": "subscribe", "sessionId": sessionID])
                    try await socket.send(.data(subscription))
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        let data: Data
                        switch message {
                        case .data(let value): data = value
                        case .string(let value): data = Data(value.utf8)
                        @unknown default: continue
                        }
                        let decoded = ReviewQuestionSidecarEvent.events(messageData: data, sessionID: sessionID)
                        let events: [ReviewQuestionSidecarEvent]
                        if Self.isHistoryMessage(data, sessionID: sessionID) {
                            // A reconnect/history broadcast can contain every event already
                            // delivered live. Keep the common prefix and emit only its tail.
                            events = Self.historyReplayTail(delivered: deliveredAgentEvents, replay: decoded)
                            deliveredAgentEvents.append(contentsOf: events)
                        } else {
                            events = decoded
                            if Self.isAgentEventMessage(data, sessionID: sessionID) {
                                deliveredAgentEvents.append(contentsOf: events)
                            }
                        }
                        for event in events {
                            continuation.yield(event)
                            if event.isTerminal {
                                continuation.finish()
                                socket.cancel(with: .normalClosure, reason: nil)
                                return
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                worker.cancel()
                socket.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    private func endpoint(id: String? = nil) -> URL {
        var url = baseURL
            .appendingPathComponent("api", isDirectory: true)
            .appendingPathComponent("review-questions", isDirectory: false)
        if let id {
            url.appendPathComponent(id, isDirectory: false)
        }
        return url
    }

    private func websocketURL() -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent("ws"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        return components.url!
    }

    private static func isHistoryMessage(_ data: Data, sessionID: String) -> Bool {
        messageKind(data, sessionID: sessionID) == "history"
    }

    private static func isAgentEventMessage(_ data: Data, sessionID: String) -> Bool {
        messageKind(data, sessionID: sessionID) == "event"
    }

    private static func messageKind(_ data: Data, sessionID: String) -> String? {
        guard let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              raw["sessionId"] as? String == sessionID else {
            return nil
        }
        return raw["kind"] as? String
    }

    /// Returns the unseen suffix when an agent-chat history message replays
    /// events already delivered through the live socket channel.
    nonisolated static func historyReplayTail(
        delivered: [ReviewQuestionSidecarEvent],
        replay: [ReviewQuestionSidecarEvent]
    ) -> [ReviewQuestionSidecarEvent] {
        var count = 0
        while count < delivered.count,
              count < replay.count,
              delivered[count] == replay[count] {
            count += 1
        }
        return Array(replay.dropFirst(count))
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let response = response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode) else {
            let detail = String(data: data, encoding: .utf8) ?? "sidecar request failed"
            throw ReviewQuestionSidecarClientError.requestFailed(detail)
        }
    }

    private enum ReviewQuestionSidecarClientError: LocalizedError {
        case requestFailed(String)

        var errorDescription: String? {
            switch self {
            case .requestFailed(let detail): detail
            }
        }
    }
}
