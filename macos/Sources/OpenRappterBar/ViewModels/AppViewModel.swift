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

    // Chat (delegated to ChatViewModel)
    public let chatViewModel = ChatViewModel()

    // Sessions (delegated to SessionsViewModel)
    public let sessionsViewModel = SessionsViewModel()

    // Channels, Cron, Approvals
    public let channelsViewModel = ChannelsViewModel()
    public let cronViewModel = CronViewModel()
    public let approvalViewModel = ApprovalViewModel()

    // Activity (legacy — kept for backwards compat with ActivityListView)
    public var activities: [ActivityItem] = []

    // Process
    public var processState: ProcessManager.ProcessState = .stopped

    // Heartbeat
    public var heartbeatHealth: HeartbeatHealth = .healthy
    public var heartbeatLatency: TimeInterval?

    // Menu bar uptime display
    public var menuBarUptime: String = ""
    private var uptimeTimer: Task<Void, Never>?

    // Callbacks
    public var onRpcClientReady: ((RpcClient) -> Void)?

    // Services
    var connection: GatewayConnection?
    var rpcClient: RpcClient?
    public let processManager: ProcessManager
    var heartbeatMonitor: HeartbeatMonitor?
    let eventBus: EventBus
    let sessionStore: SessionStore

    // Legacy chat state (forwarded from ChatViewModel for existing views)
    public var chatInput: String {
        get { chatViewModel.chatInput }
        set { chatViewModel.chatInput = newValue }
    }
    public var chatState: ChatState {
        chatViewModel.chatState
    }
    public var streamingText: String {
        chatViewModel.streamingText
    }
    public var currentSessionKey: String? {
        chatViewModel.currentSessionKey
    }

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
        connectionState == .connected && chatViewModel.canSend
    }

    // MARK: - Init

    /// Default initializer — creates its own services.
    public init() {
        let bus = EventBus()
        self.eventBus = bus
        self.processManager = ProcessManager()
        self.sessionStore = SessionStore()
        Task { await sessionStore.load() }
    }

    /// Detect a running gateway and connect to it automatically.
    public func detectAndConnect(host: String = AppConstants.defaultHost, port: Int = AppConstants.defaultPort) {
        Task {
            if await processManager.detectRunningGateway() {
                processState = .running
                addActivity(type: .system, text: "Detected running gateway")
                connectToGateway(host: host, port: port)
            }
        }
    }

    /// DI initializer — accepts pre-built services for testing.
    public init(
        processManager: ProcessManager,
        eventBus: EventBus,
        sessionStore: SessionStore? = nil
    ) {
        self.processManager = processManager
        self.eventBus = eventBus
        self.sessionStore = sessionStore ?? SessionStore()
    }

    // MARK: - Actions

    public func connectToGateway(host: String = AppConstants.defaultHost, port: Int = AppConstants.defaultPort) {
        let conn = GatewayConnection(host: host, port: port)
        self.connection = conn
        let rpc = RpcClient(connection: conn)
        self.rpcClient = rpc

        // Configure sub-ViewModels
        chatViewModel.configure(rpcClient: rpc, sessionStore: sessionStore)
        sessionsViewModel.configure(rpcClient: rpc, sessionStore: sessionStore)
        channelsViewModel.configure(rpcClient: rpc)
        cronViewModel.configure(rpcClient: rpc)
        approvalViewModel.configure(rpcClient: rpc)
        onRpcClientReady?(rpc)

        let hb = HeartbeatMonitor(rpcClient: rpc, eventBus: eventBus)
        self.heartbeatMonitor = hb

        Task {
            await conn.setStateHandler { [weak self] state in
                Task { @MainActor in
                    self?.connectionState = state
                    if state == .connected {
                        await self?.fetchStatus()
                        await self?.heartbeatMonitor?.start()
                        self?.sessionsViewModel.syncFromGateway()
                        self?.startUptimeTimer()
                    } else if state == .disconnected {
                        await self?.heartbeatMonitor?.stop()
                        self?.stopUptimeTimer()
                    }
                }
            }

            await conn.setEventHandler { [weak self] event, payload in
                Task { @MainActor in
                    self?.handleEvent(event: event, payload: payload)
                }
            }

            do {
                try await conn.connect()
            } catch {
                self.addActivity(type: .error, text: "Connection failed: \(error.localizedDescription)")
            }
        }
    }

    public func disconnectFromGateway() {
        Task {
            await heartbeatMonitor?.stop()
            await connection?.disconnect()
        }
        heartbeatMonitor = nil
        connection = nil
        rpcClient = nil
        gatewayStatus = nil
    }

    public func sendMessage() {
        guard canSend else { return }
        addActivity(type: .userMessage, text: chatViewModel.chatInput.trimmingCharacters(in: .whitespacesAndNewlines))
        chatViewModel.sendMessage()
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
            chatViewModel.handleChatEvent(chatPayload)
            // Also update legacy activity list
            handleChatEventActivity(chatPayload)
        case "approval":
            if let dict = payload as? [String: Any] {
                approvalViewModel.handleApprovalEvent(dict)
            }
        case "heartbeat":
            break  // Handled by HeartbeatMonitor
        default:
            addActivity(type: .system, text: "Event: \(event)")
        }
    }

    private func handleChatEventActivity(_ payload: ChatEventPayload) {
        switch payload.state {
        case .delta:
            break // Don't add deltas to activity log
        case .final_:
            let finalText = payload.messageText ?? ""
            if !finalText.isEmpty {
                addActivity(type: .assistantMessage, text: finalText)
            }
        case .error:
            let errorMsg = payload.errorMessage ?? "Unknown error"
            addActivity(type: .error, text: "Agent error: \(errorMsg)")
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
        if activities.count > AppConstants.maxActivities {
            activities = Array(activities.prefix(AppConstants.maxActivities))
        }
    }

    // MARK: - Uptime Timer

    func startUptimeTimer() {
        stopUptimeTimer()
        uptimeTimer = Task {
            while !Task.isCancelled {
                await fetchStatus()
                if let status = gatewayStatus {
                    menuBarUptime = formatUptime(status.uptime)
                }
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    func stopUptimeTimer() {
        uptimeTimer?.cancel()
        uptimeTimer = nil
        menuBarUptime = ""
    }

    // MARK: - Helpers

    private func formatUptime(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
    }
}
