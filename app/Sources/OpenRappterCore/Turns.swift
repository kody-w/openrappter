import Foundation

/// One turn at a time. Every key press begins a new turn; the tail of an older turn (the sleep after a
/// reply, the sign-in poll) checks `isLive` before it touches the creature.
public struct Turns: Sendable, Equatable {
    public private(set) var current: Int = 0
    public init() {}

    @discardableResult
    public mutating func begin() -> Int { current += 1; return current }

    public func isLive(_ id: Int) -> Bool { id == current }
}

/// What a key press means: hold to talk, or a tap (under `tapLimit`) that keeps listening on until the next tap,
/// so someone who can only tap a key (Voice Control) can still talk.
public struct PressGate: Sendable, Equatable {
    public enum Action: Sendable, Equatable {
        case start      // key down: start listening
        case ignore     // key down while a tap left listening on: this press will end it on release
        case latch      // key up after a short tap: keep listening
        case stop       // key up: stop listening and act
    }

    public var tapLimit: TimeInterval
    public private(set) var downAt: Date?
    public private(set) var latched = false
    private var endingLatch = false

    public init(tapLimit: TimeInterval = 0.3) { self.tapLimit = tapLimit }

    /// True while the key is held or a tap left listening on. A start that finishes after a release checks this.
    public var wantsListening: Bool { latched || downAt != nil }

    public mutating func keyDown(at t: Date = Date()) -> Action {
        if latched { endingLatch = true; return .ignore }
        downAt = t
        return .start
    }

    public mutating func keyUp(at t: Date = Date()) -> Action {
        if endingLatch { endingLatch = false; latched = false; downAt = nil; return .stop }
        guard let d = downAt else { return .stop }
        downAt = nil
        if t.timeIntervalSince(d) < tapLimit - 0.0005 { latched = true; return .latch }   // half a millisecond of slack: Date math is floating point
        return .stop
    }

    /// Listening ended some other way (microphone failed, turn cancelled): forget any tap.
    public mutating func reset() { latched = false; endingLatch = false; downAt = nil }
}

/// A sign-in code read out slowly, one character at a time, so it can be written down from hearing it.
public enum SpokenCode {
    public static func spell(_ code: String) -> String {
        code.map { ch -> String in
            switch ch {
            case "-": return "dash"
            case "0": return "zero"
            case " ": return "space"
            default: return String(ch).uppercased()
            }
        }.joined(separator: ", ")
    }
}
