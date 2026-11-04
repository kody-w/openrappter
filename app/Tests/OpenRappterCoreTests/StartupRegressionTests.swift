import XCTest
@testable import OpenRappterCore

extension MindStartupTests {
    func testLoadedServiceReceivesBothNewLauncherFilesWithoutBeingStopped() throws {
        let dir = try testDirectory(self)
        var runner = try runner(dir)
        let saved = Data("existing saved setting".utf8)
        try saved.write(to: runner.launchAgentURL)
        let launcher = runner.kernelHome.appendingPathComponent("launcher")
        try FileManager.default.createDirectory(at: launcher, withIntermediateDirectories: true)
        for file in ["run.sh", "kernel.json"] {
            try Data("old \(file)".utf8).write(to: launcher.appendingPathComponent(file))
        }
        var calls: [[String]] = []
        runner.command = { calls.append($0); return 0 }
        runner.toolsReady = { true }
        try runner.prepareService()
        for file in ["run.sh", "kernel.json"] {
            XCTAssertEqual(try Data(contentsOf: launcher.appendingPathComponent(file)),
                           try Data(contentsOf: runner.kernelDir.appendingPathComponent(file)))
        }
        XCTAssertEqual(try Data(contentsOf: runner.launchAgentURL), saved)
        XCTAssertEqual(calls.map { $0[0] }, ["print"])
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: launcher.appendingPathComponent("run.sh").path))
    }

    func testHealthyAttachedMindStillReceivesAnUpgradeWithoutToolsOrRestart() async throws {
        let dir = try testDirectory(self)
        var runner = try runner(dir)
        let saved = Data("existing setting".utf8)
        try saved.write(to: runner.launchAgentURL)
        let kernel = try FakeKernel()
        defer { kernel.stop() }
        runner.candidates = [URL(string: "http://127.0.0.1:\(kernel.port)")!]
        runner.toolsReady = { XCTFail("A healthy mind does not need a tools check"); return false }
        runner.command = { _ in XCTFail("Do not restart a healthy mind to upgrade its launcher"); return 0 }
        let attached = try await runner.findMind(attempts: 0)
        XCTAssertEqual(attached.0.baseURL.port, Int(kernel.port))
        for file in ["run.sh", "kernel.json"] {
            XCTAssertEqual(try Data(contentsOf: runner.kernelHome.appendingPathComponent("launcher/\(file)")),
                           try Data(contentsOf: runner.kernelDir.appendingPathComponent(file)))
        }
        XCTAssertEqual(try Data(contentsOf: runner.launchAgentURL), saved)
    }

    func testLoadedOrInstalledServiceStillReportsMissingTools() throws {
        for loaded in [true, false] {
            let dir = try testDirectory(self)
            var runner = try runner(dir)
            try Data("saved".utf8).write(to: runner.launchAgentURL)
            var calls: [[String]] = []
            runner.command = { calls.append($0); return loaded ? 0 : 1 }
            runner.toolsReady = { false }
            XCTAssertThrowsError(try runner.prepareService()) {
                XCTAssertEqual($0 as? MindError, .toolsMissing)
            }
            XCTAssertFalse(calls.contains { $0.first == "bootstrap" || $0.first == "bootout" })
            XCTAssertEqual(try Data(contentsOf: runner.launchAgentURL), Data("saved".utf8))
        }
    }

    func testKernelServiceThrottlesAnyUnexpectedRuntimeExit() throws {
        let dir = try testDirectory(self)
        var runner = try runner(dir)
        runner.toolsReady = { true }
        runner.command = { $0.first == "print" ? 1 : 0 }
        try runner.installService()
        let plist = try XCTUnwrap(try PropertyListSerialization.propertyList(
            from: Data(contentsOf: runner.launchAgentURL), format: nil) as? [String: Any])
        XCTAssertEqual(plist["ThrottleInterval"] as? Int, 60)
    }
}

@MainActor
final class StartupAdapterRegressionTests: XCTestCase {
    final class Commands {
        var calls: [[String]] = []
        var loaded: Set<String> = []
        var enableStatus: Int32 = 0

        func run(_ args: [String]) -> Int32 {
            calls.append(args)
            switch args.first {
            case "print":
                return loaded.contains(String(args[1].split(separator: "/").last!)) ? 0 : 1
            case "bootstrap":
                guard let data = try? Data(contentsOf: URL(fileURLWithPath: args[2])),
                      let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
                      let label = plist["Label"] as? String else { return 9 }
                loaded.insert(label)
                return 0
            case "enable": return enableStatus
            case "bootout":
                loaded.remove(String(args[1].split(separator: "/").last!))
                return 0
            default: return 0
            }
        }
    }

