import Foundation

// MARK: - Heartbeat Health

public enum HeartbeatHealth: String, Sendable {
    case healthy
    case degraded
    case unhealthy
}

// MARK: - Heartbeat Monitor

/// Periodically pings the gateway to track latency and detect connection issues.
public actor HeartbeatMonitor: HeartbeatMonitorProtocol {
    private let rpcClient: RpcClient
    private let eventBus: EventBus
    private let interval: TimeInterval
    private let timeout: TimeInterval
    private let maxMissed: Int

    private var monitorTask: Task<Void, Never>?
    private var _latency: TimeInterval?
    private var _missedCount: Int = 0
    private var _health: HeartbeatHealth = .healthy

    public init(
        rpcClient: RpcClient,
        eventBus: EventBus,
        interval: TimeInterval = AppConstants.heartbeatInterval,
        timeout: TimeInterval = AppConstants.heartbeatTimeout,
        maxMissed: Int = AppConstants.maxMissedHeartbeats
    ) {
        self.rpcClient = rpcClient
        self.eventBus = eventBus
        self.interval = interval
        self.timeout = timeout
        self.maxMissed = maxMissed
    }

    // MARK: - Public

    public func start() {
        guard monitorTask == nil else { return }
        Log.heartbeat.info("Starting heartbeat monitor (interval: \(self.interval)s)")
        _missedCount = 0
        _health = .healthy

        monitorTask = Task { [weak self] in
            await self?.monitorLoop()
        }
    }

    public func stop() {
        monitorTask?.cancel()
        monitorTask = nil
        Log.heartbeat.info("Stopped heartbeat monitor")
    }

    public func getLatency() -> TimeInterval? {
        _latency
    }

    public func getMissedCount() -> Int {
        _missedCount
    }

    public var health: HeartbeatHealth {
        _health
    }

    // MARK: - Private

    private func monitorLoop() async {
        while !Task.isCancelled {
            await performPing()
            try? await Task.sleep(for: .seconds(interval))
        }
    }

    private func performPing() async {
        let start = Date()

        do {
            _ = try await withThrowingTaskGroup(of: PingResponse.self) { group in
                group.addTask {
                    try await self.rpcClient.ping()
                }
                group.addTask {
                    try await Task.sleep(for: .seconds(self.timeout))
                    throw GatewayConnectionError.requestTimeout
                }
                let result = try await group.next()!
                group.cancelAll()
                return result
            }

            let elapsed = Date().timeIntervalSince(start)
            _latency = elapsed
            _missedCount = 0

            let previousHealth = _health
            _health = .healthy

            if previousHealth != .healthy {
                Log.heartbeat.info("Heartbeat recovered, latency: \(elapsed * 1000, privacy: .public)ms")
                await eventBus.emit(AppEvent(
                    name: AppEventName.healthChanged,
                    source: "heartbeat",
                    payload: AnyCodable(["health": "healthy", "latencyMs": elapsed * 1000] as [String: Any])
                ))
            }

            await eventBus.emit(AppEvent(
                name: AppEventName.heartbeatReceived,
                source: "heartbeat",
                payload: AnyCodable(["latencyMs": elapsed * 1000] as [String: Any])
            ))
        } catch {
            _missedCount += 1
            _latency = nil

            let previousHealth = _health
            _health = _missedCount >= maxMissed ? .unhealthy : .degraded

            Log.heartbeat.warning("Heartbeat missed (\(self._missedCount)/\(self.maxMissed)): \(error.localizedDescription)")

            if _health != previousHealth {
                await eventBus.emit(AppEvent(
                    name: AppEventName.healthChanged,
                    source: "heartbeat",
                    payload: AnyCodable(["health": _health.rawValue, "missed": _missedCount] as [String: Any])
                ))
            }

            await eventBus.emit(AppEvent(
                name: AppEventName.heartbeatMissed,
                source: "heartbeat",
                payload: AnyCodable(["missed": _missedCount, "error": error.localizedDescription] as [String: Any])
            ))
        }
    }
}
