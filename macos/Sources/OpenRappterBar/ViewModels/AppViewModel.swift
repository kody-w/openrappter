import Foundation
import SwiftUI

// MARK: - Activity Item

public struct ActivityItem: Identifiable, Sendable {
    public let id: String
    public let timestamp: Date
    public let type: ActivityType
    public let text: String

    public enum ActivityType: String, Sendable {
        case userMessage
        case assistantMessage
        case error
        case system
    }

    public var color: Color {
        switch type {
        case .userMessage: return .blue
        case .assistantMessage: return .green
        case .error: return .red
        case .system: return .secondary
        }
    }

    public var icon: String {
        switch type {
        case .userMessage: return "person.fill"
        case .assistantMessage: return "cpu"
        case .error: return "exclamationmark.triangle.fill"
        case .system: return "info.circle"
        }
    }
}

// MARK: - Chat State

public enum ChatState: Sendable {
    case idle
    case sending
    case streaming
    case error(String)
}

// MARK: - App ViewModel

@Observable
@MainActor
public final class AppViewModel {
    // Connection
    public var connectionState: ConnectionState = .disconnected
    public var gatewayStatus: GatewayStatusResponse?

    // Chat
    public var chatInput: String = ""
    public var chatState: ChatState = .idle
    public var streamingText: String = ""
    public var currentSessionKey: String?

    // Activity
    public var activities: [ActivityItem] = []
    private static let maxActivities = 20

    // Process
    public var processState: ProcessManager.ProcessState = .stopped

    // Services (internal for testing)
    var connection: GatewayConnection?
    var rpcClient: RpcClient?
    let processManager = ProcessManager()

    // MARK: - Computed

    public var statusIcon: String {
        switch connectionState {
        case .connected: return "checkmark.circle.fill"
        case .connecting, .handshaking: return "arrow.triangle.2.circlepath"
        case .reconnecting: return "arrow.clockwise"
        case .disconnected: return "xmark.circle"
        }
    }

    public var statusColor: Color {
        switch connectionState {
        case .connected: return .green
        case .connecting, .handshaking, .reconnecting: return .orange
        case .disconnected: return .gray
        }
    }

    public var statusText: String {
        switch connectionState {
        case .connected:
            if let status = gatewayStatus {
                return "Connected (\(status.connections) conn, up \(formatUptime(status.uptime)))"
            }
            return "Connected"
        case .connecting: return "Connecting..."
        case .handshaking: return "Handshaking..."
        case .reconnecting: return "Reconnecting..."
        case .disconnected: return "Disconnected"
        }
    }

    public var canSend: Bool {
        connectionState == .connected && !chatInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Init

    public init() {}

    // MARK: - Actions

    public func connectToGateway() {
        let conn = GatewayConnection()
        self.connection = conn
        self.rpcClient = RpcClient(connection: conn)

        conn.onStateChange = { [weak self] state in
            Task { @MainActor in
                self?.connectionState = state
                if state == .connected {
                    await self?.fetchStatus()
                }
            }
        }

        conn.onEvent = { [weak self] event, payload in
            Task { @MainActor in
                self?.handleEvent(event: event, payload: payload)
            }
        }

        Task {
            do {
                try await conn.connect()
            } catch {
                addActivity(type: .error, text: "Connection failed: \(error.localizedDescription)")
            }
        }
    }

    public func disconnectFromGateway() {
        connection?.disconnect()
        connection = nil
        rpcClient = nil
        gatewayStatus = nil
    }

    public func sendMessage() {
        let message = chatInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty, let rpc = rpcClient else { return }

        chatInput = ""
        chatState = .sending
        streamingText = ""
        addActivity(type: .userMessage, text: message)

        Task {
            do {
                let accepted = try await rpc.sendChat(message: message, sessionKey: currentSessionKey)
                currentSessionKey = accepted.sessionKey
                chatState = .streaming
            } catch {
                chatState = .error(error.localizedDescription)
                addActivity(type: .error, text: "Send failed: \(error.localizedDescription)")
            }
        }
    }

    public func startGateway() {
        Task {
            do {
                processState = .starting
                try await processManager.start()
                processState = processManager.state
                addActivity(type: .system, text: "Gateway started")
                connectToGateway()
            } catch {
                processState = .stopped
                addActivity(type: .error, text: "Start failed: \(error.localizedDescription)")
            }
        }
    }

    public func stopGateway() {
        Task {
            disconnectFromGateway()
            processState = .stopping
            await processManager.stop()
            processState = .stopped
            addActivity(type: .system, text: "Gateway stopped")
        }
    }

    public func fetchStatus() async {
        guard let rpc = rpcClient else { return }
        do {
            gatewayStatus = try await rpc.getStatus()
        } catch {
            // Silently ignore status fetch failures
        }
    }

    // MARK: - Event Handling

    func handleEvent(event: String, payload: Any) {
        switch event {
        case "chat":
            guard let chatPayload = ChatEventPayload.parse(from: payload) else { return }
            handleChatEvent(chatPayload)
        case "heartbeat":
            break  // Silent
        default:
            addActivity(type: .system, text: "Event: \(event)")
        }
    }

    private func handleChatEvent(_ payload: ChatEventPayload) {
        switch payload.state {
        case .delta:
            streamingText = payload.messageText ?? streamingText
            chatState = .streaming

        case .final_:
            let finalText = payload.messageText ?? streamingText
            if !finalText.isEmpty {
                addActivity(type: .assistantMessage, text: finalText)
            }
            streamingText = ""
            chatState = .idle

        case .error:
            let errorMsg = payload.errorMessage ?? "Unknown error"
            chatState = .error(errorMsg)
            addActivity(type: .error, text: "Agent error: \(errorMsg)")
            streamingText = ""
        }
    }

    // MARK: - Activity

    func addActivity(type: ActivityItem.ActivityType, text: String) {
        let item = ActivityItem(
            id: UUID().uuidString,
            timestamp: Date(),
            type: type,
            text: text
        )
        activities.insert(item, at: 0)
        if activities.count > Self.maxActivities {
            activities = Array(activities.prefix(Self.maxActivities))
        }
    }

    // MARK: - Helpers

    private func formatUptime(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
    }
}
