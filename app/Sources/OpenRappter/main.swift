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
    var serviceItem: NSMenuItem?
    var needsSub: Any?
    var runner: MindRunner!
    var kernelProcess: Process?
    var setupWatch: Task<Void, Never>?
    /// One turn at a time: a key press begins a new one and every older tail checks before touching the model.
    var turns = Turns()
    var gate = PressGate()
    var finding = false
    var signInURL: URL?
    var spokenNeed: String?
    var setupLine = ""
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
        model.onSignInAgain = { [weak self] in self?.signInAgain() }
        model.onTryAgain = { [weak self] in Task { await self?.findMind() } }
        model.onInstallTools = { [weak self] in self?.installTools() }
        model.onToolsLater = { [weak self] in self?.model.toolsMissing = false; self?.settle() }
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

    /// A kernel started as the app's child goes with the app. The opt-in login service is the way to keep one running.
    func applicationWillTerminate(_ notification: Notification) {
        if let p = kernelProcess, p.isRunning { log("stopping the kernel I started (pid \(p.processIdentifier))"); p.terminate() }
    }

    // MARK: first run: the four powers

    func refreshPowers() { model.powers = Powers.states(fake: env["OPENRAPPTER_SETUP_FAKE"]) }

    func showSetup(reason: String? = nil) {
        refreshPowers()
        model.setup = true
        model.posture = .needsYou
        model.line = reason ?? "A minute of setup and I can hear you, type for you and see your screen."
        setupLine = model.line
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
        let id = turns.begin()
        model.posture = .speaking; model.line = "All set. Hold ⌥ Space and talk to me."
        await voice.speak("All set. Hold option space and talk to me.")
        try? await Task.sleep(for: .seconds(1))
        guard turns.isLive(id) else { return }
        afterSetup()
    }

    func setupLater() {
        setupWatch?.cancel(); model.setup = false
        UserDefaults.standard.set(true, forKey: "setupSeen")
        log("setup later")
        afterSetup()
    }

    func afterSetup() { if model.hungry || model.mindMissing || model.toolsMissing { showHungry() } else { settle() } }

    // MARK: mind

    /// Attach to a running mind, or start the pinned kernel. Starting the login service is the person's choice
    /// (the menu); here the kernel runs as a child of the app unless that service is already installed.
    func findMind() async {
        guard !finding else { return }
        finding = true; defer { finding = false }
        model.mindMissing = false; model.toolsMissing = false
        if !model.setup { model.posture = .thinking; model.line = "Finding my mind…" }
        var started = false
        do {
            let (client, health): (MindClient, MindHealth)
            if let a = await runner.attach() { (client, health) = a }
            else {
                let missing = MindRunner.missingTools()
                if !missing.isEmpty {
                    log("tools missing \(missing)")
                    model.toolsMissing = true
                    if !model.setup { showToolsMissing() }   // under the setup card, afterSetup() shows it
                    return
                }
                started = true
                if !model.setup {
                    model.line = "Setting up my mind. The first time takes a few minutes…"
                    await notch.expand()
                    await voice.speak("Setting up my mind. The first time takes a few minutes.")
                }
                if runner.serviceInstalled { log("kernel service installed; waiting for it") }
                else { kernelProcess = try runner.launch() }
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
            if health.isHungry { showHungry() }
            else {
                if started { model.posture = .speaking; model.line = "My mind is ready."; await voice.speak("My mind is ready.") }
                settle()
            }
        } catch {
            log("mind error \(error)")
            mind = nil
            if model.setup { model.mindMissing = true; return }
            showMindMissing(started ? "I couldn't start my mind. Try again; if it keeps happening, the log is in my folder."
                                    : "I can't find my mind. Try again in a moment.")
        }
    }

    /// The card for a mind that needs the person: no tools, no mind, or no sign-in.
    func showHungry() {
        guard !model.setup else { return }
        if model.toolsMissing { showToolsMissing(); return }
        if mind == nil { showMindMissing("I can't find my mind. Try again in a moment."); return }
        let wasUp = model.hungry && model.posture == .needsYou && model.need == nil
        model.hungry = true
        if let top = needs.top { showNeed(top); return }   // someone is waiting on that answer; the sign-in can wait
        model.posture = .needsYou
        model.line = "I can't think until you sign me in with GitHub."
        Task { await notch.expand() }
        if !wasUp { Task { await voice.speak("I can't think until you sign me in with GitHub.") } }
    }

    func showMindMissing(_ line: String) {
        model.mindMissing = true
        if let top = needs.top { showNeed(top); return }
        model.posture = .needsYou
        model.line = line
        Task { await notch.expand(); await voice.speak(line) }
    }

    func showToolsMissing() {
        model.toolsMissing = true
        if let top = needs.top { showNeed(top); return }
        model.posture = .needsYou
        model.line = "Press Install and let Apple finish. Then hold ⌥ Space and I'll try again."
        Task {
            await notch.expand()
            await voice.speak("I need Apple's command line tools to think. Press Install and let Apple finish, then hold option space and I'll try again.")
        }
    }

    func installTools() {
        log("xcode-select --install")
        MindRunner.installCommandLineTools()
        model.line = "Apple is installing them. When it's done, hold ⌥ Space and I'll try again."
    }

    func signIn() {
        guard let mind else { Task { await findMind() }; return }
        let id = turns.begin()
        guard model.hungry else {
            model.posture = .speaking; model.line = "I'm already signed in. Hold ⌥ Space and talk to me."
            Task { await notch.expand(); await voice.speak("I'm already signed in. Hold option space and talk to me."); if turns.isLive(id) { settle() } }
            return
        }
        Task { @MainActor in
            let s: SignIn
            do { s = try await mind.beginSignIn() } catch {
                log("sign-in failed to start: \(error)")
                model.line = "I couldn't start the sign-in. Is my mind awake? Try again in a moment."
                await voice.speak(model.line)
                return
            }
            let pb = NSPasteboard.general
            let saved = pb.string(forType: .string)
            pb.clearContents(); pb.setString(s.code, forType: .string)
            func restoreClipboard() {
                guard pb.string(forType: .string) == s.code else { return }   // they copied something newer; leave it
                pb.clearContents()
                if let saved { pb.setString(saved, forType: .string) }
            }
            signInURL = s.url
            model.signInCode = s.code
            model.line = "I copied this code. Paste it on the GitHub page I just opened, then approve. I'll put back what you had copied."
            log("sign-in code \(s.code) copied; opening \(s.url)")
            NSWorkspace.shared.open(s.url)
            await voice.speak("I opened GitHub and copied a code for you. Paste it there and approve. The code is \(SpokenCode.spell(s.code)).", slow: true)
            for _ in 0..<450 {   // GitHub codes live 15 minutes
                try? await Task.sleep(for: .seconds(2))
                if !model.hungry { restoreClipboard(); return }   // fed some other way (menu, restart)
                if let h = try? await mind.health(), !h.isHungry {
                    model.hungry = false; model.signInCode = nil; restoreClipboard(); log("fed: signed in")
                    guard turns.isLive(id) else { return }
                    model.line = "Signed in. Hold ⌥ Space and talk to me."
                    model.posture = .speaking; await voice.speak("Thanks, I'm signed in. Hold option space and talk to me.")
                    if turns.isLive(id) { settle() }
                    return
                }
            }
            model.signInCode = nil; restoreClipboard()
            guard turns.isLive(id) else { return }
            model.line = "That code ran out. Press Sign in with GitHub for a fresh one."
            await voice.speak("That code ran out. Press Sign in with GitHub for a fresh one.")
        }
    }

    /// Reopen the GitHub page with the same code; nothing is copied again.
    func signInAgain() { if let signInURL { NSWorkspace.shared.open(signInURL) } else { signIn() } }

    func rest() {
        guard !model.setup else { return }
        model.posture = .idle
        model.line = "Hold ⌥ Space and talk to me."
        Task { await notch.compact() }
    }

    /// Every turn ends here: a waiting need comes first, then the setup card, then rest.
    func settle() {
        model.posture = .idle
        if let top = needs.top { showNeed(top); return }
        model.need = nil
        if model.setup { model.posture = .needsYou; model.line = setupLine; Task { await notch.expand() }; return }
        rest()
    }

    var busy: Bool { mode != nil || [.listening, .thinking, .speaking].contains(model.posture) }

    // MARK: hold-to-talk

    func installHotKeys() {
        let hk = HotKeys.shared
        hk.register(id: 1, keyCode: HotKeys.space, modifiers: HotKeys.option) { [weak self] down in self?.key(.ask, down) }
        hk.register(id: 2, keyCode: HotKeys.space, modifiers: HotKeys.option | HotKeys.control) { [weak self] down in self?.key(.dictate, down) }
        hk.register(id: 3, keyCode: HotKeys.space, modifiers: HotKeys.option | HotKeys.shift) { [weak self] down in self?.key(.screen, down) }
    }

    /// Hold to talk; a tap under 300 ms keeps listening on until the next tap (for Voice Control).
    func key(_ m: Mode, _ down: Bool) {
        switch down ? gate.keyDown() : gate.keyUp() {
        case .start: Task { await beginListening(m) }
        case .stop: Task { await endListening() }
        case .latch: log("tap: listening stays on until the next tap")
        case .ignore: break
        }
    }

    func beginListening(_ m: Mode) async {
        guard mode == nil else { return }
        let id = turns.begin()
        voice.stop()
        guard await Ears.authorize() else {
            gate.reset()
            log("key \(m) but not allowed to hear"); showSetup(reason: "I can't hear you yet. Allow the two things below and try the key again."); return
        }
        // The key may have come up while the permission wait was on; then nothing may start.
        guard turns.isLive(id), gate.wantsListening, mode == nil else { log("key \(m) released before I could listen"); return }
        mode = m
        model.posture = .listening
        model.line = m == .dictate ? "Listening… I'll type it where your cursor is." : "Listening…"
        ears.onPartial = { [weak self] t in self?.model.line = t }
        do { try ears.start() } catch {
            log("ears error \(error)")
            mode = nil; gate.reset()
            model.posture = .needsYou; model.line = "I can't hear you right now. Is a microphone plugged in?"
            await notch.expand()
            await voice.speak(model.line)
            try? await Task.sleep(for: .seconds(2))
            if turns.isLive(id) { settle() }
            return
        }
        await notch.expand()
        log("listening mode=\(m) onDevice=\(ears.onDevice)")
    }

    func endListening() async {
        guard let m = mode else { return }   // nothing started (the key came up during the permission wait)
        let heard = await ears.stop()
        mode = nil
        log("heard \(heard.debugDescription)")
        await act(m, heard, turn: turns.current)
    }

    func act(_ m: Mode, _ heard: String, turn id: Int) async {
        guard !heard.isEmpty else { settle(); return }
        switch m {
        case .ask:
            await ask(heard, screen: nil, turn: id)
        case .dictate:
            guard Dictation.trusted(prompt: false) else {
                log("dictate but not allowed to type"); showSetup(reason: "I heard you, but I'm not allowed to type yet. Allow it below and try again."); return
            }
            model.posture = .speaking; model.line = heard
            let how = await Dictation.paste(heard)
            log("typed \(heard.count) chars via \(how) trusted=\(AXIsProcessTrusted()) canPost=\(CGPreflightPostEventAccess())")
            try? await Task.sleep(for: .seconds(1))
            if turns.isLive(id) { settle() }
        case .screen:
            model.posture = .thinking; model.line = "Reading your screen…"
            do {
                let (app, text) = try await Eyes.frontWindowText()
                log("screen app=\(app) chars=\(text.count)")
                guard turns.isLive(id) else { return }
                await ask(heard, screen: "The user is looking at \(app). Text on that window:\n\(text.prefix(6000))", turn: id)
            } catch {
                log("screen error \(error)")
                guard turns.isLive(id) else { return }
                if Powers.state(.screen) != .granted { showSetup(reason: "I can't see your screen yet. Allow it below and ask again.") }
                else {
                    model.posture = .needsYou; model.line = "I couldn't read that window."
                    await voice.speak(model.line); try? await Task.sleep(for: .seconds(2))
                    if turns.isLive(id) { settle() }
                }
            }
        }
    }

    func ask(_ question: String, screen: String?, turn id: Int) async {
        if mind == nil {
            if finding {
                model.posture = .thinking; model.line = "Still setting up my mind. Give me a moment."
                await notch.expand(); await voice.speak(model.line); return
            }
            await findMind()   // shows the right card (tools, no mind, sign in) when it cannot
            guard turns.isLive(id) else { return }
        }
        guard let mind else { return }
        if model.hungry { showHungry(); return }
        model.posture = .thinking; model.line = question
        await notch.expand()
        let msg = "\(question)\n\n\(screen.map { $0 + "\n\n" } ?? "")Answer in under 60 words, then end with |||VOICE||| and a one or two sentence spoken version."
        do {
            let reply = try await mind.chat(msg, sessionId: sessionId, history: history)
            sessionId = reply.sessionId ?? sessionId
            history.append(["role": "user", "content": question]); history.append(["role": "assistant", "content": reply.text])
            if history.count > 20 { history.removeFirst(2) }
            guard turns.isLive(id) else { log("reply for an older turn dropped"); return }
            model.posture = .speaking; model.line = reply.text
            log("reply \(reply.text.debugDescription) voice=\(reply.voice.debugDescription)")
            await voice.speak(reply.voice.isEmpty ? reply.text : reply.voice)
            try? await Task.sleep(for: .seconds(2))
            if turns.isLive(id) { settle() }
        } catch MindError.hungry(let why) {
            log("hungry \(why)"); if turns.isLive(id) { showHungry() }
        } catch {
            log("ask error \(error)")
            guard turns.isLive(id) else { return }
            self.mind = nil   // Try again looks for it afresh
            showMindMissing("My mind went quiet. Try again in a moment.")
        }
    }

    // MARK: needs

    /// A need shows as soon as the creature is not mid-turn; a turn's end (settle) shows what arrived meanwhile.
    func showNextNeedOrRest() {
        if busy { return }
        if let top = needs.top { showNeed(top) }
        else if model.need != nil { model.need = nil; settle() }
    }

    func showNeed(_ top: Need) {
        if model.need?.id != top.id { log("need \(top.id) \(top.title.debugDescription)") }
        model.need = top
        model.posture = .needsYou
        model.line = top.title
        Task { await notch.expand() }
        if spokenNeed != top.id { spokenNeed = top.id; Task { await voice.speak(top.title) } }
    }

    func answer(_ need: Need, _ opt: NeedOption) {
        needs.answer(need, opt)
        log("answered \(need.id) \(opt.label.debugDescription) action=\(opt.action ?? "-")")
        if let a = opt.action, a.hasPrefix("open:"), let u = URL(string: String(a.dropFirst(5))) { NSWorkspace.shared.open(u) }
        showNextNeedOrRest()   // shows the next need, or settles the answered one away
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
        let service = NSMenuItem(title: "Keep my mind running at login", action: #selector(menuToggleService), keyEquivalent: "")
        service.target = self; menu.addItem(service); serviceItem = service
        refreshServiceItem()
        menu.addItem(withTitle: "Open my folder", action: #selector(menuOpenFolder), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit OpenRappter", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
        statusItem = item
    }

    func refreshServiceItem() {
        serviceItem?.title = runner.serviceInstalled ? "Stop keeping my mind running at login" : "Keep my mind running at login"
    }

    @objc func menuSetup() { showSetup(reason: "Here's what I'm allowed to do right now.") }
    @objc func menuSignIn() { if mind == nil { Task { await findMind() } } else { signIn() } }
    @objc func menuOpenFolder() { NSWorkspace.shared.open(home) }
    @objc func menuToggleService() {
        let id = turns.begin()
        var relaunch = false
        if runner.serviceInstalled {
            do { try runner.uninstallService(); model.line = "I stopped keeping my mind running at login."; relaunch = true }
            catch { model.line = "Couldn't stop that: \(error.localizedDescription)" }
        } else {
            do { try runner.installService(); model.line = "My mind now starts at login and keeps running." }
            catch { model.line = "Couldn't set that up: \(error.localizedDescription)" }
        }
        refreshServiceItem()
        model.posture = .speaking
        Task {
            await notch.expand(); await voice.speak(model.line)
            try? await Task.sleep(for: .seconds(2))
            guard turns.isLive(id) else { return }
            if relaunch { mind = nil; await findMind() } else { settle() }
        }
    }
    @objc func menuConnectClaude() {
        let id = turns.begin()
        let result = ClaudeCodeHook.install(from: Bundle.main.resourceURL ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath))
        model.posture = .speaking; model.line = result
        log("connect claude: \(result)")
        Task { await notch.expand(); await voice.speak(result); try? await Task.sleep(for: .seconds(3)); if turns.isLive(id) { settle() } }
    }

    // MARK: proofs driven from outside (no microphone needed)

    func runEnvDrivenProofs() async {
        if env["OPENRAPPTER_SIGNIN"] == "1", model.hungry { signIn() }   // proof: press "Sign in with GitHub" from the environment
        if let q = env["OPENRAPPTER_SAY"] { await act(.ask, q, turn: turns.begin()) }
        if let t = env["OPENRAPPTER_DICTATE"] { await act(.dictate, t, turn: turns.begin()) }
        if let q = env["OPENRAPPTER_SCREEN_ASK"] { await act(.screen, q, turn: turns.begin()) }
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
