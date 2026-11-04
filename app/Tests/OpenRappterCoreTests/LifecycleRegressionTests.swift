import Foundation
import XCTest
@testable import OpenRappterCore

func testDirectory(_ test: XCTestCase) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("OpenRappter-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    test.addTeardownBlock { try FileManager.default.removeItem(at: url) }
    return url
}

final class MindStartupTests: XCTestCase {
    func runner(_ dir: URL) -> MindRunner {
        var runner = MindRunner(kernelDir: dir.appendingPathComponent("bundle"), kernelHome: dir.appendingPathComponent("mind"), env: [:])
        runner.serviceURL = dir.appendingPathComponent("com.openrappter.kernel.plist")
        return runner
    }

    func testExistingServiceWaitsWithoutReinstalling() throws {
        let dir = try testDirectory(self)
        var runner = runner(dir)
        let saved = Data("Already starting".utf8)
        try saved.write(to: runner.launchAgentURL)
        runner.command = { args in XCTAssertEqual(args.first, "print", "An existing service must not be changed"); return 0 }
        runner.toolsReady = { XCTFail("Do not probe or reinstall while starting"); return false }
        try runner.prepareService()
        XCTAssertEqual(try Data(contentsOf: runner.launchAgentURL), saved)
        XCTAssertFalse(FileManager.default.fileExists(atPath: runner.kernelHome.path))
    }

    func testLoadedServiceIsNotReinstalled() throws {
        let dir = try testDirectory(self)
        var runner = runner(dir)
        var calls: [[String]] = []
        runner.command = { calls.append($0); return 0 }
        runner.toolsReady = { XCTFail("A loaded job is already preparing its mind"); return false }
        try runner.prepareService()
        XCTAssertEqual(calls.count, 1)
        XCTAssertEqual(calls.first?.first, "print")
        XCTAssertFalse(runner.serviceInstalled)
    }

    func testExistingUnloadedServiceIsLoadedWithoutReplacingFiles() throws {
        let dir = try testDirectory(self)
        var runner = runner(dir)
        let saved = Data("Already installed".utf8)
        try saved.write(to: runner.launchAgentURL)
        var calls: [[String]] = []
        runner.command = { calls.append($0); return $0.first == "print" ? 1 : 0 }
        runner.toolsReady = { XCTFail("Loading the saved job is not a new setup"); return false }
        try runner.prepareService()
        XCTAssertEqual(calls.map { $0[0] }, ["print", "bootstrap"])
        XCTAssertEqual(try Data(contentsOf: runner.launchAgentURL), saved)
    }

    func testServiceFailureNeverReportsSuccess() throws {
        let dir = try testDirectory(self)
        var runner = runner(dir)
        try FileManager.default.createDirectory(at: runner.kernelDir, withIntermediateDirectories: true)
        for file in ["kernel.json", "run.sh"] { try Data("fixture".utf8).write(to: runner.kernelDir.appendingPathComponent(file)) }
        var calls: [[String]] = []
        runner.toolsReady = { true }
        runner.command = { calls.append($0); return $0.first == "bootstrap" ? 9 : 0 }
        XCTAssertThrowsError(try runner.installService()) { error in
            XCTAssertEqual(error as? MindError, .serviceFailed(9))
        }
        XCTAssertEqual(calls.map { $0[0] }, ["bootout", "bootstrap"])
    }

    func testMissingToolsNeverInstallsKeepAlive() throws {
        let dir = try testDirectory(self)
        var runner = runner(dir)
        runner.command = { args in XCTAssertEqual(args.first, "print"); return 1 }
        runner.toolsReady = { false }
        XCTAssertThrowsError(try runner.prepareService()) { error in XCTAssertEqual(error as? MindError, .toolsMissing) }
        XCTAssertFalse(runner.serviceInstalled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: runner.kernelHome.path))
    }

    func testApplePlaceholdersAreNeverExecutedWithoutTools() {
        var calls: [String] = []
        let ready = RuntimeTools.available(path: "/usr/bin:/bin", executable: { _ in true }, run: { path, _ in
            calls.append(path); return 1
        })
        XCTAssertFalse(ready)
        XCTAssertEqual(calls, ["/usr/bin/xcode-select"], "No Python or Git stub may trigger a dialog")
        calls = []
        XCTAssertTrue(RuntimeTools.available(path: "/opt/homebrew/bin:/usr/bin", executable: { _ in true }, run: { path, _ in
            calls.append(path); return 0
        }))
        XCTAssertEqual(calls, ["/opt/homebrew/bin/python3", "/opt/homebrew/bin/git"])
    }
}