    func fixture() throws -> (effects: MacCreatureEffects, commands: Commands, home: URL) {
        let home = try testDirectory(self)
        let kernel = home.appendingPathComponent("bundle/kernel")
        try FileManager.default.createDirectory(at: kernel, withIntermediateDirectories: true)
        try Data("new manifest".utf8).write(to: kernel.appendingPathComponent("kernel.json"))
        try Data("#!/bin/sh\nprintf child > \"$OPENRAPPTER_KERNEL_HOME/child-started\"\n".utf8)
            .write(to: kernel.appendingPathComponent("run.sh"))
        let commands = Commands()
        let bundle = home.appendingPathComponent("Applications/OpenRappter.app")
        let item = LoginItem(home: home, bundle: bundle, executable: bundle.appendingPathComponent("Contents/MacOS/OpenRappter").path,
                             env: ["XPC_SERVICE_NAME": LoginItem.label], command: commands.run)
        var runner = MindRunner(kernelDir: kernel, kernelHome: home.appendingPathComponent(".openrappter/kernel"), env: ["HOME": home.path])
        runner.serviceURL = home.appendingPathComponent("Library/LaunchAgents/com.openrappter.kernel.plist")
        runner.toolsReady = { true }
        runner.command = commands.run
        runner.candidates = []
        runner.ownPort = 1
        let effects = MacCreatureEffects(runner: runner, needs: NeedsQueue(dir: home.appendingPathComponent("needs")),
                                         voice: Voice(output: { _ in }, stop: {}), loginItem: item)
        return (effects, commands, home)
    }

    func testStopDisablesFutureStartsWithoutKillingEitherLiveJobAndConfirms() async throws {
        let (effects, commands, home) = try fixture()
        let installed = await effects.perform(.installAtLogin(1))
        XCTAssertEqual(installed, .installedAtLogin(1, .success(.installed)))
        commands.loaded.insert(LoginItem.label)
        commands.calls = []
        let event = await effects.perform(.stopAtLogin)
        XCTAssertEqual(event, .stoppedAtLogin(true))
        XCTAssertTrue(StartupPreference(home: home).isStopped)
        XCTAssertFalse(FileManager.default.fileExists(atPath: Doctor.loginItemURL(home: home).path))
        XCTAssertFalse(effects.runner.serviceInstalled)
        XCTAssertEqual(commands.calls.map { $0[0] }, ["disable", "disable"])
        XCTAssertEqual(commands.loaded, [LoginItem.label, MindRunner.serviceLabel])
        var state = CreatureStateMachine()
        if let event { state.send(event) }
        XCTAssertTrue(state.presentation.line.contains("I'll stay for now"))
        XCTAssertTrue(state.presentation.line.contains("won't come back on my own"))
        XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:dismiss")
    }

    func testStoppedChoiceSurvivesReopeningAndMindLookupWithoutBootstrap() async throws {
        let (effects, commands, home) = try fixture()
        _ = await effects.perform(.installAtLogin(1))
        _ = await effects.perform(.stopAtLogin)
        commands.calls = []
        let reopenedItem = LoginItem(home: home, bundle: effects.loginItem.bundle, executable: effects.loginItem.executable,
                                     env: [:], command: commands.run)
        XCTAssertEqual(try reopenedItem.install(), .skipped)
        var reopenedRunner = effects.runner
        reopenedRunner.startupPreference = StartupPreference(home: home)
        do {
            _ = try await reopenedRunner.findMind(attempts: 0)
            XCTFail("No fake mind is listening")
        } catch { XCTAssertEqual(error as? MindError, .unreachable("Mind did not become ready")) }
        XCTAssertFalse(commands.calls.contains { ["enable", "bootstrap", "bootout"].contains($0[0]) })
        XCTAssertTrue(StartupPreference(home: home).isStopped)
        XCTAssertFalse(reopenedRunner.serviceInstalled)
    }

    func testStoppedUnloadedMindStartsAsChildWithoutRestoringAutomaticStartup() async throws {
        let (effects, commands, home) = try fixture()
        try StartupPreference(home: home).stop()
        try FileManager.default.createDirectory(at: effects.runner.kernelHome, withIntermediateDirectories: true)
        try effects.runner.prepareService()
        let started = effects.runner.kernelHome.appendingPathComponent("child-started")
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: started.path) {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(try String(contentsOf: started, encoding: .utf8), "child")
        XCTAssertTrue(StartupPreference(home: home).isStopped)
        XCTAssertFalse(effects.runner.serviceInstalled)
        XCTAssertFalse(commands.calls.contains { ["enable", "bootstrap", "bootout"].contains($0[0]) })
    }

