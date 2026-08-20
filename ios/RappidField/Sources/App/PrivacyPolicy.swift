import Foundation

/// What this app does and does not do with a device's sensors.
///
/// There is no CoreLocation import anywhere in this target and no location
/// usage string in the Info.plist, which is the only way to promise that no
/// permission prompt can appear: an app cannot ask for what it has not
/// declared.
enum LocationPolicy {
    static let usesCoreLocation = false
    static let requestsLocationPermission = false
    static let requestsPreciseLocation = false
    static let requestsBackgroundLocation = false
    static let tracksAnyone = false

    /// Documented intent for a discovery mode that is not implemented here.
    static let futureIntent = """
    If a discovery mode is ever built, it would ask for coarse, \
    when-in-use location only, once, at the moment you turn it on — never \
    precise location, never in the background, and never for anyone else. \
    Nothing in this prototype asks for location at all.
    """

    static let plainStatement = """
    This build has no location code. No map, no nearby field, no check-ins, \
    no trails, and nothing that could follow a child around a neighbourhood.
    """
}

struct PrivacySettings: Codable, Equatable {
    /// A stated preference for a mode that does not exist yet. Turning it on
    /// changes nothing about what the app collects, and the screen says so.
    var discoveryModeRequested = false
    var hapticsEnabled = true
    var motifMotionEnabled = true

    static let `default` = PrivacySettings()
}

/// Every piece of state this app persists, listed in one place so the privacy
/// screen can show it without a code reading.
enum PersistedState: String, CaseIterable {
    case starterPath = "field.starterPath"
    case leash = "field.leash"
    case privacy = "field.privacy"
    case deviceInstallID = "field.deviceInstallID"
    case onboardingComplete = "field.onboardingComplete"

    var explanation: String {
        switch self {
        case .starterPath: return "Which starter path you chose."
        case .leash: return "Your self-steer leash setting."
        case .privacy: return "The switches on this screen."
        case .deviceInstallID: return "A random value made on first launch, used only to name this device to your own host. Not a hardware or advertising identifier."
        case .onboardingComplete: return "Whether you have finished onboarding."
        }
    }
}
