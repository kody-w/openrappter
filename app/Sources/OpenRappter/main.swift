import AppKit
import Combine
import SwiftUI
import DynamicNotchKit
import OpenRappterCore

func log(_ message: String) {
    let data = Data("\(ISO8601DateFormatter().string(from: Date())) \(message)\n".utf8)
    FileHandle.standardError.write(data)
    let home = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter")
    try? FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
    let paths = [home.appendingPathComponent("app.log").path,
                 ProcessInfo.processInfo.environment["OPENRAPPTER_EVIDENCE"]].compactMap { $0 }
    for path in paths {
        if !FileManager.default.fileExists(atPath: path) { FileManager.default.createFile(atPath: path, contents: nil) }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile(); handle.write(data); handle.closeFile()
        }
    }
}

@MainActor
final class MenuTarget: NSObject {
    let run: () -> Void
    init(_ run: @escaping () -> Void) { self.run = run }
    @objc func invoke() { run() }
}

/// Only Mac wiring lives here. The core owns every creature transition and its visible words.
@MainActor
final class Coordinator: NSObject, NSApplicationDelegate {
    let model = CreatureModel()
    let needs = NeedsQueue()
    let env = ProcessInfo.processInfo.environment
    var effects: MacCreatureEffects!
    var driver: CreatureDriver!
    var notch: DynamicNotch<Expanded, CompactLeading, CompactTrailing>!
    var doors: DoorServer?
    var statusItem: NSStatusItem?
    var subscriptions: Set<AnyCancellable> = []
    var menuTargets: [MenuTarget] = []
    var layout: Task<Void, Never>?
    var examples: Task<Void, Never>?
    var expanded: Bool?
    var home: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter") }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) {
        examples?.cancel()
        driver?.send(.shutdown); driver?.cancelAll()
        effects?.clipboard.restore(); effects?.ears.cancel(); effects?.voice.stop()
        doors?.stop(); log("quitting")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        ProcessInfo.processInfo.disableSuddenTermination()
        ProcessInfo.processInfo.disableAutomaticTermination("OpenRappter is here to help")
        let model = self.model
        notch = DynamicNotch(hoverBehavior: .all, style: .auto,
                             expanded: { Expanded(model: model) },
                             compactLeading: { CompactLeading(model: model) },
                             compactTrailing: { CompactTrailing(model: model) })
        notch.transitionConfiguration.skipIntermediateHides = true
        let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        var runner = MindRunner(kernelDir: env["OPENRAPPTER_KERNEL_DIR"].map { URL(fileURLWithPath: $0) }
                                ?? resources.appendingPathComponent("kernel"))
        runner.log = { log($0) }
        effects = MacCreatureEffects(runner: runner, needs: needs)
        effects.log = { log($0) }
        effects.willQuit = { [weak self] in
            self?.examples?.cancel()
            log("going to sleep")
        }
        driver = CreatureDriver { [weak self] in await self?.effects.perform($0) }
        driver.onChange = { [weak self] in self?.render($0) }
        effects.send = { [weak self] in self?.driver.send($0) }
        model.onAnswer = { [weak self] in self?.driver.send(.answer($0, $1)) }
        model.onLater = { [weak self] in self?.driver.send(.later($0)) }
        model.onSignIn = { [weak self] in self?.driver.send(.signIn) }
        model.onSubmit = { [weak self] in self?.driver.send(.submit(.ask, $0)) }
        model.onDismissLine = { [weak self] in self?.driver.send(.dismissLine) }
        model.onDraftChanged = { [weak self] in self?.driver.send(.draftChanged($0)) }
        model.onObject = { [weak self] need in
            let result = Objections.object(code: need.id, allow: self?.doors?.allow)
            log("objected \(need.id): \(result != nil)")
        }
        model.followStream(needs)
        needs.$needs.sink { [weak self] cards in self?.driver.send(.needsChanged(cards)) }.store(in: &subscriptions)
        installDoors()
        installHotKeys()
        installMenu()
        driver.send(.findMind)
        driver.send(effects.checkLoginItem())
        runExamples()
    }

    func render(_ view: CreaturePresentation) {
        model.apply(view)
        guard expanded != view.expanded else { return }
        expanded = view.expanded; layout?.cancel()
        layout = Task { @MainActor in
            guard !Task.isCancelled else { return }
            if view.expanded { await notch.expand() } else { await notch.compact() }
        }
    }

    func installDoors() {
        let server = DoorServer(socketPath: env["OPENRAPPTER_DOORS_SOCK"] ?? DoorServer.defaultSocket,
                                allow: DoorAllowList(url: URL(fileURLWithPath: env["OPENRAPPTER_DOORS_ALLOW"]
                                    ?? home.appendingPathComponent("doors-allow.json").path)))
        server.log = { log($0) }
        server.approve = doorApprovalViaNeeds(needsDir: needs.dir, phone: { [weak server] line in
            DispatchQueue.global().async {
                do { _ = try server?.handlers["notes.publish"]?(["topic": "Twin", "headline": line]) }
                catch { log("phone note: \(error)") }
            }
        })
        MacDoors.install(on: server, needsDir: needs.dir)
        do { try server.start(); doors = server } catch { log("doors: \(error)") }
    }

    func installHotKeys() {
        for (id, mode, modifiers) in [
            (UInt32(1), TalkMode.ask, HotKeys.option),
            (UInt32(2), TalkMode.dictate, HotKeys.option | HotKeys.control),
            (UInt32(3), TalkMode.screen, HotKeys.option | HotKeys.shift),
        ] {
            HotKeys.shared.register(id: id, keyCode: HotKeys.space, modifiers: modifiers) { [weak self] down in
                self?.driver.send(down ? .keyDown(mode) : .keyUp(mode))
            }
        }
    }

    func installMenu() {
        func make(_ entries: [CreatureMenuEntry]) -> NSMenu {
            let menu = NSMenu()
            for entry in entries {
                let item = NSMenuItem(title: entry.title, action: nil, keyEquivalent: "")
                if let command = entry.command {
                    let target = MenuTarget { [weak self] in self?.menu(command) }
                    menuTargets.append(target); item.target = target; item.action = #selector(MenuTarget.invoke)
                } else { item.submenu = make(entry.children) }
                menu.addItem(item)
            }
            return menu
        }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "lizard.fill", accessibilityDescription: "OpenRappter")
        item.menu = make(CreatureMenu.entries); statusItem = item
    }

    func menu(_ command: CreatureMenuCommand) {
        switch command {
        case .help: driver.send(.showHelp)
        case .type:
            model.inputFocusRequest += 1
            driver.send(.showInput)
            NSApp.activate(ignoringOtherApps: true)
            notch.windowController?.window?.makeKey()
        case .goToSleep: driver.send(.goToSleep)
        case .signIn: driver.send(.signIn)
        case .keepAtLogin: driver.send(.installAtLogin)
        case .stopAtLogin: driver.send(.stopAtLogin)
        case .texts:
            driver.send(.showPermission(.texts))
        case .folder: NSWorkspace.shared.open(home)
        case .connectHelper:
            do {
                try ClaudeCodeHook.install(from: Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
                driver.send(.connectedHelper(true))
            } catch { log("connect helper: \(error)"); driver.send(.connectedHelper(false)) }
        case .restart:
            if env["XPC_SERVICE_NAME"] == LoginItem.label {
                _ = RuntimeTools.run("/bin/launchctl", ["kickstart", "-k", "gui/\(getuid())/\(LoginItem.label)"])
            } else {
                let task = Process(); task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                task.arguments = ["-n", Bundle.main.bundlePath]
                do { try task.run(); NSApp.terminate(nil) } catch { log("restart: \(error)") }
            }
        }
    }

    func runExamples() {
        let requests = [("OPENRAPPTER_SAY", TalkMode.ask), ("OPENRAPPTER_DICTATE", .dictate), ("OPENRAPPTER_SCREEN_ASK", .screen)]
            .compactMap { key, mode in env[key].map { (mode, $0) } }
        guard !requests.isEmpty || env["OPENRAPPTER_DEMO_EXIT"] == "1" else { return }
        examples = Task { @MainActor in
            await driver.waitUntilSettled()
            for (mode, text) in requests {
                guard !Task.isCancelled else { return }
                driver.send(.submit(mode, text))
                await driver.waitUntilSettled()
            }
            if !Task.isCancelled, env["OPENRAPPTER_DEMO_EXIT"] == "1" { log("done"); NSApp.terminate(nil) }
        }
    }
}

if CommandLine.arguments.contains("--doctor") {
    Task.detached {
        let report = await Doctor.check()
        do { print(try report.output(json: CommandLine.arguments.contains("--json"))); exit(0) }
        catch { FileHandle.standardError.write(Data("I couldn't write my self-check.\n".utf8)); exit(1) }
    }
    dispatchMain()
}

let me = ProcessInfo.processInfo.processIdentifier
let claimed = CreatureHandoff.claim(bundle: Bundle.main.bundleURL,
                                  home: FileManager.default.homeDirectoryForCurrentUser, id: me, running: {
    NSRunningApplication.runningApplications(withBundleIdentifier: LoginItem.label)
        .filter { !$0.isTerminated }.map { CreatureInstance(id: $0.processIdentifier, bundle: $0.bundleURL) }
}, retire: { id, force in
    guard let previous = NSRunningApplication(processIdentifier: id) else { return }
    if force { previous.forceTerminate() } else { previous.terminate() }
})
if !claimed {
    log("another creature is already here")
    exit(0)
}
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = Coordinator()
    app.delegate = delegate
    app.run()
}
