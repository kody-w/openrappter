import Foundation
import Darwin

public enum LoginItemResult: Equatable { case installed, unchanged, moveRequired, skipped }

public struct LoginItem {
    public static let label = Doctor.loginItemLabel
    public var home: URL
    public var bundle: URL
    public var executable: String
    public var env: [String: String]
    public var command: ([String]) -> Int32

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

    @discardableResult
    public func install() throws -> LoginItemResult {
        guard env["OPENRAPPTER_NO_LOGIN_ITEM"] == nil else { return .skipped }
        guard Self.isStable(bundle, home: home),
              executable.hasPrefix(bundle.path + "/Contents/MacOS/") else { return .moveRequired }
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
        if env["XPC_SERVICE_NAME"] == Self.label { return unchanged ? .unchanged : .installed }
        let domain = "gui/\(getuid())"
        let job = "\(domain)/\(Self.label)"
        guard command(["enable", job]) == 0 else { throw MindError.serviceFailed(-1) }
        let loaded = command(["print", job]) == 0
        if unchanged && loaded { return .unchanged }
        if loaded { _ = command(["bootout", job]) }
        let status = command(["bootstrap", domain, url.path])
        guard status == 0 else { throw MindError.serviceFailed(status) }
        return .installed
    }

    /// Delete the saved setting before stopping the job (which may be this very app).
    public func remove() throws {
        let url = Doctor.loginItemURL(home: home)
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        let job = "gui/\(getuid())/\(Self.label)"
        _ = command(["disable", job])
        _ = command(["bootout", job])
    }
}
