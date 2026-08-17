import Foundation

/// Which brain answers a chat turn.
///
/// The brainstem runs as its own process speaking HTTP, and the OpenRappter
/// runtime answers over the gateway. Both return the same `rapp-runtime-parity/1.0`
/// §2.4 envelope, so the Bar renders either reply identically — the only thing
/// that differs is which one was asked.
///
/// That sameness is exactly why the choice has to be explicit and remembered.
/// The two brains know different things, and an answer from the wrong one does
/// not look wrong.
public enum ChatTarget: String, CaseIterable, Codable, Sendable {
    case openrappter
    case brainstem

    /// What the operator sees in the picker.
    public var label: String {
        switch self {
        case .openrappter: return "🦖 OpenRappter"
        case .brainstem: return "🧠 Brainstem"
        }
    }

    /// Where the choice is remembered between launches.
    public static let defaultsKey = "openrappter.chat.target"

    /// Read a stored choice, falling back to the local runtime.
    ///
    /// An unrecognised stored value is treated as absent rather than as an
    /// error: a defaults file edited by hand should not stop the Bar from
    /// chatting, and the local runtime is the safe brain to fall back to.
    public static func restored(from defaults: UserDefaults = .standard) -> ChatTarget {
        guard let raw = defaults.string(forKey: defaultsKey) else { return .openrappter }
        return ChatTarget(rawValue: raw) ?? .openrappter
    }

    /// Remember this choice for the next launch.
    public func remember(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Self.defaultsKey)
    }
}
