import Foundation

// MARK: - Deep Link Handler

/// Handles `openrappter://` URL scheme for deep linking.
@MainActor
public final class DeepLinkHandler {
    public enum DeepLink {
        case chat(sessionKey: String?)
        /// `openrappter://bones` — open the files that make up this AI.
        ///
        /// Exists so the window can be OPENED BY A MACHINE. It was previously
        /// reachable only by option-clicking the menu-bar dino or via its
        /// transient context menu, neither of which AppleScript can drive — so
        /// it could not be screenshotted or regression-tested. Something that
        /// cannot be driven cannot be verified, and that is a design defect
        /// rather than a testing inconvenience.
        case bones
        case settings(tab: String?)
        case connect(host: String, port: Int)
        case unknown(URL)
    }

    public init() {}

    /// Parse an `openrappter://` URL into a DeepLink action.
    public func parse(url: URL) -> DeepLink? {
        guard url.scheme == "openrappter" else { return nil }

        let host = url.host ?? ""
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let queryItems = components?.queryItems ?? []

        func queryValue(_ name: String) -> String? {
            queryItems.first(where: { $0.name == name })?.value
        }

        switch host {
        case "chat":
            return .chat(sessionKey: queryValue("session"))
        case "bones":
            return .bones
        case "settings":
            return .settings(tab: queryValue("tab"))
        case "connect":
            let connectHost = queryValue("host") ?? AppConstants.defaultHost
            let connectPort = Int(queryValue("port") ?? "") ?? AppConstants.defaultPort
            return .connect(host: connectHost, port: connectPort)
        default:
            return .unknown(url)
        }
    }
}
