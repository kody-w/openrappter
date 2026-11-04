import Foundation
import XCTest
@testable import OpenRappterCore

final class LauncherTests: XCTestCase {
    var appRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    func script(_ text: String, at url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(text.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
    }

    func run(env: [String: String]) throws -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = [appRoot.appendingPathComponent("kernel/run.sh").path]
        task.environment = env
        task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
        try task.run(); task.waitUntilExit()
        return task.terminationStatus
    }

    func installationFixture() throws -> (home: URL, env: [String: String], destination: URL) {
        let dir = try testDirectory(self)
        let home = dir.appendingPathComponent("mind"), bin = dir.appendingPathComponent("bin")
        let source = home.appendingPathComponent("src/rapp_brainstem")
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("src/.git"), withIntermediateDirectories: true)
        try Data().write(to: source.appendingPathComponent("requirements.txt"))
        try Data("PORT=7071\n".utf8).write(to: source.appendingPathComponent(".env.example"))
        let manifest = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: appRoot.appendingPathComponent("kernel/kernel.json"))) as? [String: Any])
        let sha = try XCTUnwrap(manifest["sha"] as? String)
        let interpreter = dir.appendingPathComponent("fake-python")
        try script(#"""
        #!/bin/sh
        case "${1:-}" in */console-tool) exit 0 ;; esac
        if [ "$1" = "-m" ] && [ "$2" = "pip" ]; then
            if [ "$3" = "install" ]; then
                printf 'install\n' >> "$OPENRAPPTER_KERNEL_HOME/install-count"
                mkdir -p "$PIP_CACHE_DIR"
                printf cached > "$PIP_CACHE_DIR/download"
                [ "${FAIL_INSTALL:-0}" != 1 ] || exit 19
            fi
            exit 0
        fi
        if [ "$1" = "brainstem.py" ]; then
            [ -f "$(dirname "$0")/../.ready" ] || exit 20
            printf '%s' "$0" > "$OPENRAPPTER_KERNEL_HOME/started"
            exit 0
        fi
        exit 21
        """#, at: interpreter)
        try script(#"""
        #!/bin/sh
        if [ "$1" = "-c" ]; then
            case "$2" in
                *'["sha"]'*) printf '%s\n' "$FIXTURE_SHA" ;;
                *'["repo"]'*) printf 'fake-repo\n' ;;
                *) exit 22 ;;
            esac
        elif [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
            mkdir -p "$3/bin"
            cp "$FIXTURE_PYTHON" "$3/bin/python"
            chmod 755 "$3/bin/python"
            printf '#!%s/bin/python\n' "$3" > "$3/bin/console-tool"
            chmod 755 "$3/bin/console-tool"
        else
            exit 23
        fi
        """#, at: bin.appendingPathComponent("python3"))
        try script(#"""
        #!/bin/sh
        if [ "${3:-}" = "rev-parse" ]; then printf '%s\n' "$FIXTURE_SHA"; fi
        exit 0
        """#, at: bin.appendingPathComponent("git"))
        try script("#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$OPENRAPPTER_KERNEL_HOME/paused\"\n",
                   at: bin.appendingPathComponent("sleep"))
        let env = [
            "PATH": bin.path + ":/usr/bin:/bin", "HOME": dir.path,
            "OPENRAPPTER_KERNEL_HOME": home.path, "FIXTURE_SHA": sha,
            "FIXTURE_PYTHON": interpreter.path, "FAIL_INSTALL": "1",
        ]
        let destination = home.appendingPathComponent("env-\(sha)")
        return (home, env, destination)
    }

    func testInterruptedSetupNeverPublishesHalfBuiltEnvironment() throws {
        let (home, initialEnv, destination) = try installationFixture()
        var env = initialEnv
        XCTAssertEqual(try run(env: env), 19)
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent("started").path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: home.appendingPathComponent("environments").path), [])
        env["FAIL_INSTALL"] = "0"
        XCTAssertEqual(try run(env: env), 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: destination.appendingPathComponent(".ready").path))
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent("started"), encoding: .utf8),
                       destination.appendingPathComponent("bin/python").path)
        let console = Process()
        let tool = destination.appendingPathComponent("bin/console-tool")
        let shebang = try String(contentsOf: tool, encoding: .utf8).trimmingCharacters(in: .newlines)
        let interpreterPath = String(shebang.dropFirst(2))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: interpreterPath), "Publishing must preserve command interpreters")
        // The fake interpreter is itself a shell script; macOS does not nest shebang interpreters.
        console.executableURL = URL(fileURLWithPath: interpreterPath)
        console.arguments = [tool.path]
        try console.run(); console.waitUntilExit()
        XCTAssertEqual(console.terminationStatus, 0, "Publishing must preserve installed command shebangs")
        let count = try Data(contentsOf: home.appendingPathComponent("install-count"))
        XCTAssertEqual(try run(env: env), 0)
        XCTAssertEqual(try Data(contentsOf: home.appendingPathComponent("install-count")), count, "Do not repeat setup at every login")
    }

    func testFailedDependencyInstallBacksOffAndKeepsCacheAcrossRetries() throws {
        let (home, env, destination) = try installationFixture()
        for _ in 0..<2 { XCTAssertEqual(try run(env: env), 19) }
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent("paused"), encoding: .utf8), "60\n60\n")
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent("pip-cache/download"), encoding: .utf8), "cached")
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: home.appendingPathComponent("environments").path), [])
        XCTAssertEqual(try String(contentsOf: home.appendingPathComponent("install-count"), encoding: .utf8), "install\ninstall\n")
    }

    func testMissingToolsPausesBeforeExitingInsteadOfRepeatingDialogs() throws {
        let dir = try testDirectory(self)
        let bin = dir.appendingPathComponent("bin")
        try script("#!/bin/sh\nexec /usr/bin/dirname \"$@\"\n", at: bin.appendingPathComponent("dirname"))
        try script("#!/bin/sh\nprintf '%s' \"$1\" > \"$HOME/paused\"\n", at: bin.appendingPathComponent("sleep"))
        XCTAssertEqual(try run(env: ["PATH": bin.path, "HOME": dir.path]), 78)
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("paused"), encoding: .utf8), "60")
    }
}
