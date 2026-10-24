import AppKit
import SwiftUI
import DynamicNotchKit
import OpenRappterCore

func log(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
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
    var setupWatch: Task<Void, Never>?
    let env = ProcessInfo.processInfo.environment
    var home: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".openrappter") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
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
        model.onAllow = { [weak self] p in self?.allow(p) }
        model.onSetupLater = { [weak self] in self?.setupLater() }

        installHotKeys()
        installMenu()
        needsSub = needs.$needs.sink { [weak self] _ in Task { @MainActor in self?.showNextNeedOrRest() } }

        Task { @MainActor in
            await notch.compact()
            log("compact shown")
            if env["OPENRAPPTER_SETUP"] == "1" || (!Powers.allGranted(Powers.states(fake: env["OPENRAPPTER_SETUP_FAKE"])) && !UserDefaults.standard.bool(forKey: "setupSeen")) {
                showSetup()
            }
            await findMind()
            await runEnvDrivenProofs()
        }
    }

    // MARK: first run: the four powers

    func refreshPowers() { model.powers = Powers.states(fake: env["OPENRAPPTER_SETUP_FAKE"]) }

    func showSetup(reason: String? = nil) {
        refreshPowers()
        model.setup = true
        model.posture = .needsYou
        model.line = reason ?? "A minute of setup and I can hear you, type for you and see your screen."
        log("setup shown " + Power.allCases.map { "\($0.rawValue)=\((model.powers[$0] ?? .notAsked).rawValue)" }.joined(separator: " "))
        Task { await notch.expand() }
        setupWatch?.cancel()
        setupWatch = Task { @MainActor [weak self] in
            while let self, !Task.isCancelled, self.model.setup {
                try? await Task.sleep(for: .milliseconds(1500))
                let before = self.model.powers
                self.refreshPowers()
                for p in Power.allCases where before[p] != self.model.powers[p] { log("power \(p.rawValue) -> \((self.model.powers[p] ?? .notAsked).rawValue)") }
                if Powers.allGranted(self.model.powers) { await self.setupDone(); return }
            }
        }
    }

    func allow(_ p: Power) {
        let was = model.powers[p] ?? .notAsked
        log("allow \(p.rawValue) was \(was.rawValue)")
        model.line = p.why
        Task { @MainActor in
            await Powers.request(p, current: was)
            refreshPowers()
            if let st = model.powers[p], st != was { log("power \(p.rawValue) -> \(st.rawValue)") }
            if Powers.allGranted(model.powers) { await setupDone() }
        }
    }

    func setupDone() async {
        guard model.setup else { return }
        setupWatch?.cancel(); model.setup = false
        UserDefaults.standard.set(true, forKey: "setupSeen")
        log("setup done")
        model.posture = .speaking; model.line = "All set. Hold ⌥ Space and talk to me."
        await voice.speak("All set. Hold option space and talk to me.")
        try? await Task.sleep(for: .seconds(1))
        afterSetup()
    }

    func setupLater() {
        setupWatch?.cancel(); model.setup = false
        UserDefaults.standard.set(true, forKey: "setupSeen")
        log("setup later")
        afterSetup()
    }

    func afterSetup() { if model.hungry { showHungry() } else { showNextNeedOrRest() } }

    // MARK: mind

    func findMind() async {
        if !model.setup { model.posture = .thinking; model.line = "Finding my mind…" }
        do {
            let (client, health): (MindClient, MindHealth)
            if let a = await runner.attach() { (client, health) = a }
            else {
                if !model.setup { model.line = "Setting up my mind (first time, about a minute)…" }
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
            if model.setup { return }   // the setup card is up; afterSetup() takes it from here
            if health.isHungry { showHungry() } else { rest() }
        } catch {
            log("mind error \(error)")
            model.hungry = true
            if model.setup { return }
            model.posture = .needsYou; model.line = "I can't find my mind."
        }
    }

    func showHungry() {
        model.hungry = true
        guard !model.setup else { return }
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
        guard !model.setup else { return }
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
        guard mode == nil, !model.setup else { return }
        guard await Ears.authorize() else { log("key \(m) but not allowed to hear"); showSetup(reason: "I can't hear you yet. Allow the two things below and try the key again."); return }
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
            guard Dictation.trusted(prompt: false) else {
                log("dictate but not allowed to type"); showSetup(reason: "I heard you, but I'm not allowed to type yet. Allow it below and try again."); return
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
                log("screen error \(error)")
                if Powers.state(.screen) != .granted { showSetup(reason: "I can't see your screen yet. Allow it below and ask again.") }
                else { model.posture = .needsYou; model.line = "I couldn't read that window." }
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
        menu.addItem(withTitle: "Set up what I'm allowed to do…", action: #selector(menuSetup), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Sign in to my mind…", action: #selector(menuSignIn), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Connect Claude Code (answer its prompts here)", action: #selector(menuConnectClaude), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Keep my mind running at login", action: #selector(menuInstallService), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open my folder", action: #selector(menuOpenFolder), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit OpenRappter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
        statusItem = item
    }

    @objc func menuSetup() { showSetup(reason: "Here's what I'm allowed to do right now.") }
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
        if let s = env["OPENRAPPTER_HOLD"], let secs = Double(s) { try? await Task.sleep(for: .seconds(secs)) }
        if env["OPENRAPPTER_DEMO_EXIT"] == "1" { log("done"); NSApp.terminate(nil) }
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = Coordinator()
    app.delegate = delegate
    app.run()
}
