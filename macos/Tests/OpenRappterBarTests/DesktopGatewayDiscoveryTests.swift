import Foundation
@testable import OpenRappterBarLib

func runDesktopGatewayDiscoveryTests() throws {
    suite("Desktop gateway discovery") {
        test("accepts a private live Electron endpoint") {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            defer { try? FileManager.default.removeItem(at: directory) }
            let file = directory.appendingPathComponent("desktop-gateway.json")
            let endpoint = DesktopGatewayEndpoint(
                schema: "openrappter-desktop-endpoint/1.0",
                host: "127.0.0.1",
                port: 18841,
                token: String(repeating: "a", count: 64),
                pid: ProcessInfo.processInfo.processIdentifier,
                ownerPid: ProcessInfo.processInfo.processIdentifier,
                updatedAt: ISO8601DateFormatter().string(from: Date())
            )
            let data = try JSONEncoder().encode(endpoint)
            FileManager.default.createFile(
                atPath: file.path,
                contents: data,
                attributes: [.posixPermissions: 0o600]
            )
            setenv("OPENRAPPTER_DESKTOP_ENDPOINT", file.path, 1)
            defer { unsetenv("OPENRAPPTER_DESKTOP_ENDPOINT") }

            let found = DesktopGatewayDiscovery.current()
            try expectEqual(found?.port, 18841)
            try expectEqual(found?.token, String(repeating: "a", count: 64))
        }

        test("rejects a world-readable endpoint") {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
            defer { try? FileManager.default.removeItem(at: directory) }
            let file = directory.appendingPathComponent("desktop-gateway.json")
            try Data("""
            {"schema":"openrappter-desktop-endpoint/1.0","host":"127.0.0.1","port":18841,"token":"\(String(repeating: "a", count: 64))","pid":\(ProcessInfo.processInfo.processIdentifier),"updatedAt":"now"}
            """.utf8).write(to: file)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o644],
                ofItemAtPath: file.path
            )
            setenv("OPENRAPPTER_DESKTOP_ENDPOINT", file.path, 1)
            defer { unsetenv("OPENRAPPTER_DESKTOP_ENDPOINT") }

            try expectNil(DesktopGatewayDiscovery.current())
        }
    }
}