final class LoginItemTests: XCTestCase {
    func fixture(env: [String: String] = [:]) throws -> LoginItem {
        let home = try testDirectory(self)
        let app = home.appendingPathComponent("Applications/OpenRappter.app")
        return LoginItem(home: home, bundle: app, executable: app.appendingPathComponent("Contents/MacOS/OpenRappter").path,
                         env: env, command: { $0.first == "print" ? 1 : 0 })
    }

    func testOnlyApplicationsCopiesAreInstalled() throws {
        var item = try fixture()
        let home = item.home
        for path in ["/Volumes/OpenRappter/OpenRappter.app", "/private/tmp/AppTranslocation/abc/OpenRappter.app",
                     "/work/app/dist/OpenRappter.app", "/Applications-old/OpenRappter.app", "/Applications/not-an-app"] {
            item.bundle = URL(fileURLWithPath: path)
            item.executable = path + "/Contents/MacOS/OpenRappter"
            item.command = { _ in XCTFail("Do not load an unstable copy"); return 0 }
            XCTAssertEqual(try item.install(), .moveRequired)
            XCTAssertFalse(FileManager.default.fileExists(atPath: Doctor.loginItemURL(home: home).path))
        }
        XCTAssertTrue(LoginItem.isStable(URL(fileURLWithPath: "/Applications/OpenRappter.app"), home: home))
        XCTAssertTrue(LoginItem.isStable(home.appendingPathComponent("Applications/OpenRappter.app"), home: home))
        let target = home.appendingPathComponent("dev/OpenRappter.app")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        let link = home.appendingPathComponent("Applications/Linked.app")
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertFalse(LoginItem.isStable(link, home: home), "A shortcut into a disposable build is not stable")
    }

