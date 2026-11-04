import Foundation
import Darwin

public enum LoginItemResult: Equatable, Sendable { case installed, unchanged, moveRequired, skipped }

public struct LoginItem {
    public static let label = Doctor.loginItemLabel
    public var home: URL
    public var bundle: URL
    public var executable: String
    public var env: [String: String]
    public var command: ([String]) -> Int32
    public var startupPreference: StartupPreference { StartupPreference(home: home) }

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser,
                bundle: URL = Bundle.main.bundleURL, executable: String = Bundle.main.executablePath ?? "",
                env: [String: String] = ProcessInfo.processInfo.environment,
                command: @escaping ([String]) -> Int32 = MindRunner.launchctl) {
        self.home = home; self.bundle = bundle; self.executable = executable
        self.env = env; self.command = command
    }

    public static func isStable(_ bundle: URL, home: URL) -> Bool {
        let path = bundle.resolvingSymlinksInPath().standardizedFileURL.path
        guard path.hasSuffix(".app"), !path.contains("/Volumes/"), !path.contains("AppTranslocation") else { return false }
        return path.hasPrefix("/Applications/") ||
            path.hasPrefix(home.resolvingSymlinksInPath().appendingPathComponent("Applications").path + "/")
    }

    func installationBlock(allowStartup: Bool) -> LoginItemResult? {
        if env["OPENRAPPTER_NO_LOGIN_ITEM"] != nil || (!allowStartup && startupPreference.isStopped) { return .skipped }
        if !Self.isStable(bundle, home: home) || !executable.hasPrefix(bundle.path + "/Contents/MacOS/") { return .moveRequired }
        return nil
    }

    @discardableResult
    public func install(allowStartup: Bool = false) throws -> LoginItemResult {
        if let result = installationBlock(allowStartup: allowStartup) { return result }
        let url = Doctor.loginItemURL(home: home)
        let logDir = home.appendingPathComponent(".openrappter")
        try FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let want: [String: Any] = [
            "Label": Self.label, "ProgramArguments": [executable], "RunAtLoad": true, "KeepAlive": true,
            "ThrottleInterval": 5, "ProcessType": "Interactive",
            "StandardErrorPath": logDir.appendingPathComponent("app.stderr.log").path,
        ]
        let have = NSDictionary(contentsOf: url)
        let unchanged = have?.isEqual(to: want) == true
        if !unchanged {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try PropertyListSerialization.data(fromPropertyList: want, format: .xml, options: 0).write(to: url, options: .atomic)
        }
        // Updating our own saved setting must not terminate the job that is writing it.
        let domain = "gui/\(getuid())"
        let job = "\(domain)/\(Self.label)"
        if env["XPC_SERVICE_NAME"] == Self.label {
            if allowStartup {
                let status = command(["enable", job])
                guard status == 0 else { throw MindError.serviceFailed(status) }
            }
            return unchanged ? .unchanged : .installed
        }
        guard command(["enable", job]) == 0 else { throw MindError.serviceFailed(-1) }
        let loaded = command(["print", job]) == 0
        if loaded { return unchanged ? .unchanged : .installed }
        let status = command(["bootstrap", domain, url.path])
        guard status == 0 else { throw MindError.serviceFailed(status) }
        return .installed
    }

    /// Delete the saved setting before stopping the job (which may be this very app).
    public func remove(stopRunning: Bool = true) throws {
        let url = Doctor.loginItemURL(home: home)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        let job = "gui/\(getuid())/\(Self.label)"
        let status = command(["disable", job])
        guard status == 0 else { throw MindError.serviceFailed(status) }
        if stopRunning { _ = command(["bootout", job]) }
    }

    public func quit() throws {
        let job = "gui/\(getuid())/\(Self.label)"
        guard command(["print", job]) == 0 else { return }
        // Keep the saved setting for the next Mac sign-in, but prevent an immediate relaunch.
        let status = command(["bootout", job])
        guard status == 0 else { throw MindError.serviceFailed(status) }
    }
}
