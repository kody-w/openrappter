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

// MARK: - Gateway Connection

/// Manages a WebSocket connection to the OpenRappter gateway.
/// Handles connect handshake, request/response correlation, event dispatch, and reconnection.
public final class GatewayConnection: Sendable {
    public typealias EventHandler = @Sendable (String, Any) -> Void
    public typealias StateHandler = @Sendable (ConnectionState) -> Void
    public typealias TransportFactory = @Sendable (URL) -> WebSocketTransport

    private let url: URL
    private let transportFactory: TransportFactory

    // Nonisolated mutable state protected by locks
    private let stateLock = NSLock()
    private let _state = UnsafeMutablePointer<ConnectionState>.allocate(capacity: 1)
    private let _transport = UnsafeMutablePointer<WebSocketTransport?>.allocate(capacity: 1)
    private let _requestId = UnsafeMutablePointer<Int>.allocate(capacity: 1)
    private let _connId = UnsafeMutablePointer<String?>.allocate(capacity: 1)
    private let _reconnectAttempt = UnsafeMutablePointer<Int>.allocate(capacity: 1)
    private let _shouldReconnect = UnsafeMutablePointer<Bool>.allocate(capacity: 1)

    // Continuations for pending requests
    private let continuationsLock = NSLock()
    private let _continuations = UnsafeMutablePointer<[String: CheckedContinuation<RpcResponseFrame, Error>]>.allocate(capacity: 1)

    // Callbacks
    private let _onEvent = UnsafeMutablePointer<EventHandler?>.allocate(capacity: 1)
    private let _onStateChange = UnsafeMutablePointer<StateHandler?>.allocate(capacity: 1)

    public init(
        host: String = "127.0.0.1",
        port: Int = 18790,
        transportFactory: TransportFactory? = nil
    ) {
        self.url = URL(string: "ws://\(host):\(port)")!
        self.transportFactory = transportFactory ?? { url in URLSessionWebSocket(url: url) }

        _state.initialize(to: .disconnected)
        _transport.initialize(to: nil)
        _requestId.initialize(to: 0)
        _connId.initialize(to: nil)
        _reconnectAttempt.initialize(to: 0)
        _shouldReconnect.initialize(to: true)
        _continuations.initialize(to: [:])
        _onEvent.initialize(to: nil)
        _onStateChange.initialize(to: nil)
    }

    deinit {
        _state.deallocate()
        _transport.deallocate()
        _requestId.deallocate()
        _connId.deallocate()
        _reconnectAttempt.deallocate()
        _shouldReconnect.deallocate()
        _continuations.deallocate()
        _onEvent.deallocate()
        _onStateChange.deallocate()
    }

    // MARK: - Public State

    public var state: ConnectionState {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _state.pointee
    }