    func testUpdatingOwnJobNeverUnloadsIt() throws {
        var item = try fixture(env: ["XPC_SERVICE_NAME": LoginItem.label])
        item.command = { args in XCTFail("Never stop the job we are inside: \(args)"); return 0 }
        XCTAssertEqual(try item.install(), .installed)
        let url = Doctor.loginItemURL(home: item.home)
        var old = try XCTUnwrap(try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        old["ThrottleInterval"] = 99
        try PropertyListSerialization.data(fromPropertyList: old, format: .xml, options: 0).write(to: url)
        XCTAssertEqual(try item.install(), .installed)
        XCTAssertEqual(try item.install(), .unchanged)
        let saved = try XCTUnwrap(try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        XCTAssertEqual(saved["ThrottleInterval"] as? Int, 5)
        XCTAssertEqual(saved["ProgramArguments"] as? [String], [item.executable])
    }

    func testMovedInstalledCopyRepairsMissingSavedPath() throws {
        var item = try fixture()
        let url = Doctor.loginItemURL(home: item.home)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let stale: [String: Any] = ["ProgramArguments": ["/Volumes/Gone/OpenRappter.app/Contents/MacOS/OpenRappter"]]
        try PropertyListSerialization.data(fromPropertyList: stale, format: .xml, options: 0).write(to: url)
        var calls: [[String]] = []
        item.command = { calls.append($0); return $0.first == "print" ? 1 : 0 }
        XCTAssertEqual(try item.install(), .installed)
        let saved = try XCTUnwrap(try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        XCTAssertEqual(saved["ProgramArguments"] as? [String], [item.executable])
        XCTAssertEqual(calls.map { $0[0] }, ["enable", "print", "bootstrap"])
    }

    func testUninstallStopsBothJobsAndRemovesSavedAppSetting() throws {
        var item = try fixture()
        try item.install()
        let url = Doctor.loginItemURL(home: item.home)
        var calls: [[String]] = []
        item.command = { args in
            XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "Remove the saved setting before stopping ourselves")
            calls.append(args); return 0
        }
        try item.remove()
        XCTAssertEqual(calls.map { $0[0] }, ["disable", "bootout"])
        var state = CreatureStateMachine()
        let effects = state.send(.stopAtLogin)
        XCTAssertTrue(effects.contains(.stopAtLogin))
        XCTAssertTrue(effects.contains(.cancel(.retry)))
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let cask = try String(contentsOf: root.appendingPathComponent("homebrew/openrappter.rb"), encoding: .utf8)
        XCTAssertTrue(cask.contains("uninstall quit: \"com.openrappter.app\""))
        XCTAssertTrue(cask.contains("launchctl: [\"com.openrappter.app\", \"com.openrappter.kernel\"]"))
        XCTAssertTrue(cask.contains("~/Library/LaunchAgents/com.openrappter.app.plist"))
        XCTAssertTrue(cask.contains("~/Library/LaunchAgents/com.openrappter.kernel.plist"))
    }
}

final class DoorWordsTests: XCTestCase {
    func testApprovalUsesPlainVerbWithoutProgramDetails() {
        let caller = DoorCaller(name: "/some/bin/beam-helper", pid: 48213, program: "/Users/owner/bin/helper",
                                why: "Add the errand you asked for")
        let need = DoorWords.approval(caller, door: "reminders.add", id: "test", now: 1)
        XCTAssertEqual(need.title, "beam helper wants to add a reminder.")
        XCTAssertTrue(need.ctx!.contains(caller.why))
        XCTAssertTrue(need.ctx!.contains("Choose Allow once"))
        for value in [need.title, need.ctx!] {
            XCTAssertFalse(value.contains("reminders.add"))
            XCTAssertFalse(value.contains(caller.program))
            XCTAssertFalse(value.contains("48213"))
            XCTAssertEqual(value, OwnerWords.plain(value))
        }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let server = DoorServer(socketPath: "", allow: DoorAllowList(url: dir))
        MacDoors.install(on: server)
        for door in server.handlers.keys { XCTAssertNotNil(DoorWords.verbs[door], "Missing plain words for \(door)") }
        XCTAssertEqual(DoorWords.verb("new.machine-id"), "do that task")
    }

    func testTwinStreamAndPhoneUsePlainActionsNotCodes() throws {
        let dir = try testDirectory(self)
        let oldLog = DecisionLog.url, oldObjections = Objections.url
        DecisionLog.url = dir.appendingPathComponent("decisions.jsonl")
        Objections.url = dir.appendingPathComponent("objections.jsonl")
        defer { DecisionLog.url = oldLog; Objections.url = oldObjections }
        final class Phone: @unchecked Sendable { var lines: [String] = [] }
        let phone = Phone()
        let approve = doorApprovalViaNeeds(needsDir: dir, timeout: 0, twin: { _, _ in ("Allow once", 0.85) },
                                          phone: { phone.lines.append($0) })
        XCTAssertEqual(approve(DoorCaller(name: "Beam", pid: 1, program: "/secret"), "messages.send"), .once)
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .first { $0.lastPathComponent.hasPrefix("twin-") })
        let notice = try JSONDecoder().decode(Need.self, from: Data(contentsOf: file))
        XCTAssertTrue(notice.title.contains("send a text for you"))
        XCTAssertEqual(notice.ctx, "Tap Object if that was wrong.")
        XCTAssertEqual(phone.lines.count, 1)
        XCTAssertTrue(phone.lines[0].contains("tap Object in OpenRappter on your Mac"))
        for words in [notice.title, notice.ctx!, phone.lines[0]] {
            XCTAssertFalse(words.contains("messages.send"))
            XCTAssertFalse(words.contains(String(notice.id.dropFirst(5))))
            XCTAssertFalse(words.contains("/secret"))
            XCTAssertEqual(OwnerWords.plain(words), words)
        }
    }
}
