import Foundation

// MARK: - WebSocket Transport Protocol (for testability)

public protocol WebSocketTransport: Sendable {
    func send(_ data: Data) async throws
    func receive() async throws -> Data
    func cancel()
}

// MARK: - URLSession WebSocket Transport

public final class URLSessionWebSocket: WebSocketTransport, Sendable {
    private let task: URLSessionWebSocketTask

    public init(url: URL, session: URLSession = .shared) {
        self.task = session.webSocketTask(with: url)
        self.task.resume()
    }

    public func send(_ data: Data) async throws {
        try await task.send(.data(data))
    }

    public func receive() async throws -> Data {
        let message = try await task.receive()
        switch message {
        case .data(let data):
            return data
        case .string(let text):
            return Data(text.utf8)
        @unknown default:
            throw GatewayConnectionError.unexpectedMessage
        }
    }

    public func cancel() {
        task.cancel(with: .goingAway, reason: nil)
    }
}

// MARK: - Connection State

public enum ConnectionState: String, Sendable {
    case disconnected
    case connecting
    case handshaking
    case connected
    case reconnecting
}

// MARK: - Gateway Connection Errors

public enum GatewayConnectionError: Error, LocalizedError {
    case handshakeFailed(String)
    case notConnected
    case requestTimeout
    case unexpectedMessage
    case serverError(code: Int, message: String)

    public var errorDescription: String? {
        switch self {
        case .handshakeFailed(let msg): return "Handshake failed: \(msg)"
        case .notConnected: return "Not connected to gateway"
        case .requestTimeout: return "Request timed out"
        case .unexpectedMessage: return "Unexpected message format"
        case .serverError(let code, let msg): return "Server error \(code): \(msg)"
        }
    }
}

// MARK: - Gateway Connection (Actor)

