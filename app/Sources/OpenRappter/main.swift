import AppKit
import SwiftUI
import DynamicNotchKit
import OpenRappterCore

func log(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    // Always keep our own log, so a quit is never a mystery again (~/.openrappter/app.log).
    let own = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter/app.log").path
    if let h = FileHandle(forWritingAtPath: own) ?? (FileManager.default.createFile(atPath: own, contents: nil) ? FileHandle(forWritingAtPath: own) : nil) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
    }
    if let path = ProcessInfo.processInfo.environment["OPENRAPPTER_EVIDENCE"],
       let h = FileHandle(forWritingAtPath: path) ?? (FileManager.default.createFile(atPath: path, contents: nil) ? FileHandle(forWritingAtPath: path) : nil) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
    }
}

enum Mode { case ask, dictate, screen }

/// The whole app: one creature, one mind, three hold-keys, a needs queue, and a thin menu for the rest.
@MainActor
final class Coordinator: NSObject, NSApplicationDelegate {
    let model = CreatureModel()
    let ears = Ears()
    let voice = Voice()
    let needs = NeedsQueue()
    var notch: DynamicNotch<Expanded, CompactLeading, CompactTrailing>!
    var mind: MindClient?
    var sessionId: String?
    var history: [[String: String]] = []
    var mode: Mode?
    var statusItem: NSStatusItem?
    var needsSub: Any?
    var runner: MindRunner!
    var kernelProcess: Process?
    var doors: DoorServer?
    let env = ProcessInfo.processInfo.environment
    var home: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter") }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationWillTerminate(_ notification: Notification) { log("quitting (normal quit); the login item brings me back"); doors?.stop() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        // The broker must stay up with no windows: never let macOS end us as an idle app.
        ProcessInfo.processInfo.disableSuddenTermination()
        ProcessInfo.processInfo.disableAutomaticTermination("doors/1 broker")
        log("started pid \(ProcessInfo.processInfo.processIdentifier) launchd=\(env["XPC_SERVICE_NAME"] ?? "-")")
        KeepAlive.install(log: { log($0) })
        let model = self.model
        notch = DynamicNotch(hoverBehavior: .all, style: .auto,
                             expanded: { Expanded(model: model) },
                             compactLeading: { CompactLeading(model: model) },
                             compactTrailing: { CompactTrailing(model: model) })
        notch.transitionConfiguration.skipIntermediateHides = true

        let kernelDir = URL(fileURLWithPath: env["OPENRAPPTER_KERNEL_DIR"] ?? (Bundle.main.resourcePath.map { $0 + "/kernel" } ?? FileManager.default.currentDirectoryPath + "/kernel"))
        runner = MindRunner(kernelDir: kernelDir)
        runner.log = { log($0) }

        model.onAnswer = { [weak self] need, opt in self?.answer(need, opt) }
        model.onLater = { [weak self] need in self?.needs.later(need); self?.showNextNeedOrRest() }
        model.onSignIn = { [weak self] in self?.signIn() }

        startDoors()
        askForFullDiskAccessIfMissing()
        installHotKeys()
        installMenu()
        needsSub = needs.$needs.sink { [weak self] _ in Task { @MainActor in self?.showNextNeedOrRest() } }

