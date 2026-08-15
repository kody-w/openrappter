import Foundation
#if canImport(Darwin)
import Darwin
#endif

public struct DesktopGatewayEndpoint: Codable, Equatable {
    public let schema: String
    public let host: String
    public let port: Int
    public let token: String
    public let pid: Int32
    public let updatedAt: String
}

/// Discovers the private endpoint published by OpenRappter Electron.
public enum DesktopGatewayDiscovery {
    public static var endpointPath: String {
        ProcessInfo.processInfo.environment["OPENRAPPTER_DESKTOP_ENDPOINT"]
            ?? NSHomeDirectory() + "/.openrappter/desktop-gateway.json"
    }

    public static func current() -> DesktopGatewayEndpoint? {
        let url = URL(fileURLWithPath: endpointPath)
        guard
            let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
            let permissions = attributes[.posixPermissions] as? NSNumber,
            permissions.intValue & 0o077 == 0,
            let data = try? Data(contentsOf: url),
            data.count <= 16 * 1024,
            let endpoint = try? JSONDecoder().decode(DesktopGatewayEndpoint.self, from: data),
            endpoint.schema == "openrappter-desktop-endpoint/1.0",
            endpoint.host == "127.0.0.1",
            (1...65535).contains(endpoint.port),
            endpoint.token.range(
                of: #"^[0-9a-f]{64}$"#,
                options: .regularExpression
            ) != nil,
            processIsAlive(endpoint.pid)
        else {
            return nil
        }
        return endpoint
    }

    private static func processIsAlive(_ pid: Int32) -> Bool {
        #if canImport(Darwin)
        return kill(pid, 0) == 0 || errno == EPERM
        #else
        return pid > 0
        #endif
    }
}
