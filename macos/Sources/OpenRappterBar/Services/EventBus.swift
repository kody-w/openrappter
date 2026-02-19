import Foundation

// MARK: - App Event

/// A typed event for in-process distribution.
public struct AppEvent: Sendable {
    public let name: String
    public let source: String
    public let payload: AnyCodable?
    public let timestamp: Date

    public init(name: String, source: String = "", payload: AnyCodable? = nil) {
        self.name = name
        self.source = source
        self.payload = payload
        self.timestamp = Date()
    }
}

// MARK: - Event Names

public enum AppEventName {
    public static let connectionStateChanged = "connection.stateChanged"
    public static let heartbeatReceived = "heartbeat.received"
    public static let heartbeatMissed = "heartbeat.missed"
    public static let healthChanged = "health.changed"
    public static let gatewayEvent = "gateway.event"
}

// MARK: - Event Bus

/// Actor-based event bus for distributing events to multiple subscribers.
public actor EventBus: EventBusProtocol {
    private var subscribers: [UUID: Subscriber] = [:]

    private struct Subscriber {
        let continuation: AsyncStream<AppEvent>.Continuation
        let filter: (@Sendable (AppEvent) -> Bool)?
    }

    public init() {}

    public func emit(_ event: AppEvent) {
        Log.events.debug("Emit: \(event.name)")
        for (_, subscriber) in subscribers {
            if let filter = subscriber.filter, !filter(event) {
                continue
            }
            subscriber.continuation.yield(event)
        }
    }

    public func subscribe() -> AsyncStream<AppEvent> {
        addSubscriber(filter: nil)
    }

    public func subscribe(filter: @escaping @Sendable (AppEvent) -> Bool) -> AsyncStream<AppEvent> {
        addSubscriber(filter: filter)
    }

    private func addSubscriber(filter: (@Sendable (AppEvent) -> Bool)?) -> AsyncStream<AppEvent> {
        let id = UUID()
        let (stream, continuation) = AsyncStream.makeStream(of: AppEvent.self)
        subscribers[id] = Subscriber(continuation: continuation, filter: filter)
        continuation.onTermination = { [weak self] _ in
            Task { [weak self] in
                await self?.removeSubscriber(id)
            }
        }
        return stream
    }

    private func removeSubscriber(_ id: UUID) {
        subscribers.removeValue(forKey: id)
    }
}