    public var connectionId: String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return _connId.pointee
    }

    public var onEvent: EventHandler? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _onEvent.pointee
        }
        set {
            stateLock.lock()
            _onEvent.pointee = newValue
            stateLock.unlock()
        }
    }

    public var onStateChange: StateHandler? {
        get {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _onStateChange.pointee
        }
        set {
            stateLock.lock()
            _onStateChange.pointee = newValue
            stateLock.unlock()
        }
    }

    // MARK: - Connect / Disconnect

    public func connect() async throws {
        setState(.connecting)

        let transport = transportFactory(url)
        stateLock.lock()
        _transport.pointee = transport
        stateLock.unlock()

        // Start receive loop
        Task { [weak self] in
            await self?.receiveLoop(transport: transport)
        }

        // Perform handshake
        setState(.handshaking)
        try await performHandshake(transport: transport)

        stateLock.lock()
        _reconnectAttempt.pointee = 0
        stateLock.unlock()

        setState(.connected)
    }

    public func disconnect() {
        stateLock.lock()
        _shouldReconnect.pointee = false
        let transport = _transport.pointee
        _transport.pointee = nil
        stateLock.unlock()

        transport?.cancel()
        cancelAllPending()
        setState(.disconnected)
    }

    // MARK: - Send Request

    public func sendRequest(method: String, params: [String: AnyCodable]? = nil, timeout: TimeInterval = 15) async throws -> RpcResponseFrame {
        let transport: WebSocketTransport? = {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _transport.pointee
        }()

        guard let transport else {
            throw GatewayConnectionError.notConnected
        }

        let id = nextRequestId()
        let frame = RpcRequestFrame(id: id, method: method, params: params)
        let data = try frame.toData()

        return try await withCheckedThrowingContinuation { continuation in
            continuationsLock.lock()
            _continuations.pointee[id] = continuation
            continuationsLock.unlock()

            Task {
                do {
                    try await transport.send(data)
                } catch {
                    self.continuationsLock.lock()
                    let cont = self._continuations.pointee.removeValue(forKey: id)
                    self.continuationsLock.unlock()
                    cont?.resume(throwing: error)
                }
            }

            // Timeout
            Task {
                try? await Task.sleep(for: .seconds(timeout))
                self.continuationsLock.lock()
                let cont = self._continuations.pointee.removeValue(forKey: id)
                self.continuationsLock.unlock()
                cont?.resume(throwing: GatewayConnectionError.requestTimeout)
            }
        }
    }

    // MARK: - Reconnection

    /// Calculate backoff delay with jitter: base * 2^attempt, capped at 30s, ±25% jitter.
    public static func backoffDelay(attempt: Int) -> TimeInterval {
        let base = 1.0
        let delay = min(base * pow(2.0, Double(attempt)), 30.0)
        let jitter = delay * 0.25 * (Double.random(in: -1...1))
        return max(0.5, delay + jitter)
    }

    func scheduleReconnect() {
        let shouldReconnect: Bool = {
            stateLock.lock()
            defer { stateLock.unlock() }
            return _shouldReconnect.pointee
        }()

        guard shouldReconnect else { return }

        let attempt: Int = {
            stateLock.lock()
            defer { stateLock.unlock() }
            let a = _reconnectAttempt.pointee
            _reconnectAttempt.pointee = a + 1
            return a
        }()

        let delay = Self.backoffDelay(attempt: attempt)
        setState(.reconnecting)

        Task {
            try? await Task.sleep(for: .seconds(delay))
            do {
                try await self.connect()
            } catch {
                self.scheduleReconnect()
            }
        }
    }

    // MARK: - Private

    private func performHandshake(transport: WebSocketTransport) async throws {
        let id = nextRequestId()
        let params: [String: AnyCodable] = [
            "client": AnyCodable([
                "id": "openrappter-bar",
                "version": "1.0.0",
                "platform": "macos",
                "mode": "menubar",
            ] as [String: Any])
        ]

        let frame = RpcRequestFrame(id: id, method: "connect", params: params)
        let data = try frame.toData()

        let response: RpcResponseFrame = try await withCheckedThrowingContinuation { continuation in
            continuationsLock.lock()
            _continuations.pointee[id] = continuation
            continuationsLock.unlock()

            Task {
                do {
                    try await transport.send(data)
                } catch {
                    self.continuationsLock.lock()
                    let cont = self._continuations.pointee.removeValue(forKey: id)
                    self.continuationsLock.unlock()
                    cont?.resume(throwing: error)
                }
            }

            // Handshake timeout
            Task {
                try? await Task.sleep(for: .seconds(10))
                self.continuationsLock.lock()
                let cont = self._continuations.pointee.removeValue(forKey: id)
                self.continuationsLock.unlock()
                cont?.resume(throwing: GatewayConnectionError.requestTimeout)
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
            stateLock.lock()
            _connId.pointee = connId
            stateLock.unlock()
        }
    }

    private func receiveLoop(transport: WebSocketTransport) async {
        while true {
            do {
                let data = try await transport.receive()
                handleIncoming(data: data)
            } catch {
                // Connection closed or failed
                let currentState = state
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
            continuationsLock.lock()
            let continuation = _continuations.pointee.removeValue(forKey: response.id)
            continuationsLock.unlock()
            continuation?.resume(returning: response)

        case .event(let event):
            let handler: EventHandler? = {
                stateLock.lock()
                defer { stateLock.unlock() }
                return _onEvent.pointee
            }()
            handler?(event.event, event.payload?.value ?? NSNull())

        case .unknown:
            break
        }
    }

    private func nextRequestId() -> String {
        stateLock.lock()
        _requestId.pointee += 1
        let id = _requestId.pointee
        stateLock.unlock()
        return "rpc-\(id)"
    }

    private func setState(_ newState: ConnectionState) {
        let handler: StateHandler? = {
            stateLock.lock()
            _state.pointee = newState
            let h = _onStateChange.pointee
            stateLock.unlock()
            return h
        }()
        handler?(newState)
    }

    private func cancelAllPending() {
        continuationsLock.lock()
        let pending = _continuations.pointee
        _continuations.pointee = [:]
        continuationsLock.unlock()

        for (_, continuation) in pending {
            continuation.resume(throwing: GatewayConnectionError.notConnected)
        }
    }
}
