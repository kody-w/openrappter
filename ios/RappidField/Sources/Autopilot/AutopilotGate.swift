import Foundation

/// When autopilot may exist at all.
///
/// Two independent locks. The first is the build configuration: a Release
/// build reports `isCompiledIn == false`, the driver is never constructed, and
/// the intake paths return immediately. The second is an explicit opt-in at
/// launch — a shipped DEBUG build with no flag is just as inert.
enum AutopilotGate {
    static let activationKey = "RAPPID_AUTOPILOT"
    static let activationArgument = "-RAPPID_AUTOPILOT"
    static let activationValue = "1"
    /// A second, separate opt-in for reading *commands* from the pasteboard.
    ///
    /// It is separate because that read is what raises the system paste
    /// confirmation on iOS 16 and later: a run that nobody is watching would
    /// sit behind a modal alert forever. Publishing receipts to the pasteboard
    /// is never prompted and is therefore always on.
    static let clipboardInboxKey = "RAPPID_AUTOPILOT_CLIPBOARD"
    static let clipboardInboxArgument = "-RAPPID_AUTOPILOT_CLIPBOARD"

    static var isCompiledIn: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    /// `isCompiledIn` is a parameter so both build configurations can be
    /// exercised by tests, rather than one of them being taken on trust.
    static func isEnabled(
        environment: [String: String],
        arguments: [String],
        isCompiledIn: Bool = AutopilotGate.isCompiledIn
    ) -> Bool {
        guard isCompiledIn else { return false }
        return isSet(activationKey, activationArgument, environment: environment, arguments: arguments)
    }

    /// Whether the pasteboard should be read for commands as well as written.
    /// Requires autopilot itself to be on.
    static func isClipboardInboxEnabled(
        environment: [String: String],
        arguments: [String],
        isCompiledIn: Bool = AutopilotGate.isCompiledIn
    ) -> Bool {
        guard isEnabled(environment: environment, arguments: arguments, isCompiledIn: isCompiledIn) else {
            return false
        }
        return isSet(clipboardInboxKey, clipboardInboxArgument, environment: environment, arguments: arguments)
    }

    private static func isSet(
        _ key: String,
        _ argument: String,
        environment: [String: String],
        arguments: [String]
    ) -> Bool {
        if environment[key] == activationValue { return true }
        // `-KEY 1`, the argument-domain form simctl can pass.
        if let index = arguments.firstIndex(of: argument),
           arguments.indices.contains(index + 1),
           arguments[index + 1] == activationValue {
            return true
        }
        return false
    }
}