    func testExplicitKeepAfterStopRestoresAndEnablesBothJobsIncludingOurOwn() async throws {
        let (effects, commands, home) = try fixture()
        _ = await effects.perform(.installAtLogin(1))
        commands.loaded.insert(LoginItem.label)
        _ = await effects.perform(.stopAtLogin)
        commands.calls = []
        let event = await effects.perform(.installAtLogin(2))
        XCTAssertEqual(event, .installedAtLogin(2, .success(.installed)))
        XCTAssertFalse(StartupPreference(home: home).isStopped)
        for url in [effects.runner.launchAgentURL, Doctor.loginItemURL(home: home)] {
            let plist = try XCTUnwrap(try PropertyListSerialization.propertyList(
                from: Data(contentsOf: url), format: nil) as? [String: Any])
            XCTAssertEqual(plist["RunAtLoad"] as? Bool, true)
            XCTAssertEqual(plist["KeepAlive"] as? Bool, true)
        }
        let enabled = commands.calls.filter { $0.first == "enable" }.map { String($0[1].split(separator: "/").last!) }
        XCTAssertEqual(Set(enabled), [MindRunner.serviceLabel, LoginItem.label])
        XCTAssertFalse(commands.calls.contains { $0.first == "bootout" })
    }

    func testStoppedChildIsNotDuplicatedByRetriesOrAnExplicitKeep() async throws {
        let (effects, commands, home) = try fixture()
        try StartupPreference(home: home).stop()
        try FileManager.default.createDirectory(at: effects.runner.kernelHome, withIntermediateDirectories: true)
        try Data("#!/bin/sh\nprintf 'start\\n' >> \"$OPENRAPPTER_KERNEL_HOME/starts\"\nexec /bin/sleep 60\n".utf8)
            .write(to: effects.runner.kernelDir.appendingPathComponent("run.sh"))
        let process = try effects.runner.launch()
        defer { if process.isRunning { process.terminate(); process.waitUntilExit() } }
        XCTAssertTrue(process.isRunning)
        try effects.runner.prepareService()
        XCTAssertTrue(try effects.runner.launch() === process)
        let installed = await effects.perform(.installAtLogin(1))
        XCTAssertEqual(installed, .installedAtLogin(1, .success(.installed)))
        try effects.runner.prepareService()
        let starts = effects.runner.kernelHome.appendingPathComponent("starts")
        for _ in 0..<200 where !FileManager.default.fileExists(atPath: starts.path) {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(try String(contentsOf: starts, encoding: .utf8), "start\n")
        XCTAssertTrue(process.isRunning)
        XCTAssertFalse(commands.calls.contains { $0.first == "bootstrap" && $0.last == effects.runner.launchAgentURL.path })
        XCTAssertTrue(effects.runner.serviceInstalled, "Future starts are saved without duplicating the live child")
    }

    func testFailedExplicitKeepDoesNotUndoTheOwnersStoppedChoice() async throws {
        let (effects, commands, home) = try fixture()
        _ = await effects.perform(.installAtLogin(1))
        _ = await effects.perform(.stopAtLogin)
        commands.calls = []
        commands.enableStatus = 9
        let result = await effects.perform(.installAtLogin(2))
        XCTAssertEqual(result, .installedAtLogin(2, .failure(.unavailable)))
        XCTAssertTrue(StartupPreference(home: home).isStopped)
        XCTAssertFalse(effects.runner.serviceInstalled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: Doctor.loginItemURL(home: home).path))
        XCTAssertFalse(commands.calls.contains { $0.first == "bootout" })
        commands.calls = []
        XCTAssertEqual(effects.checkLoginItem(), .checkedLoginItem(.success(.skipped)))
        try effects.runner.prepareService()
        XCTAssertFalse(commands.calls.contains { $0.first == "enable" || $0.first == "bootstrap" })
    }

