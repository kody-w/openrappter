import Foundation

// MARK: - Service Protocols

public protocol GatewayConnectionProtocol: Sendable {
    func connect() async throws
    func disconnect() async
    func sendRequest(method: String, params: [String: AnyCodable]?, timeout: TimeInterval) async throws -> RpcResponseFrame
    func getState() async -> ConnectionState
    func getConnectionId() async -> String?
    func setEventHandler(_ handler: @escaping @Sendable (String, Any) -> Void) async
    func setStateHandler(_ handler: @escaping @Sendable (ConnectionState) -> Void) async
}

public protocol RpcClientProtocol: Sendable {
    func getStatus() async throws -> GatewayStatusResponse
    func getHealth() async throws -> HealthResponse
    func ping() async throws -> PingResponse
    func sendChat(message: String, sessionKey: String?) async throws -> ChatAccepted
    func listMethods() async throws -> [String]
}

@MainActor
public protocol ProcessManagerProtocol {
    var state: ProcessManager.ProcessState { get }
    var projectPath: String { get }
    func start() async throws
    func stop() async
    func checkHealth() async -> Bool
}

public protocol HeartbeatMonitorProtocol: Sendable {
    func start() async
    func stop() async
    func getLatency() async -> TimeInterval?
    func getMissedCount() async -> Int
}

public protocol EventBusProtocol: Sendable {
    func emit(_ event: AppEvent) async
    func subscribe() async -> AsyncStream<AppEvent>
    func subscribe(filter: @escaping @Sendable (AppEvent) -> Bool) async -> AsyncStream<AppEvent>
}

// MARK: - Service Container

/// Concrete service container that assembles all services.
/// Use `create()` factory method for proper async initialization.
public final class ServiceContainer: @unchecked Sendable {
    public let connection: GatewayConnection
    public let rpcClient: RpcClient
    public let heartbeat: HeartbeatMonitor
    public let eventBus: EventBus

    public init(
        host: String = AppConstants.defaultHost,
        port: Int = AppConstants.defaultPort,
        transportFactory: GatewayConnection.TransportFactory? = nil
    ) {
        let bus = EventBus()
        let conn = GatewayConnection(
            host: host,
            port: port,
            transportFactory: transportFactory
        )
        let rpc = RpcClient(connection: conn)
        let hb = HeartbeatMonitor(rpcClient: rpc, eventBus: bus)

        self.eventBus = bus
        self.connection = conn
        self.rpcClient = rpc
        self.heartbeat = hb
    }
}
