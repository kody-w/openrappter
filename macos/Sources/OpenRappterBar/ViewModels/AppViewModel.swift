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
    public typealias ConnectionFactory = @MainActor (_ host: String, _ port: Int) -> GatewayConnection

    private struct GatewayEndpoint: Equatable {
        let host: String
        let port: Int
    }

    private enum GatewayLifecycleOperation: Equatable {
        case start
        case stop
        case authenticationRestart(GatewayEndpoint)
    }

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

    // Fleet live data
    public let fleetViewModel = FleetViewModel()

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

    // Coalescing state for connect/shutdown so overlapping calls join a single
    // in-flight attempt instead of allocating duplicate connections or racing
    // to tear things down twice.
    private var connectTask: Task<Void, Never>?
    private var connectEndpoint: GatewayEndpoint?
    private var shutdownTask: Task<Void, Never>?
    private var gatewayLifecycleTask: Task<Void, Never>?
    private var gatewayLifecycleOperation: GatewayLifecycleOperation?
    private var connectGeneration: UInt = 0
    private var gatewayLifecycleGeneration: UInt = 0
    private var isShuttingDown = false

    // Callbacks
    public var onRpcClientReady: ((RpcClient) -> Void)?
    public var onRpcClientInvalidated: (() -> Void)?

    // Services
    var connection: GatewayConnection?
    var rpcClient: RpcClient?
    public let processManager: ProcessManager
    var heartbeatMonitor: HeartbeatMonitor?
    let eventBus: EventBus
    let sessionStore: SessionStore
    private let connectionFactory: ConnectionFactory

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
        self.connectionFactory = { host, port in
            GatewayConnection(host: host, port: port)
        }
        Task { await sessionStore.load() }
        // Start fleet live polling
        fleetViewModel.startRefreshing()
        // Start iMessage bridge if configured — reads self ID + allowed contacts
    }

    /// Detect a running gateway and connect to it automatically.
    public func detectAndConnect(host: String = AppConstants.defaultHost, port: Int = AppConstants.defaultPort) {
        guard !isShuttingDown else { return }
        gatewayLifecycleGeneration &+= 1
        let generation = gatewayLifecycleGeneration
        Task {
            if await processManager.detectRunningGateway() {
                guard generation == gatewayLifecycleGeneration else { return }
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
        sessionStore: SessionStore? = nil,
        connectionFactory: @escaping ConnectionFactory = { host, port in
            GatewayConnection(host: host, port: port)
        }
    ) {
        self.processManager = processManager
        self.eventBus = eventBus
        self.sessionStore = sessionStore ?? SessionStore()
        self.connectionFactory = connectionFactory
    }

    // MARK: - Actions

    /// Connect to the gateway.
    ///
    /// Coalesces overlapping calls — if a connect attempt is already
    /// in-flight, this joins it rather than allocating a second
    /// `GatewayConnection`/`RpcClient` pair. If a previous connection object
    /// still exists (e.g. a stale one from an earlier session), it is fully
    /// torn down first so at most one `GatewayConnection` is ever live.
    @discardableResult
    public func connectToGateway(
        host: String = AppConstants.defaultHost,
        port: Int = AppConstants.defaultPort
    ) -> Task<Void, Never> {
        guard !isShuttingDown else { return Task {} }
        let endpoint = GatewayEndpoint(host: host, port: port)
        if let connectTask, connectEndpoint == endpoint {
            return connectTask
        }

        let supersededTask = connectTask
        supersededTask?.cancel()
        connectGeneration &+= 1
        let generation = connectGeneration
        connectEndpoint = endpoint
        let task = Task { [weak self] () -> Void in
            guard let self else { return }
            await self.performConnect(
                host: host,
                port: port,
                generation: generation,
                supersededTask: supersededTask
            )
            if generation == self.connectGeneration {
                self.connectTask = nil
                self.connectEndpoint = nil
            }
        }
        connectTask = task
        return task
    }

    private func performConnect(
        host: String,
        port: Int,
        generation: UInt,
        supersededTask: Task<Void, Never>?
    ) async {
        if let oldConnection = connection {
            let oldHeartbeat = heartbeatMonitor
            connection = nil
            heartbeatMonitor = nil
            clearRpcClientReferences()
            await oldHeartbeat?.stop()
            guard generation == connectGeneration, !Task.isCancelled else {
                await oldConnection.disconnect()
                return
            }
            await oldConnection.disconnect()
            guard generation == connectGeneration, !Task.isCancelled else { return }
        }

        await supersededTask?.value
        guard generation == connectGeneration, !Task.isCancelled else { return }
        let conn = connectionFactory(host, port)
        connection = conn

        await conn.setStateHandler { [weak self, weak conn] state in
            Task { @MainActor in
                guard let self, let conn,
                      generation == self.connectGeneration,
                      self.connection === conn else { return }
                self.connectionState = state
            }
        }
        guard isCurrentConnection(conn, generation: generation) else {
            await abandonConnection(conn)
            return
        }

        await conn.setEventHandler { [weak self, weak conn] event, payload in
            Task { @MainActor in
                guard let self, let conn,
                      generation == self.connectGeneration,
                      self.connection === conn else { return }
                self.handleEvent(event: event, payload: payload)
            }
        }
        guard isCurrentConnection(conn, generation: generation) else {
            await abandonConnection(conn)
            return
        }

        do {
            try await conn.connect()
        } catch is CancellationError {
            await abandonConnection(conn)
            return
        } catch {
            let shouldReport = isCurrentConnection(conn, generation: generation)
            await abandonConnection(conn)
            guard shouldReport, generation == connectGeneration else { return }
            addActivity(type: .error, text: "Connection failed: \(error.localizedDescription)")
            return
        }

        guard isCurrentConnection(conn, generation: generation) else {
            await abandonConnection(conn)
            return
        }

        let rpc = RpcClient(connection: conn)
        let hb = HeartbeatMonitor(rpcClient: rpc, eventBus: eventBus)
        rpcClient = rpc
        heartbeatMonitor = hb
        configureChildViewModels(rpcClient: rpc)
        onRpcClientReady?(rpc)

        guard isCurrentConnection(conn, generation: generation) else {
            await abandonConnection(conn)
            return
        }

        await fetchStatus(rpcClient: rpc, connection: conn, generation: generation)
        guard isCurrentConnection(conn, generation: generation) else {
            await abandonConnection(conn)
            return
        }

        await hb.start()
        guard isCurrentConnection(conn, generation: generation) else {
            await abandonConnection(conn)
            return
        }

        sessionsViewModel.syncFromGateway()
        startUptimeTimer()
    }

    /// Stop the heartbeat monitor and disconnect the WebSocket. Safe to call
    /// even when already disconnected (captures the live instances up front
    /// so the actual stop/disconnect always targets the real objects, rather
    /// than racing the `nil`-out below).
    public func disconnectFromGateway() async {
        connectGeneration &+= 1
        let inFlightConnect = connectTask
        connectTask = nil
        connectEndpoint = nil
        inFlightConnect?.cancel()

        let hb = heartbeatMonitor
        let conn = connection
        heartbeatMonitor = nil
        connection = nil
        clearRpcClientReferences()
        gatewayStatus = nil
        connectionState = .disconnected
        await hb?.stop()
        await conn?.disconnect()
        await inFlightConnect?.value
    }

    public func sendMessage() {
        guard canSend else { return }
        addActivity(type: .userMessage, text: chatViewModel.chatInput.trimmingCharacters(in: .whitespacesAndNewlines))
        chatViewModel.sendMessage()
    }

    @discardableResult
    public func startGateway() -> Task<Void, Never> {
        guard !isShuttingDown else { return Task {} }
        if gatewayLifecycleOperation == .start, let gatewayLifecycleTask {
            return gatewayLifecycleTask
        }
        gatewayLifecycleGeneration &+= 1
        let generation = gatewayLifecycleGeneration
        gatewayLifecycleTask?.cancel()
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if generation == self.gatewayLifecycleGeneration {
                    self.gatewayLifecycleTask = nil
                    self.gatewayLifecycleOperation = nil
                }
            }
            do {
                guard generation == self.gatewayLifecycleGeneration,
                      !self.isShuttingDown,
                      !Task.isCancelled else { return }
                self.processState = .starting
                let result = try await self.processManager.start()
                guard generation == self.gatewayLifecycleGeneration,
                      !self.isShuttingDown,
                      !Task.isCancelled,
                      result != .superseded else { return }
                self.processState = self.processManager.state
                self.addActivity(type: .system, text: "Gateway started")
                self.connectToGateway()
            } catch {
                guard generation == self.gatewayLifecycleGeneration,
                      !self.isShuttingDown,
                      !Task.isCancelled else { return }
                self.processState = .stopped
                self.addActivity(type: .error, text: "Start failed: \(error.localizedDescription)")
            }
        }
        gatewayLifecycleOperation = .start
        gatewayLifecycleTask = task
        return task
    }

    @discardableResult
    public func stopGateway() -> Task<Void, Never> {
        if gatewayLifecycleOperation == .stop, let gatewayLifecycleTask {
            return gatewayLifecycleTask
        }
        gatewayLifecycleGeneration &+= 1
        let generation = gatewayLifecycleGeneration
        gatewayLifecycleTask?.cancel()
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if generation == self.gatewayLifecycleGeneration {
                    self.gatewayLifecycleTask = nil
                    self.gatewayLifecycleOperation = nil
                }
            }
            await self.disconnectFromGateway()
            guard generation == self.gatewayLifecycleGeneration else { return }
            self.processState = .stopping
            let result = await self.processManager.stop()
            guard generation == self.gatewayLifecycleGeneration,
                  !Task.isCancelled,
                  result != .superseded else { return }
            self.processState = .stopped
            self.addActivity(type: .system, text: "Gateway stopped")
        }
        gatewayLifecycleOperation = .stop
        gatewayLifecycleTask = task
        return task
    }

    /// Restart the managed gateway after authentication changes so the
    /// process reloads its token. This operation shares the same lifecycle
    /// generation/task as manual start and stop actions, so shutdown can
    /// cancel and await it and a late auth callback can never resurrect the
    /// process after teardown.
    @discardableResult
    public func restartGatewayAfterAuthentication(
        host: String = AppConstants.defaultHost,
        port: Int = AppConstants.defaultPort
    ) -> Task<Void, Never> {
        guard !isShuttingDown else { return Task {} }
        let endpoint = GatewayEndpoint(host: host, port: port)
        let operation = GatewayLifecycleOperation.authenticationRestart(endpoint)
        if gatewayLifecycleOperation == operation, let gatewayLifecycleTask {
            return gatewayLifecycleTask
        }

        gatewayLifecycleGeneration &+= 1
        let generation = gatewayLifecycleGeneration
        gatewayLifecycleTask?.cancel()
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if generation == self.gatewayLifecycleGeneration {
                    self.gatewayLifecycleTask = nil
                    self.gatewayLifecycleOperation = nil
                }
            }

            await self.disconnectFromGateway()
            guard generation == self.gatewayLifecycleGeneration,
                  !self.isShuttingDown,
                  !Task.isCancelled else { return }

            self.processState = .stopping
            let stopResult = await self.processManager.stop()
            guard generation == self.gatewayLifecycleGeneration,
                  !self.isShuttingDown,
                  !Task.isCancelled,
                  stopResult != .superseded else { return }

            self.processState = .starting
            do {
                let startResult = try await self.processManager.start()
                guard generation == self.gatewayLifecycleGeneration,
                      !self.isShuttingDown,
                      !Task.isCancelled,
                      startResult != .superseded else { return }

                self.processState = self.processManager.state
                self.addActivity(type: .system, text: "Gateway restarted after authentication")
                let connectionTask = self.connectToGateway(host: host, port: port)
                await connectionTask.value
            } catch {
                guard generation == self.gatewayLifecycleGeneration,
                      !self.isShuttingDown,
                      !Task.isCancelled else { return }
                self.processState = self.processManager.state
                self.addActivity(type: .error, text: "Restart failed: \(error.localizedDescription)")
            }
        }
        gatewayLifecycleOperation = operation
        gatewayLifecycleTask = task
        return task
    }

    /// The single, idempotent async shutdown path: stops all live background
    /// loops (heartbeat, uptime timer, fleet polling), disconnects the
    /// WebSocket, and stops only the gateway process this app itself
    /// started (an externally-detected gateway is left untouched since
    /// `ProcessManager` never took ownership of its `Process`).
    ///
    /// Invoked from menu quit (via `applicationShouldTerminate`) and app
    /// termination. Concurrent/repeated calls join the same in-flight
    /// shutdown rather than repeating the work.
    public func shutdown() async {
        if let inFlight = shutdownTask {
            await inFlight.value
            return
        }
        isShuttingDown = true
        let task = Task { [weak self] () -> Void in
            guard let self else { return }
            await self.performShutdown()
        }
        shutdownTask = task
        await task.value
        shutdownTask = nil
    }

    private func performShutdown() async {
        gatewayLifecycleGeneration &+= 1
        let inFlightLifecycle = gatewayLifecycleTask
        gatewayLifecycleTask = nil
        gatewayLifecycleOperation = nil
        inFlightLifecycle?.cancel()
        fleetViewModel.stopRefreshing()
        stopUptimeTimer()
        await disconnectFromGateway()
        await inFlightLifecycle?.value
        await processManager.stop()
        processState = processManager.state
    }

    public func fetchStatus() async {
        guard let rpc = rpcClient, let conn = connection else { return }
        let generation = connectGeneration
        await fetchStatus(rpcClient: rpc, connection: conn, generation: generation)
    }

    private func fetchStatus(
        rpcClient rpc: RpcClient,
        connection conn: GatewayConnection,
        generation: UInt
    ) async {
        do {
            let status = try await rpc.getStatus()
            guard isCurrentConnection(conn, generation: generation) else { return }
            gatewayStatus = status
        } catch {
            // Silently ignore status fetch failures
        }
    }

    private func isCurrentConnection(_ conn: GatewayConnection, generation: UInt) -> Bool {
        generation == connectGeneration &&
            connection === conn &&
            !Task.isCancelled
    }

    private func configureChildViewModels(rpcClient: RpcClient) {
        chatViewModel.configure(rpcClient: rpcClient, sessionStore: sessionStore)
        sessionsViewModel.configure(rpcClient: rpcClient, sessionStore: sessionStore)
        channelsViewModel.configure(rpcClient: rpcClient)
        cronViewModel.configure(rpcClient: rpcClient)
        approvalViewModel.configure(rpcClient: rpcClient)
    }

    private func clearRpcClientReferences() {
        let hadClient = rpcClient != nil || childViewModelsHaveRpcClient
        rpcClient = nil
        chatViewModel.clearConfiguration()
        sessionsViewModel.clearConfiguration()
        channelsViewModel.clearConfiguration()
        cronViewModel.clearConfiguration()
        approvalViewModel.clearConfiguration()
        if hadClient {
            onRpcClientInvalidated?()
        }
    }

    private func abandonConnection(_ conn: GatewayConnection) async {
        var heartbeat: HeartbeatMonitor?
        if connection === conn {
            connection = nil
            heartbeat = heartbeatMonitor
            heartbeatMonitor = nil
            clearRpcClientReferences()
            gatewayStatus = nil
            connectionState = .disconnected
            stopUptimeTimer()
        }
        await heartbeat?.stop()
        await conn.disconnect()
    }

    var childViewModelsHaveRpcClient: Bool {
        chatViewModel.isRpcClientConfigured ||
            sessionsViewModel.isRpcClientConfigured ||
            channelsViewModel.isRpcClientConfigured ||
            cronViewModel.isRpcClientConfigured ||
            approvalViewModel.isRpcClientConfigured
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
        case .aborted:
            break
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
