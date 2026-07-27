import AppKit
import Foundation

// Split from AppDelegate+AgentChat.swift to keep that file under the
// 500-line tracking threshold after concurrent merges grew it.
extension AppDelegate {
    /// Posts exactly one terminal notification when a one-turn review question
    /// reaches a terminal state. Streaming ACP events update the saved answer
    /// instead of creating notification noise.
    func postReviewQuestionNotification(
        workspace: Workspace,
        panelId: UUID,
        requestID: String,
        succeeded: Bool,
        body: String
    ) {
        Self.postReviewQuestionNotification(
            workspace: workspace,
            panelId: panelId,
            requestID: requestID,
            succeeded: succeeded,
            body: body
        )
    }

    static func postReviewQuestionNotification(
        workspace: Workspace,
        panelId: UUID,
        requestID: String,
        succeeded: Bool,
        body: String
    ) {
        TerminalNotificationStore.shared.addNotification(
            tabId: workspace.id,
            surfaceId: panelId,
            title: succeeded
                ? String(localized: "notification.reviewQuestion.completed.title", defaultValue: "Copilot answer ready")
                : String(localized: "notification.reviewQuestion.failed.title", defaultValue: "Copilot question failed"),
            subtitle: succeeded
                ? String(localized: "notification.reviewQuestion.completed.subtitle", defaultValue: "Review question")
                : String(localized: "notification.reviewQuestion.failed.subtitle", defaultValue: "Review question"),
            body: body,
            cooldownKey: "review-question.\(requestID)",
            cooldownInterval: 60
        )
    }

    func postAgentChatServerUnavailableNotification(
        workspace: Workspace?,
        agentChat: CmuxAgentChatConfiguration
    ) {
        let body: String
        if let startCommand = agentChat.startCommand {
            let format = String(
                localized: "notification.agentChat.serverUnavailable.bodyWithCommand",
                defaultValue: "cmux couldn't reach %@. Start it with: %@"
            )
            body = String(format: format, agentChat.url.absoluteString, startCommand)
        } else {
            let format = String(
                localized: "notification.agentChat.serverUnavailable.bodyDefault",
                defaultValue: "cmux couldn't reach %@. Start the server with cmux-chat or configure agentChat.startCommand in cmux.json."
            )
            body = String(format: format, agentChat.url.absoluteString)
        }
        // No workspace = owned launch failed; anchor to the focused workspace.
        guard let anchorTabId = workspace?.id ?? activeTabManagerForCommands(preferredWindow: nil)?.selectedTabId else {
            return
        }
        let subtitle = workspace == nil
            ? String(
                localized: "notification.agentChat.serverUnavailable.subtitleLaunchFailed",
                defaultValue: "Could not start Agent Chat"
            )
            : String(
                localized: "notification.agentChat.serverUnavailable.subtitle",
                defaultValue: "Opened Agent Chat"
            )
        TerminalNotificationStore.shared.addNotification(
            tabId: anchorTabId,
            surfaceId: workspace?.focusedPanelId,
            title: String(
                localized: "notification.agentChat.serverUnavailable.title",
                defaultValue: "Agent chat server isn't running"
            ),
            subtitle: subtitle,
            body: body,
            cooldownKey: "agent-chat-server-unavailable.\(agentChat.url.absoluteString)",
            cooldownInterval: 30
        )
    }
}
