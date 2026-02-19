import Foundation

// MARK: - Deep Link Handler

/// Handles `openrappter://` URL scheme for deep linking.
@MainActor
public final class DeepLinkHandler {
    public enum DeepLink {
        case chat(sessionKey: String?)
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