        Task { @MainActor in
            await notch.compact()
            log("compact shown")
            await findMind()
            await runEnvDrivenProofs()
        }
    }

    // MARK: doors/1 (contracts/doors.md): other programs ask us; we hold the macOS approvals once

    func startDoors() {
        let sock = env["OPENRAPPTER_DOORS_SOCK"] ?? DoorServer.defaultSocket
        let allowURL = URL(fileURLWithPath: env["OPENRAPPTER_DOORS_ALLOW"] ?? home.appendingPathComponent("doors-allow.json").path)
        let s = DoorServer(socketPath: sock, allow: DoorAllowList(url: allowURL))
        s.log = { m in DispatchQueue.main.async { log(m) } }
        s.approve = doorApprovalViaNeeds(needsDir: needs.dir)
        MacDoors.install(on: s)
        do { try s.start(); doors = s } catch { log("doors failed to start: \(error)") }
    }

    /// Texts (chat.db) and Notes links (NoteStore) need Full Disk Access; say so once, in plain words, with the button.
    func askForFullDiskAccessIfMissing() {
        let chat = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Messages/chat.db").path
        let fd = open(chat, O_RDONLY)
        if fd >= 0 { close(fd); try? FileManager.default.removeItem(at: needs.dir.appendingPathComponent("full-disk-access.json")); return }
        log("no Full Disk Access yet (chat.db unreadable)")
        needs.add(Need(id: "full-disk-access", title: "To read your texts and make Notes links, add OpenRappter to Full Disk Access",
                       ctx: "Open the settings, switch on OpenRappter, and I'll do the rest.",
                       opts: [NeedOption(label: "Open Full Disk Access", rec: true, action: "open:" + Self.fullDiskAccessPane),
                              NeedOption(label: "Not now")],
                       source: "openrappter", created: Date().timeIntervalSince1970))
    }
    static let fullDiskAccessPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
    @objc func menuFullDiskAccess() { NSWorkspace.shared.open(URL(string: Self.fullDiskAccessPane)!) }

    // MARK: mind

    func findMind() async {
        model.posture = .thinking; model.line = "Finding my mind…"
        do {
            let (client, health): (MindClient, MindHealth)
            if let a = await runner.attach() { (client, health) = a }
            else {
                model.line = "Setting up my mind (first time, about a minute)…"
                try runner.installService()
                let own = MindClient(baseURL: URL(string: "http://127.0.0.1:\(runner.ownPort)")!, timeout: 3)
                var got: MindHealth?
                for _ in 0..<120 { if let h = try? await own.health() { got = h; break }; try? await Task.sleep(for: .seconds(2)) }
                guard let h = got else { throw MindError.unreachable("own kernel did not start") }
                (client, health) = (MindClient(baseURL: own.baseURL), h)
            }
            mind = client
            model.hungry = health.isHungry
            log("mind \(client.baseURL) v\(health.version) model=\(health.model) agents=\(health.agentCount) hungry=\(health.isHungry)")
            if health.isHungry { showHungry() } else { rest() }
        } catch {
            log("mind error \(error)")
            model.hungry = true
            model.posture = .needsYou; model.line = "I can't find my mind."
        }
    }

    func showHungry() {
        model.hungry = true
        model.posture = .needsYou
        model.line = "I can't think yet. Sign me in and I'm fed."
        Task { await notch.expand() }
    }

    func signIn() {
        guard let mind else { return }
        NSWorkspace.shared.open(mind.baseURL.appendingPathComponent("login"))
        model.line = "Finish the GitHub sign-in in your browser. I'll notice."
        Task { @MainActor in
            for _ in 0..<60 {   // poll two minutes
                try? await Task.sleep(for: .seconds(2))
                if let h = try? await mind.health(), !h.isHungry {
                    model.hungry = false; log("fed: signed in")
                    model.line = "Fed. Hold ⌥ Space and talk to me."
                    model.posture = .speaking; await voice.speak("Thanks. I'm fed.")
                    rest(); return
                }
            }
        }
    }

    func rest() {
        model.posture = .idle
        model.line = "Hold ⌥ Space and talk to me."
        Task { await notch.compact() }
    }

    // MARK: hold-to-talk

    func installHotKeys() {
        let hk = HotKeys.shared
        hk.register(id: 1, keyCode: HotKeys.space, modifiers: HotKeys.option) { [weak self] down in self?.key(.ask, down) }
        hk.register(id: 2, keyCode: HotKeys.space, modifiers: HotKeys.option | HotKeys.control) { [weak self] down in self?.key(.dictate, down) }
        hk.register(id: 3, keyCode: HotKeys.space, modifiers: HotKeys.option | HotKeys.shift) { [weak self] down in self?.key(.screen, down) }
    }

    func key(_ m: Mode, _ down: Bool) {
        if down { Task { await beginListening(m) } } else { Task { await endListening() } }
    }

    func beginListening(_ m: Mode) async {
        guard mode == nil else { return }
        guard await Ears.authorize() else { model.posture = .needsYou; model.line = "Allow the microphone and speech recognition in System Settings."; await notch.expand(); return }
        mode = m
        voice.stop()
        model.posture = .listening
        model.line = m == .dictate ? "Listening… I'll type it where your cursor is." : "Listening…"
        ears.onPartial = { [weak self] t in self?.model.line = t }
        do { try ears.start() } catch { model.line = "Microphone not available."; mode = nil }
        await notch.expand()
        log("listening mode=\(m) onDevice=\(ears.onDevice)")
    }

    func endListening() async {
        guard let m = mode else { return }
        let heard = await ears.stop()
        mode = nil
        log("heard \(heard.debugDescription)")
        await act(m, heard)
    }

    func act(_ m: Mode, _ heard: String) async {
        guard !heard.isEmpty else { rest(); return }
        switch m {
        case .ask:
            await ask(heard, screen: nil)
        case .dictate:
            guard Dictation.trusted(prompt: true) else {
                model.posture = .needsYou; model.line = "Allow OpenRappter in Accessibility so I can type for you."; return
            }
            model.posture = .speaking; model.line = heard
            let how = await Dictation.paste(heard)
            log("typed \(heard.count) chars via \(how) trusted=\(AXIsProcessTrusted()) canPost=\(CGPreflightPostEventAccess())")
            try? await Task.sleep(for: .seconds(1))
            rest()
        case .screen:
            model.posture = .thinking; model.line = "Reading your screen…"
            do {
                let (app, text) = try await Eyes.frontWindowText()
                log("screen app=\(app) chars=\(text.count)")
                await ask(heard, screen: "The user is looking at \(app). Text on that window:\n\(text.prefix(6000))")
            } catch {
                model.posture = .needsYou; model.line = "Allow Screen Recording so I can read your screen."; log("screen error \(error)")
            }
        }
    }

    func ask(_ question: String, screen: String?) async {
        guard let mind else { showHungry(); return }
        model.posture = .thinking; model.line = question
        await notch.expand()
        let msg = screen.map { "\(question)\n\n\($0)\n\nAnswer in under 60 words." } ?? "\(question)\n\nAnswer in under 60 words, then end with |||VOICE||| and a one or two sentence spoken version."
        do {
            let reply = try await mind.chat(msg, sessionId: sessionId, history: history)
            sessionId = reply.sessionId ?? sessionId
            history.append(["role": "user", "content": question]); history.append(["role": "assistant", "content": reply.text])
            if history.count > 20 { history.removeFirst(2) }
            model.posture = .speaking; model.line = reply.text
            log("reply \(reply.text.debugDescription) voice=\(reply.voice.debugDescription)")
            await voice.speak(reply.voice.isEmpty ? reply.text : reply.voice)
            try? await Task.sleep(for: .seconds(2))
            rest()
        } catch MindError.hungry(let why) {
            log("hungry \(why)"); showHungry()
        } catch {
            log("ask error \(error)"); model.posture = .needsYou; model.line = "I couldn't reach my mind."
        }
    }

    // MARK: needs

    func showNextNeedOrRest() {
        if model.hungry { return }
        if let top = needs.top {
            if model.need?.id != top.id { log("need \(top.id) \(top.title.debugDescription)") }
            model.need = top
            model.posture = .needsYou
            model.line = top.title
            Task { await notch.expand() }
        } else if model.posture == .needsYou {
            model.need = nil
            rest()
        }
    }

    func answer(_ need: Need, _ opt: NeedOption) {
        needs.answer(need, opt)
        log("answered \(need.id) \(opt.label.debugDescription) action=\(opt.action ?? "-")")
        if let a = opt.action, a.hasPrefix("open:"), let u = URL(string: String(a.dropFirst(5))) { NSWorkspace.shared.open(u) }
        model.need = nil
        showNextNeedOrRest()
    }

    // MARK: menu (the thin frame)

    func installMenu() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "lizard.fill", accessibilityDescription: "OpenRappter")
        let menu = NSMenu()
        menu.addItem(withTitle: "Talk: hold ⌥ Space", action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Type for me: hold ⌃⌥ Space", action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "Ask about my screen: hold ⇧⌥ Space", action: nil, keyEquivalent: "")
        menu.addItem(.separator())
        menu.addItem(withTitle: "Sign in to my mind…", action: #selector(menuSignIn), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Connect Claude Code (answer its prompts here)", action: #selector(menuConnectClaude), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Keep my mind running at login", action: #selector(menuInstallService), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Let me read your texts (Full Disk Access)…", action: #selector(menuFullDiskAccess), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open my folder", action: #selector(menuOpenFolder), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Restart OpenRappter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
        statusItem = item
    }

    @objc func menuSignIn() { if mind == nil { Task { await findMind() } } else { signIn() } }
    @objc func menuOpenFolder() { NSWorkspace.shared.open(home) }
    @objc func menuInstallService() {
        do { try runner.installService(); model.line = "My mind now starts at login and keeps running." }
        catch { model.line = "Couldn't set that up: \(error.localizedDescription)" }
        model.posture = .speaking
        Task { await notch.expand(); try? await Task.sleep(for: .seconds(4)); rest() }
    }
    @objc func menuConnectClaude() {
        let result = ClaudeCodeHook.install(from: Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        model.posture = .speaking; model.line = result
        log("connect claude: \(result)")
        Task { await notch.expand(); try? await Task.sleep(for: .seconds(5)); rest() }
    }

    // MARK: proofs driven from outside (no microphone needed)

    func runEnvDrivenProofs() async {
        if let q = env["OPENRAPPTER_SAY"] { await act(.ask, q) }
        if let t = env["OPENRAPPTER_DICTATE"] { await act(.dictate, t) }
        if let q = env["OPENRAPPTER_SCREEN_ASK"] { await act(.screen, q) }
        if env["OPENRAPPTER_DEMO_EXIT"] == "1" { log("done"); NSApp.terminate(nil) }
    }
}

/// The login item that brings the broker back after a quit, a crash or a reboot:
/// ~/Library/LaunchAgents/com.openrappter.app.plist (RunAtLoad + KeepAlive), pointing at this copy of the app.
enum KeepAlive {
    static let label = "com.openrappter.app"
    static var plist: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist") }

    static func install(log: (String) -> Void) {
        guard ProcessInfo.processInfo.environment["OPENRAPPTER_NO_LOGIN_ITEM"] == nil, let exe = Bundle.main.executablePath,
              Bundle.main.bundlePath.hasSuffix(".app") else { return }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let want: [String: Any] = ["Label": label, "ProgramArguments": [exe], "RunAtLoad": true, "KeepAlive": true,
                                   "ThrottleInterval": 5, "ProcessType": "Interactive",
                                   "StandardErrorPath": home + "/.openrappter/app.stderr.log"]
        if let have = NSDictionary(contentsOf: plist), have.isEqual(to: want) { return }
        let fresh = !FileManager.default.fileExists(atPath: plist.path)
        try? FileManager.default.createDirectory(at: plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard (want as NSDictionary).write(to: plist, atomically: true) else { log("could not write \(plist.path)"); return }
        let dom = "gui/\(getuid())"
        if !fresh { run(["bootout", "\(dom)/\(label)"]) }
        run(["bootstrap", dom, plist.path])
        log("login item installed: \(plist.path) -> \(exe)")
    }

    @discardableResult static func run(_ args: [String]) -> Int32 {
        let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl"); p.arguments = args
        p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
        try? p.run(); p.waitUntilExit(); return p.terminationStatus
    }

    /// One broker at a time. A second copy (e.g. `open` while launchd's is up) waits quietly until the first is gone.
    static func waitForOtherCopy() {
        let me = ProcessInfo.processInfo.processIdentifier
        while NSRunningApplication.runningApplications(withBundleIdentifier: label).contains(where: { $0.processIdentifier != me && !$0.isTerminated }) {
            Thread.sleep(forTimeInterval: 2)
        }
    }
}

KeepAlive.waitForOtherCopy()
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = Coordinator()
    app.delegate = delegate
    app.run()
}