    func testMissingToolsDuringExplicitKeepOffersInstallInsteadOfTryAgain() async throws {
        let (effects, commands, home) = try fixture()
        effects.runner.toolsReady = { false }
        var state = CreatureStateMachine()
        let work = state.send(.installAtLogin)
        guard case .installAtLogin(let id) = work.first else { return XCTFail("Expected setup") }
        let event = await effects.perform(work[0])
        XCTAssertEqual(event, .installedAtLogin(id, .failure(.toolsMissing)))
        if let event { state.send(event) }
        XCTAssertEqual(state.presentation.need?.opts.first?.label, "Install")
        XCTAssertEqual(state.presentation.need?.opts.first?.action, "creature:install-tools")
        XCTAssertFalse(commands.calls.contains { $0.first == "bootstrap" })
        XCTAssertFalse(FileManager.default.fileExists(atPath: Doctor.loginItemURL(home: home).path))
    }

    func testExplicitKeepFromUnstableCopyOffersMoveAndNeverClaimsSuccess() async throws {
        let (effects, commands, _) = try fixture()
        effects.loginItem.bundle = URL(fileURLWithPath: "/Volumes/OpenRappter/OpenRappter.app")
        let event = await effects.perform(.installAtLogin(1))
        XCTAssertEqual(event, .installedAtLogin(1, .success(.moveRequired)))
        XCTAssertTrue(commands.calls.isEmpty, "Do not set up either helper for an unstable app")
        var state = CreatureStateMachine()
        _ = state.send(.installAtLogin)
        if let event { state.send(event) }
        XCTAssertTrue(state.presentation.line.contains("Move OpenRappter"))
        XCTAssertFalse(state.presentation.line.contains("will be ready"))
    }

    func testStartupInstallErrorOffersRetryNotMoveAndRetryInstallsBoth() async throws {
        let (effects, commands, _) = try fixture()
        effects.loginItem.env = [:]
        commands.enableStatus = 9
        let event = effects.checkLoginItem()
        XCTAssertEqual(event, .checkedLoginItem(.failure(.unavailable)))
        var state = CreatureStateMachine()
        state.send(event)
        XCTAssertFalse(state.presentation.line.contains("Move OpenRappter"))
        let card = try XCTUnwrap(state.presentation.need)
        XCTAssertEqual(card.opts[0].label, "Try again")
        let work = state.send(.answer(card, card.opts[0]))
        guard case .installAtLogin(let id) = work.first else { return XCTFail("Retry must perform setup") }
        commands.enableStatus = 0
        let done = await effects.perform(work[0])
        XCTAssertEqual(done, .installedAtLogin(id, .success(.installed)))
        if let done { state.send(done) }
        XCTAssertTrue(state.presentation.line.contains("I'll come back"))
        XCTAssertTrue(effects.runner.serviceInstalled)
        XCTAssertTrue(commands.loaded.contains(LoginItem.label))
    }

    func testNoWindowIsNotMisreportedAsScreenPermission() async throws {
        let (effects, _, _) = try fixture()
        effects.readScreen = { throw EyesError.noWindow }
        var state = CreatureStateMachine()
        let work = state.send(.submit(.screen, "Read this"))
        guard case .readScreen(let id, _) = work.last else { return XCTFail("Expected screen read") }
        let event = await effects.perform(work.last!)
        XCTAssertEqual(event, .screenRead(id, .failure(.nothingToRead)))
        if let event { state.send(event) }
        XCTAssertEqual(state.presentation.line, "I don't see a window to read. Bring one to the front and try again.")
        XCTAssertFalse(state.presentation.need!.opts.contains { $0.action?.hasPrefix("open:") == true })
    }

    func testScreenCaptureErrorStillOffersTheScreenPermissionSetting() async throws {
        let (effects, _, _) = try fixture()
        effects.readScreen = { throw NSError(domain: "ScreenCapture", code: 1) }
        var state = CreatureStateMachine()
        let work = state.send(.submit(.screen, "Read this"))
        let event = await effects.perform(work.last!)
        if let event { state.send(event) }
        XCTAssertEqual(state.presentation.need, CreatureStateMachine.permissionCard(.screen))
    }
}

extension LoginItemTests {
    func testCaskReopensTheUpdatedAppAfterRemovingItsJobs() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let cask = try String(contentsOf: root.appendingPathComponent("homebrew/openrappter.rb"), encoding: .utf8)
        XCTAssertTrue(cask.contains("uninstall quit: \"com.openrappter.app\""))
        XCTAssertTrue(cask.contains("launchctl: [\"com.openrappter.app\", \"com.openrappter.kernel\"]"))
        XCTAssertTrue(cask.contains("postflight do"))
        XCTAssertTrue(cask.contains("system_command \"/usr/bin/open\", args: [\"-g\", \"-a\", \"#{appdir}/OpenRappter.app\"]"))
    }
}
