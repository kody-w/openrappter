import Foundation

// MARK: - WebSocket Transport Protocol (for testability)

public protocol WebSocketTransport: AnyObject, Sendable {
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
    public typealias ReconnectDelayProvider = @Sendable (Int) -> TimeInterval
    public typealias ReconnectSleeper = @Sendable (TimeInterval) async throws -> Void
    public typealias PostHandshakeHook = @Sendable () async -> Void

    private let url: URL
    private let transportFactory: TransportFactory
    private let reconnectDelayProvider: ReconnectDelayProvider
    private let reconnectSleeper: ReconnectSleeper
    private let postHandshakeHook: PostHandshakeHook

    // Actor-isolated mutable state — safe by construction
    private var _state: ConnectionState = .disconnected
    private var transport: WebSocketTransport?
    private var nextRequestId: Int = 0
    private var _connectionId: String?
    private var reconnectAttempt: Int = 0
    private var shouldReconnect: Bool = true
    private var pendingRequests: [String: CheckedContinuation<RpcResponseFrame, Error>] = [:]
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    /// Bumped for every explicit connect/disconnect lifecycle. Scheduled
    /// reconnect attempts retain the same generation so an explicit
    /// disconnect permanently invalidates the whole retry chain.
    private var connectGeneration: UInt = 0
    /// Identifies the currently-owned transport within a lifecycle generation.
    /// This prevents a late failure from an older receive loop from scheduling
    /// retries for (or tearing down) a newer transport.
    private var transportGeneration: UInt = 0

    // Callbacks
    private var _onEvent: EventHandler?
    private var _onStateChange: StateHandler?

    public init(
        host: String = AppConstants.defaultHost,
        port: Int = AppConstants.defaultPort,
        transportFactory: TransportFactory? = nil,
        reconnectDelayProvider: @escaping ReconnectDelayProvider = {
            GatewayConnection.backoffDelay(attempt: $0)
        },
        reconnectSleeper: @escaping ReconnectSleeper = {
            try await Task.sleep(for: .seconds($0))
        },
        postHandshakeHook: @escaping PostHandshakeHook = {}
    ) {
        self.url = URL(string: "ws://\(host):\(port)")!
        self.transportFactory = transportFactory ?? { url in URLSessionWebSocket(url: url) }
        self.reconnectDelayProvider = reconnectDelayProvider
        self.reconnectSleeper = reconnectSleeper
        self.postHandshakeHook = postHandshakeHook
    }

    deinit {
        receiveTask?.cancel()
        reconnectTask?.cancel()
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

    /// Establish a connection and complete the handshake.
    ///
    /// Repeated or overlapping explicit calls supersede the previous
    /// lifecycle. A scheduled reconnect uses `connectAttempt` directly so it
    /// keeps the retry generation and does not cancel its own task.
    public func connect() async throws {
        connectGeneration &+= 1
        let generation = connectGeneration
        shouldReconnect = true
        reconnectAttempt = 0
        cancelReconnectTask()
        try await connectAttempt(generation: generation)
    }

    private func connectAttempt(generation: UInt) async throws {
        guard generation == connectGeneration, shouldReconnect else {
            throw CancellationError()
        }

        teardownTransport()

        setState(.connecting)

        let newTransport = transportFactory(url)
        self.transport = newTransport
        transportGeneration &+= 1
        let attemptGeneration = transportGeneration

        // Start receive loop
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(
                transport: newTransport,
                connectGeneration: generation,
                transportGeneration: attemptGeneration
            )
        }

        // Perform handshake
        setState(.handshaking)
        do {
            try await performHandshake(transport: newTransport)
            await postHandshakeHook()
        } catch {
            // Only clean up if a newer connect()/disconnect() hasn't already
            // superseded this attempt — otherwise we'd tear down state that
            // belongs to that newer, still-active attempt.
            if generation == connectGeneration,
               attemptGeneration == transportGeneration {
                teardownTransport()
                setState(.disconnected)
            }
            throw error
        }

        guard generation == connectGeneration,
              attemptGeneration == transportGeneration,
              shouldReconnect,
              transport === newTransport,
              receiveTask != nil else {
            // Superseded mid-handshake by a newer connect()/disconnect() call.
            // A terminal receive can also invalidate this exact transport
            // immediately after hello; never publish connected for a socket
            // the receive loop has already torn down.
            throw CancellationError()
        }

        reconnectAttempt = 0
        setState(.connected)
        Log.connection.info("Connected to gateway, connId: \(self._connectionId ?? "unknown")")
    }

    public func disconnect() {
        shouldReconnect = false
        connectGeneration &+= 1
        cancelReconnectTask()
        teardownTransport()
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
        scheduleReconnect(generation: connectGeneration)
    }

    private func scheduleReconnect(generation: UInt) {
        guard shouldReconnect,
              generation == connectGeneration,
              reconnectTask == nil else { return }
        let attempt = reconnectAttempt
        reconnectAttempt += 1

        let delay = reconnectDelayProvider(attempt)
        setState(.reconnecting)
        Log.connection.info("Reconnecting in \(String(format: "%.1f", delay))s (attempt \(attempt + 1))")

        let sleeper = reconnectSleeper
        reconnectTask = Task { [weak self] in
            do {
                try await sleeper(delay)
            } catch {
                return
            }
            guard let self, !Task.isCancelled else { return }
            await self.runScheduledReconnect(generation: generation)
        }
    }

    private func runScheduledReconnect(generation: UInt) async {
        guard generation == connectGeneration, shouldReconnect else { return }

        // Detach ownership before connecting. `connectAttempt` tears down the
        // previous transport but must not cancel the Task currently executing
        // it; a failed attempt can then schedule the next backoff normally.
        reconnectTask = nil
        do {
            try await connectAttempt(generation: generation)
        } catch {
            guard generation == connectGeneration, shouldReconnect else { return }
            scheduleReconnect(generation: generation)
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

    private func receiveLoop(
        transport: WebSocketTransport,
        connectGeneration generation: UInt,
        transportGeneration attemptGeneration: UInt
    ) async {
        while !Task.isCancelled {
            do {
                let data = try await transport.receive()
                guard generation == connectGeneration,
                      attemptGeneration == transportGeneration else { return }
                handleIncoming(data: data)
            } catch {
                if Task.isCancelled { return }
                guard generation == connectGeneration,
                      attemptGeneration == transportGeneration,
                      self.transport === transport,
                      shouldReconnect else { return }

                // Invalidate this transport before the suspended handshake can
                // resume and publish `.connected`. This also fences late
                // receive failures from touching a replacement transport.
                let currentState = _state
                if currentState != .disconnected {
                    teardownTransport()
                    scheduleReconnect(generation: generation)
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

    /// Cancel and release the current transport/receive loop and fail pending
    /// requests. Reconnect ownership is managed separately: a scheduled task
    /// must detach before entering `connectAttempt`, while explicit lifecycle
    /// calls cancel it through `cancelReconnectTask()`.
    private func teardownTransport() {
        transportGeneration &+= 1
        let currentTransport = transport
        transport = nil
        receiveTask?.cancel()
        receiveTask = nil

        currentTransport?.cancel()
        _connectionId = nil
        cancelAllPending()
    }

    private func cancelReconnectTask() {
        reconnectTask?.cancel()
        reconnectTask = nil
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
