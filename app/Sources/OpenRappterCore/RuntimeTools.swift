import Foundation

public enum RuntimeTools {
    public static func available() -> Bool {
        available(path: "/opt/homebrew/bin:/usr/local/bin:" + (ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"),
                  executable: FileManager.default.isExecutableFile,
                  run: run)
    }

    static func available(path: String, executable: (String) -> Bool, run: (String, [String]) -> Int32) -> Bool {
        func locate(_ name: String) -> String? {
            path.split(separator: ":").map { "\($0)/\(name)" }.first(where: executable)
        }
        guard let python = locate("python3"), let git = locate("git") else { return false }
        // Do not execute Apple's placeholders: that would open a repeated tools-install dialog.
        if (python == "/usr/bin/python3" || git == "/usr/bin/git"),
           run("/usr/bin/xcode-select", ["-p"]) != 0 { return false }
        return run(python, ["--version"]) == 0 && run(git, ["--version"]) == 0
    }

    public static func run(_ executable: String, _ arguments: [String]) -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable); task.arguments = arguments
        task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
        do { try task.run(); task.waitUntilExit(); return task.terminationStatus }
        catch { return -1 }
    }
}