/// Manages a WebSocket connection to the OpenRappter gateway.
/// Uses Swift actor isolation for thread safety — no locks or unsafe pointers needed.
public actor GatewayConnection: GatewayConnectionProtocol {
    public typealias EventHandler = @Sendable (String, Any) -> Void
    public typealias StateHandler = @Sendable (ConnectionState) -> Void
    public typealias TransportFactory = @Sendable (URL) -> WebSocketTransport

    private let url: URL
    private let transportFactory: TransportFactory

    // Actor-isolated mutable state — safe by construction
    private var _state: ConnectionState = .disconnected
    private var transport: WebSocketTransport?
    private var nextRequestId: Int = 0
    private var _connectionId: String?
    private var reconnectAttempt: Int = 0
    private var shouldReconnect: Bool = true
    private var pendingRequests: [String: CheckedContinuation<RpcResponseFrame, Error>] = [:]
    private var receiveTask: Task<Void, Never>?

    // Callbacks
    private var _onEvent: EventHandler?
    private var _onStateChange: StateHandler?

    public init(
        host: String = AppConstants.defaultHost,
        port: Int = AppConstants.defaultPort,
        transportFactory: TransportFactory? = nil
    ) {
        self.url = URL(string: "ws://\(host):\(port)")!
        self.transportFactory = transportFactory ?? { url in URLSessionWebSocket(url: url) }
    }

    deinit {
        receiveTask?.cancel()
    }

    // MARK: - Public State

    public func getState() -> ConnectionState {
        _state
    }

    public func getConnectionId() -> String? {
        _connectionId
    }

    /// Access state directly (within actor isolation).
    public var state: ConnectionState {
        _state
    }

    /// Access connectionId directly (within actor isolation).
    public var connectionId: String? {
        _connectionId
    }

    // MARK: - Callbacks

    public func setEventHandler(_ handler: @escaping @Sendable (String, Any) -> Void) {
        _onEvent = handler
    }

    public func setStateHandler(_ handler: @escaping @Sendable (ConnectionState) -> Void) {
        _onStateChange = handler
    }

    // MARK: - Connect / Disconnect

    public func connect() async throws {
        setState(.connecting)

        let newTransport = transportFactory(url)
        self.transport = newTransport

        // Start receive loop
        receiveTask?.cancel()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(transport: newTransport)
        }

        // Perform handshake
        setState(.handshaking)
        try await performHandshake(transport: newTransport)

        reconnectAttempt = 0
        setState(.connected)
        Log.connection.info("Connected to gateway, connId: \(self._connectionId ?? "unknown")")
    }

    public func disconnect() {
        shouldReconnect = false
        let currentTransport = transport
        transport = nil
        receiveTask?.cancel()
        receiveTask = nil

        currentTransport?.cancel()
        cancelAllPending()
        setState(.disconnected)
        Log.connection.info("Disconnected from gateway")
    }

    // MARK: - Send Request

    public func sendRequest(
        method: String,
        params: [String: AnyCodable]? = nil,
        timeout: TimeInterval = AppConstants.requestTimeout
    ) async throws -> RpcResponseFrame {
        guard let currentTransport = transport else {
            throw GatewayConnectionError.notConnected
        }

        let id = generateRequestId()
        let frame = RpcRequestFrame(id: id, method: method, params: params)
        let data = try frame.toData()

        Log.rpc.debug("Request \(id): \(method)")

        return try await withCheckedThrowingContinuation { continuation in
            pendingRequests[id] = continuation

            Task { [weak self] in
                do {
                    try await currentTransport.send(data)
                } catch {
                    await self?.removePendingAndResume(id: id, with: .failure(error))
                }
            }

            // Timeout
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                await self?.removePendingAndResume(id: id, with: .failure(GatewayConnectionError.requestTimeout))
            }
        }
    }

    // MARK: - Reconnection

    /// Calculate backoff delay with jitter: base * 2^attempt, capped at 30s, +/-25% jitter.
    public static func backoffDelay(attempt: Int) -> TimeInterval {
        let base = AppConstants.reconnectBaseDelay
        let delay = min(base * pow(2.0, Double(attempt)), AppConstants.reconnectMaxDelay)
        let jitter = delay * AppConstants.reconnectJitterFactor * Double.random(in: -1...1)
        return max(0.5, delay + jitter)
    }

    func scheduleReconnect() {
        guard shouldReconnect else { return }

        let attempt = reconnectAttempt
        reconnectAttempt += 1

        let delay = Self.backoffDelay(attempt: attempt)
        setState(.reconnecting)
        Log.connection.info("Reconnecting in \(String(format: "%.1f", delay))s (attempt \(attempt + 1))")

        Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            do {
                try await self?.connect()
            } catch {
                await self?.scheduleReconnect()
            }
        }
    }

    // MARK: - Private

    private func performHandshake(transport: WebSocketTransport) async throws {
        let id = generateRequestId()
        let params: [String: AnyCodable] = [
            "client": AnyCodable([
                "id": AppConstants.clientId,
                "version": AppConstants.version,
                "platform": AppConstants.platform,
                "mode": AppConstants.mode,
            ] as [String: Any])
        ]

        let frame = RpcRequestFrame(id: id, method: "connect", params: params)
        let data = try frame.toData()

        let response: RpcResponseFrame = try await withCheckedThrowingContinuation { continuation in
            pendingRequests[id] = continuation

            Task {
                do {
                    try await transport.send(data)
                } catch {
                    self.removePendingAndResume(id: id, with: .failure(error))
                }
            }

            // Handshake timeout
            Task {
                try? await Task.sleep(for: .seconds(AppConstants.handshakeTimeout))
                self.removePendingAndResume(id: id, with: .failure(GatewayConnectionError.requestTimeout))
            }
        }

        guard response.ok else {
            let msg = response.error?.message ?? "Unknown handshake error"
            throw GatewayConnectionError.handshakeFailed(msg)
        }

        // Extract connId from hello-ok payload
        if let payloadDict = response.payload?.value as? [String: Any],
           let server = payloadDict["server"] as? [String: Any],
           let connId = server["connId"] as? String {
            _connectionId = connId
        }
    }

    private func receiveLoop(transport: WebSocketTransport) async {
        while !Task.isCancelled {
            do {
                let data = try await transport.receive()
                handleIncoming(data: data)
            } catch {
                if Task.isCancelled { return }
                // Connection closed or failed
                let currentState = _state
                if currentState != .disconnected {
                    cancelAllPending()
                    scheduleReconnect()
                }
                return
            }
        }
    }

    private func handleIncoming(data: Data) {
        guard let frame = try? IncomingFrame.parse(data: data) else { return }

        switch frame {
        case .response(let response):
            if let continuation = pendingRequests.removeValue(forKey: response.id) {
                continuation.resume(returning: response)
            }

        case .event(let event):
            _onEvent?(event.event, event.payload?.value ?? NSNull())

        case .unknown:
            break
        }
    }

    private func generateRequestId() -> String {
        nextRequestId += 1
        return "rpc-\(nextRequestId)"
    }

    private func setState(_ newState: ConnectionState) {
        _state = newState
        _onStateChange?(newState)
    }

    private func cancelAllPending() {
        let pending = pendingRequests
        pendingRequests = [:]
        for (_, continuation) in pending {
            continuation.resume(throwing: GatewayConnectionError.notConnected)
        }
    }

    /// Remove a pending request and resume its continuation if it still exists.
    private func removePendingAndResume(id: String, with result: Result<RpcResponseFrame, Error>) {
        guard let continuation = pendingRequests.removeValue(forKey: id) else { return }
        switch result {
        case .success(let response):
            continuation.resume(returning: response)
        case .failure(let error):
            continuation.resume(throwing: error)
        }
    }
}
