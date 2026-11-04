import Foundation

public enum TalkMode: Equatable, Sendable { case ask, dictate, screen }
public enum CreatureFailure: Error, Equatable, Sendable { case unavailable, hungry, noCopilot, toolsMissing, nothingToRead }
public enum CreatureLane: Hashable { case lookup, retry, login, turn, notice, other }
public enum CreatureWake: Equatable {
    case rest(Int), poll(Int), retry(Int), notice(Int)
}

public enum CreatureEvent: Equatable {
    case findMind
    case found(Int, Result<MindHealth, CreatureFailure>)
    case findingProgress(Int)
    case signIn
    case loginStarted(Int, Result<LoginCode, CreatureFailure>)
    case loginPolled(Int, Result<LoginProgress, CreatureFailure>)
    case loginConfirmed(Int, Result<MindHealth, CreatureFailure>)
    case keyDown(TalkMode), keyUp(TalkMode)
    case authorized(Int, HearingPermission)
    case earsStarted(Int, Bool)
    case hearingFailed(Int, HearingFailure)
    case partial(Int, String), heard(Int, String)
    case submit(TalkMode, String)
    case screenRead(Int, Result<String, CreatureFailure>)
    case dictated(Int, Bool)
    case replied(Int, Result<MindReply, CreatureFailure>)
    case spoken(Int), wake(CreatureWake)
    case needsChanged([Need])
    case answer(Need, NeedOption), later(Need)
    case installAtLogin, installedAtLogin(Int, Result<LoginItemResult, CreatureFailure>)
    case checkedLoginItem(Result<LoginItemResult, CreatureFailure>), stoppedAtLogin(Bool)
    case stopAtLogin, showHelp, connectedHelper(Bool), moveToApplications
    case showInput, draftChanged(Bool), dismissLine, showPermission(CreatureStateMachine.Permission), goToSleep, sleepFailed, shutdown
}

public enum HearingPermission: Equatable { case allowed, microphone, speech }
public enum HearingFailure: Equatable { case recognizerUnavailable, recognitionFailed }

public struct LoginCode: Equatable, Sendable {
    public let code: String
    public let url: URL
    public init(code: String, url: URL) { self.code = code; self.url = url }
}

public struct LoginProgress: Equatable, Sendable {
    public let status: String
    public let error: String?
    public init(status: String, error: String? = nil) { self.status = status; self.error = error }
    public var noCopilot: Bool { error?.uppercased().contains("NO_COPILOT_ACCESS") == true }
    public var denied: Bool { error?.lowercased().contains("access_denied") == true }
    public var lost: Bool { error?.lowercased().contains("no login in progress") == true }
    public var expired: Bool {
        status.lowercased() == "expired" ||
            error?.lowercased().contains("expired_token") == true ||
            error?.lowercased().contains("code expired") == true ||
            error?.lowercased().contains("code has expired") == true
    }
}

public enum CreatureEffect: Equatable {
    case cancel(CreatureLane)
    case findMind(Int), startLogin(Int), pollLogin(Int), confirmLogin(Int)
    case showCode(LoginCode), restoreClipboard
    case authorize(Int), startEars(Int), stopEars(Int), cancelEars, stopVoice
    case chat(Int, String, String?, [[String: String]])
    case readScreen(Int, String), dictate(Int, String), speak(Int, String)
    case wait(TimeInterval, CreatureWake)
    case open(URL), answer(Need, NeedOption), later(Need)
    case installAtLogin(Int), stopAtLogin, installTools, quit

    public var lane: CreatureLane {
        switch self {
        case .findMind: return .lookup
        case .startLogin, .pollLogin, .confirmLogin: return .login
        case .authorize, .startEars, .stopEars, .chat, .readScreen, .dictate, .speak: return .turn
        case .wait(_, .rest): return .turn
        case .wait(_, .poll): return .login
        case .wait(_, .retry): return .retry
        case .wait(_, .notice): return .notice
        default: return .other
        }
    }
}

public struct CreaturePresentation: Equatable {
    public var posture: Posture = .idle
    public var line = "Hold Option and Space and talk to me."
    public var need: Need?
    public var hungry = false
    public var expanded = false
    public var canDismissLine = false
    public var acceptsInput = true
}

/// A value-only reducer. All waiting and Mac work is returned as effects, never performed here.
public struct CreatureStateMachine {
    private enum MindState { case missing, finding, hungry, noCopilot, ready, toolsMissing }
    private enum TurnStage { case authorizing, starting, listening, transcribing, reading, typing, asking, speaking, settling }
    private struct Turn {
        var id: Int
        var mode: TalkMode
        var stage: TurnStage
        var line: String
        var released = false
        var question = ""
    }
    private struct Login {
        var id: Int
        var code: LoginCode?
        var polls = 0
        var failures = 0
        var restarts = 0
        var confirming = false
        var hidden = false
        var questionWaiting = false
    }
    private enum NoticeTarget: Equatable { case line(String), card(Need) }
    public private(set) var presentation = CreaturePresentation()
    public private(set) var history: [[String: String]] = []
    public private(set) var sessionId: String?
    public var isWorking: Bool { !stopped && (sleeping || mind == .finding || turn != nil || loginSetupID != nil) }
    private var mind: MindState = .missing
    private var lookupID = 0
    private var lookupTakingTime = false
    private var serial = 0
    private var turn: Turn?
    private var login: Login?
    private var needs: [Need] = []
    private var blocked: Need?
    private var deferredStartup: Need?
    private var quiet = true
    private var signInAfterFinding = false
    private var reattachBeforeLogin = false
    private var loginSetupID: Int?
    private var notice: String?
    private var noticeTarget: NoticeTarget?
    private var noticeID = 0
    private var hiddenPermissions: Set<String> = []
    private var resumeStartupAfterTools = false
    private var hasDraft = false
    private var sleeping = false
    private var stopped = false
    public init() {}

    private mutating func nextID() -> Int { serial += 1; return serial }

    @discardableResult
    public mutating func send(_ event: CreatureEvent) -> [CreatureEffect] {
        guard !stopped else { return [] }
        if sleeping && event != .sleepFailed && event != .shutdown { return [] }
        var effects = reduce(event)
        render()
        let target: NoticeTarget?
        if turn == nil, !hasDraft, !sleeping, !stopped {
            if let need = presentation.need, need.id != "creature:signing-in",
               need.source == "openrappter", need.id.hasPrefix("creature:") || need.isOptionalPermission {
                target = .card(need)
            } else if presentation.need == nil, let notice {
                target = .line(notice)
            } else { target = nil }
        } else { target = nil }
        let requestedAgain: Bool
        switch event {
        case .showInput, .showHelp, .showPermission: requestedAgain = true
        default: requestedAgain = false
        }
        if target != noticeTarget || (requestedAgain && target != nil) {
            if noticeTarget != nil { effects.append(.cancel(.notice)) }
            noticeTarget = target
            noticeID = nextID()
            if target != nil { effects.append(.wait(8, .notice(noticeID))) }
        }
        return effects
    }

    private mutating func reduce(_ event: CreatureEvent) -> [CreatureEffect] {
        switch event {
        case .findMind:
            return beginFinding()
        case .findingProgress(let id):
            guard id == lookupID, mind == .finding else { return [] }
            lookupTakingTime = true
            return []
        case .found(let id, let result):
            guard id == lookupID, mind == .finding else { return [] }
            switch result {
            case .success(let health):
                mind = health.copilot == "no_access" ? .noCopilot : health.isHungry ? .hungry : .ready
                if blocked?.id == "creature:question-waiting" {
                    blocked = nil
                    if mind == .ready { notice = "I'm ready now. Please ask your question again." }
                }
                if signInAfterFinding {
                    signInAfterFinding = false
                    if mind != .ready { return beginLogin() }
                }
                return []
            case .failure(let failure):
                mind = failure == .toolsMissing ? .toolsMissing : .missing
                if blocked?.id == "creature:question-waiting" { blocked = nil }
                signInAfterFinding = false
                return failure == .toolsMissing ? [] : [.wait(30, .retry(id))]
            }
        case .signIn:
            quiet = false
            blocked = nil
            login?.hidden = false
            if let code = login?.code { return [.showCode(code)] }
            if login != nil { return [] }
            if reattachBeforeLogin || mind == .missing || mind == .finding || mind == .toolsMissing {
                reattachBeforeLogin = false
                signInAfterFinding = true
                return mind == .finding ? [] : beginFinding()
            }
            return beginLogin()
        case .loginStarted(let id, let result):
            guard login?.id == id else { return [] }
            switch result {
            case .success(let code):
                login?.code = code
                return [.showCode(code), .wait(2, .poll(id))]
            case .failure(let error):
                if error == .noCopilot { mind = .noCopilot }
                return failLogin(error == .noCopilot ? Self.copilotWords :
                    "I couldn't start the sign-in. Choose Sign me in to try again; if it keeps happening, choose Restart OpenRappter.")
            }
        case .loginPolled(let id, let result):
            guard login?.id == id else { return [] }
            login?.polls += 1
            if (login?.polls ?? 0) >= 450 { return failLogin("I stopped waiting. Choose Sign me in to try again.") }
            guard case .success(let progress) = result else {
                if case .failure(.noCopilot) = result {
                    mind = .noCopilot
                    return failLogin(Self.copilotWords)
                }
                login?.failures += 1
                if (login?.failures ?? 0) < 10 { return [.wait(2, .poll(id))] }
                return failLogin("I couldn't check your sign-in. Choose Sign me in to try again.")
            }
            login?.failures = 0
            if progress.noCopilot { mind = .noCopilot; return failLogin(Self.copilotWords) }
            if progress.denied { return failLogin("You cancelled on GitHub. Choose Sign me in to try again.") }
            if progress.lost, login?.restarts == 0 {
                login?.restarts = 1
                login?.code = nil
                return [.restoreClipboard, .startLogin(id)]
            }
            if progress.expired { return failLogin("That code expired. Choose Sign me in for a fresh one.") }
            switch progress.status.lowercased() {
            case "ok", "success": login?.confirming = true; return [.confirmLogin(id)]
            case "expired": return failLogin("That code expired. Choose Sign me in for a fresh one.")
            case "error": return failLogin("GitHub couldn't finish signing you in. Choose Sign me in to try again.")
            case "pending":
                return [.wait(2, .poll(id))]
            default:
                return failLogin("I couldn't read the sign-in answer. Choose Sign me in to try again.")
            }
        case .loginConfirmed(let id, let result):
            guard login?.id == id, login?.confirming == true else { return [] }
            login?.confirming = false
            guard case .success(let health) = result else {
                return failLogin("I couldn't check your sign-in. Choose Sign me in to try again.")
            }
            if health.copilot == "no_access" { mind = .noCopilot; return failLogin(Self.copilotWords) }
            guard !health.isHungry else { return [.wait(2, .poll(id))] }
            login = nil; blocked = nil; mind = .ready
            notice = "You're signed in. I'm ready to help."
            // Queued cards are projected immediately, not at the next folder tick.
            return [.cancel(.login), .restoreClipboard]
        case .keyDown(let mode):
            if let turn, turn.stage != .speaking && turn.stage != .settling {
                if turn.stage == .asking {
                    self.turn?.line = "Still thinking about your last question."
                } else if turn.stage == .typing {
                    self.turn?.line = "Still typing your words."
                } else if turn.stage == .reading {
                    self.turn?.line = "Still reading your screen."
                } else if turn.stage == .transcribing {
                    self.turn?.line = "Still finishing your words."
                }
                return []
            }
            let id = nextID()
            notice = nil
            turn = Turn(id: id, mode: mode, stage: .authorizing, line: "Getting ready to listen.")
            blocked = nil
            return [.cancel(.turn), .stopVoice, .authorize(id)]
        case .keyUp(let mode):
            guard var current = turn, current.mode == mode else { return [] }
            switch current.stage {
            case .authorizing, .starting:
                current.released = true; turn = current
                return []
            case .listening:
                current.stage = .transcribing; current.line = "Finishing your words."; turn = current
                return [.stopEars(current.id)]
            default: return []
            }
        case .authorized(let id, let permission):
            guard let current = turn, current.id == id, current.stage == .authorizing else { return [] }
            guard permission == .allowed else {
                turn = nil
                blocked = Self.permissionCard(permission == .microphone ? .microphone : .speech)
                return []
            }
            if current.released {
                turn = nil
                notice = "Ready. Hold Option and Space again to talk."
                return []
            }
            turn?.stage = .starting
            return [.startEars(id)]
        case .earsStarted(let id, let success):
            guard let current = turn, current.id == id, current.stage == .starting else { return [] }
            guard success else {
                turn = nil
                blocked = Self.card("microphone-unavailable", "I can't hear a microphone. Choose Open Sound, pick an input, then try again.",
                                    "Open Sound", "open:x-apple.systempreferences:com.apple.Sound-Settings.extension")
                return []
            }
            if current.released { turn?.stage = .transcribing; return [.stopEars(id)] }
            turn?.stage = .listening
            turn?.line = current.mode == .dictate ? "Listening. I'll type it where your cursor is." : "Listening."
            return []
        case .hearingFailed(let id, let failure):
            guard let current = turn, current.id == id,
                  current.stage == .starting || current.stage == .transcribing else { return [] }
            turn = nil
            notice = failure == .recognizerUnavailable
                ? "Speech recognition isn't available right now. Hold Option and Space to try again, or choose Type to me."
                : "I couldn't turn your speech into words. Hold Option and Space to try again, or choose Type to me."
            return [.cancelEars]
        case .partial(let id, let text):
            guard turn?.id == id, turn?.stage == .listening else { return [] }
            turn?.line = text
            return []
        case .heard(let id, let text):
            guard let current = turn, current.id == id, current.stage == .transcribing else { return [] }
            return act(id: id, mode: current.mode, text: text)
        case .submit(let mode, let text):
            if mode == .ask, Self.isSleepCommand(text) { return reduce(.goToSleep) }
            if let turn, turn.stage != .speaking && turn.stage != .settling { return [] }
            let id = nextID()
            hasDraft = false
            notice = nil
            blocked = nil
            turn = Turn(id: id, mode: mode, stage: .asking, line: text)
            return [.cancel(.turn), .stopVoice] + act(id: id, mode: mode, text: text)
        case .screenRead(let id, let result):
            guard turn?.id == id, turn?.stage == .reading else { return [] }
            switch result {
            case .success(let text):
                return ask(id: id, question: turn?.question ?? "", screen: text)
            case .failure(.nothingToRead):
                turn = nil
                blocked = Self.card("no-window", "I don't see a window to read. Bring one to the front and try again.",
                                    "Got it", "creature:dismiss")
                return []
            case .failure:
                turn = nil; blocked = Self.permissionCard(.screen)
                return []
            }
        case .dictated(let id, let success):
            guard turn?.id == id, turn?.stage == .typing else { return [] }
            guard success else { turn = nil; blocked = Self.permissionCard(.typing); return [] }
            let words = turn?.question ?? ""
            turn?.line = words
            turn?.stage = .settling
            return [.wait(1, .rest(id))]
        case .replied(let id, let result):
            guard let current = turn, current.id == id, current.stage == .asking else { return [] }
            switch result {
            case .success(let reply):
                sessionId = reply.sessionId ?? sessionId
                history += [["role": "user", "content": current.question], ["role": "assistant", "content": reply.text]]
                if history.count > 20 { history.removeFirst(history.count - 20) }
                turn?.stage = .speaking; turn?.line = reply.text
                return [.speak(id, reply.voice.isEmpty ? reply.text : reply.voice)]
            case .failure(let error):
                turn = nil; quiet = false
                if error == .noCopilot { mind = .noCopilot; blocked = nil }
                else if error == .hungry { mind = .hungry; blocked = nil }
                else {
                    blocked = Self.card("retry-mind", "I couldn't reach my mind. Choose Find my mind to try again.",
                                        "Find my mind", "creature:find")
                }
                return []
            }
        case .spoken(let id):
            guard turn?.id == id, turn?.stage == .speaking else { return [] }
            turn?.stage = .settling
            return [.wait(2, .rest(id))]
        case .wake(.rest(let id)):
            guard let current = turn, current.id == id, current.stage == .settling else { return [] }
            notice = current.mode == .dictate ? "Typed it. \(current.line)" : current.line
            turn = nil
            return []
        case .wake(.poll(let id)):
            return login?.id == id ? [.pollLogin(id)] : []
        case .wake(.retry(let id)):
            guard lookupID == id, mind == .missing else { return [] }
            guard turn == nil, login == nil, blocked == nil,
                  needs.allSatisfy(\.isOptionalPermission), loginSetupID == nil else {
                return [.wait(30, .retry(id))]
            }
            let wasQuiet = quiet
            let effects = beginFinding()
            quiet = wasQuiet
            return effects
        case .wake(.notice(let id)):
            guard id == noticeID, noticeTarget != nil else { return [] }
            notice = nil
            deferredStartup = nil
            if case .card(let card) = noticeTarget {
                if blocked?.id == card.id { blocked = nil }
                if card.isOptionalPermission { hiddenPermissions.insert(card.id) }
            }
            let permissions = needs.filter(\.isOptionalPermission)
            hiddenPermissions.formUnion(permissions.map(\.id))
            needs.removeAll(where: \.isOptionalPermission)
            quiet = true
            return permissions.map { .later($0) }
        case .needsChanged(let cards):
            needs = cards
            return []
        case .answer(let need, let option):
            let queued = needs.contains { $0.id == need.id }
            needs.removeAll { $0.id == need.id }
            if deferredStartup?.id == need.id { deferredStartup = nil }
            if need.id.hasPrefix("creature:") {
                switch option.action {
                case "creature:sleep": return reduce(.goToSleep)
                case "creature:find":
                    return resumeStartupAfterTools ? reduce(.installAtLogin) : beginFinding()
                case "creature:sign-in": return reduce(.signIn)
                case "creature:install-login": return reduce(.installAtLogin)
                case "creature:show-code": return login?.code.map { [.showCode($0)] } ?? []
                case "creature:cancel-login":
                    login = nil; quiet = true; blocked = nil
                    return [.cancel(.login), .restoreClipboard]
                case "creature:install-tools": return [.installTools]
                default:
                    blocked = nil; quiet = true
                    let effects: [CreatureEffect] = queued ? [.answer(need, option)] : []
                    if let action = option.action, action.hasPrefix("open:"),
                       let url = URL(string: String(action.dropFirst(5))) { return effects + [.open(url)] }
                    return effects
                }
            }
            var effects: [CreatureEffect] = [.answer(need, option)]
            if let action = option.action, action.hasPrefix("open:"),
               let url = URL(string: String(action.dropFirst(5))) { effects.append(.open(url)) }
            return effects
        case .later(let need):
            let queued = needs.contains { $0.id == need.id }
            needs.removeAll { $0.id == need.id }
            if deferredStartup?.id == need.id { deferredStartup = nil }
            if need.id.hasPrefix("creature:") {
                if need.id == "creature:signing-in", login != nil {
                    login?.hidden = true
                    return []
                }
                blocked = nil; quiet = true
                return queued ? [.later(need)] : []
            }
            return [.later(need)]
        case .installAtLogin:
            let id = nextID()
            deferredStartup = nil
            loginSetupID = id
            if blocked?.id == "creature:login-setting" || blocked?.id == "creature:tools" { blocked = nil }
            return [.installAtLogin(id)]
        case .installedAtLogin(let id, let result):
            guard loginSetupID == id else { return [] }
            loginSetupID = nil
            resumeStartupAfterTools = result == .failure(.toolsMissing)
            showLoginSetting(result, confirm: true)
            return []
        case .checkedLoginItem(let result):
            showLoginSetting(result, confirm: false)
            return []
        case .stopAtLogin:
            resumeStartupAfterTools = false
            return [.cancel(.retry), .stopAtLogin]
        case .stoppedAtLogin(let success):
            blocked = Self.card("login-setting", success ?
                "I'll stay for now and won't come back on my own when you sign in to this Mac." :
                "I couldn't turn off automatic starts. Choose Stop starting at login to try again.",
                "Got it", "creature:dismiss", dismiss: false)
            return mind == .missing ? [.wait(30, .retry(lookupID))] : []
        case .showHelp:
            blocked = Self.card("help", "Hold Option and Space to talk. Add Control to type for you, or Shift to ask about your screen.",
                                "Got it", "creature:dismiss", dismiss: false)
            return []
        case .connectedHelper(let success):
            blocked = Self.card("helper", success ? "Your coding helper's questions will appear here. Choose Got it to return." :
                "I couldn't connect your coding helper. Choose Restart OpenRappter, then try again.",
                                "Got it", "creature:dismiss", dismiss: false)
            return []
        case .moveToApplications:
            blocked = Self.card("move", "Move OpenRappter to your Applications folder, then open it there so I can return when you sign in.",
                                "Open Applications", "open:file:///Applications", dismiss: true)
            return []
        case .showInput:
            notice = "Type a question below, or type go to sleep to quit."
            return []
        case .draftChanged(let value):
            hasDraft = value
            return []
        case .showPermission(let permission):
            blocked = Self.permissionCard(permission)
            return []
        case .dismissLine:
            notice = nil
            return []
        case .goToSleep:
            sleeping = true; login = nil; turn = nil; loginSetupID = nil
            blocked = nil; notice = nil
            return [.cancel(.retry), .cancel(.lookup), .cancel(.login), .cancel(.turn), .cancel(.notice),
                    .restoreClipboard, .cancelEars, .stopVoice, .quit]
        case .sleepFailed:
            sleeping = false
            if mind == .finding { mind = .missing; signInAfterFinding = false }
            blocked = Self.card("sleep", "I couldn't go to sleep. Choose Try again to quit OpenRappter.",
                                "Try again", "creature:sleep")
            return []
        case .shutdown:
            stopped = true; login = nil; turn = nil; loginSetupID = nil
            return [.cancel(.retry), .cancel(.lookup), .cancel(.login), .cancel(.turn), .cancel(.notice),
                    .restoreClipboard, .cancelEars, .stopVoice]
        }
    }

    private mutating func beginFinding() -> [CreatureEffect] {
        let id = nextID()
        lookupID = id; lookupTakingTime = false; mind = .finding; blocked = nil; quiet = false; notice = nil
        turn = nil; login = nil
        return [.cancel(.lookup), .cancel(.retry), .cancel(.turn), .cancel(.login),
                .restoreClipboard, .cancelEars, .stopVoice, .findMind(id)]
    }

    private mutating func beginLogin() -> [CreatureEffect] {
        let id = nextID()
        login = Login(id: id); blocked = nil; notice = nil
        return [.cancel(.login), .restoreClipboard, .startLogin(id)]
    }

    private mutating func failLogin(_ words: String) -> [CreatureEffect] {
        login = nil
        blocked = Self.card("sign-in", words, "Sign me in", "creature:sign-in")
        reattachBeforeLogin = true
        return [.cancel(.login), .restoreClipboard]
    }

    private mutating func showLoginSetting(_ result: Result<LoginItemResult, CreatureFailure>, confirm: Bool) {
        let previous = blocked
        if !confirm { blocked = nil }
        switch result {
        case .failure(.toolsMissing):
            blocked = Self.toolsCard
        case .failure:
            blocked = Self.card("login-setting", "I couldn't set that up. Choose Try again; if it keeps happening, choose Restart OpenRappter.",
                                "Try again", "creature:install-login")
        case .success(.moveRequired):
            _ = reduce(.moveToApplications)
        case .success(.skipped):
            if confirm {
                blocked = Self.card("login-setting", "Automatic starts are turned off for this copy of OpenRappter.",
                                    "Got it", "creature:dismiss", dismiss: false)
            }
        case .success:
            if confirm {
                blocked = Self.card("login-setting", "My mind will be ready, and I'll come back when you sign in to this Mac.",
                                    "Got it", "creature:dismiss", dismiss: false)
            }
        }
        if !confirm {
            deferredStartup = blocked
            blocked = previous
        }
    }

    private mutating func act(id: Int, mode: TalkMode, text: String) -> [CreatureEffect] {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            turn = nil
            notice = "I didn't catch any words. Hold Option and Space and try again."
            return []
        }
        if mode == .ask, Self.isSleepCommand(text) { return reduce(.goToSleep) }
        turn?.question = text; turn?.line = text; turn?.stage = .asking
        switch mode {
        case .ask: return ask(id: id, question: text, screen: nil)
        case .screen: turn?.stage = .reading; turn?.line = "Reading your screen."; return [.readScreen(id, text)]
        case .dictate: turn?.stage = .typing; turn?.line = text; return [.dictate(id, text)]
        }
    }

    private mutating func ask(id: Int, question: String, screen: String?) -> [CreatureEffect] {
        guard mind == .ready else {
            turn = nil; quiet = false
            if login != nil {
                login?.questionWaiting = true
                login?.hidden = false
                return [.speak(id, "Your question hasn't been sent. Finish signing in, then ask again.")]
            }
            let words: String, label: String, action: String
            switch mind {
            case .finding:
                words = "I'm still finding my mind. Your question hasn't been sent. Please ask again when I'm ready."
                label = "Got it"; action = "creature:dismiss"
            case .hungry, .noCopilot:
                words = (mind == .noCopilot ? Self.copilotWords : "I can't think yet. Choose Sign me in to feed me.") +
                    " Your question hasn't been sent. Please ask again after signing in."
                label = "Sign me in"; action = "creature:sign-in"
            case .toolsMissing:
                words = Self.toolsCard.title + " Your question hasn't been sent. Please ask again when I'm ready."
                label = "Install"; action = "creature:install-tools"
            default:
                words = "I can't find my mind. Choose Find my mind to try again. Your question hasn't been sent; please ask again when I'm ready."
                label = "Find my mind"; action = "creature:find"
            }
            blocked = Self.card("question-waiting", words, label, action)
            return [.speak(id, words)]
        }
        turn?.stage = .asking
        let message = screen.map { "\(question)\n\n\($0)\n\nAnswer in under 60 words." } ??
            "\(question)\n\nAnswer in under 60 words, then end with |||VOICE||| and a one or two sentence spoken version."
        return [.chat(id, message, sessionId, history)]
    }

    private mutating func render() {
        var view = CreaturePresentation()
        if stopped {
            presentation = view
            return
        }
        if sleeping {
            view.line = "Going to sleep."
            view.expanded = true
            view.acceptsInput = false
            presentation = view
            return
        }
        if let notice { view.line = notice }
        view.hungry = mind == .hungry || mind == .noCopilot
        if let turn {
            view.posture = turn.stage == .listening ? .listening :
                (turn.stage == .speaking || turn.stage == .settling) ? .speaking : .thinking
            view.line = turn.line; view.expanded = true
            view.acceptsInput = turn.stage == .speaking || turn.stage == .settling
        } else {
            let startup = notice == nil && (mind == .ready || (mind == .missing && quiet)) ? deferredStartup : nil
            let optional = mind == .ready && login == nil && loginSetupID == nil && notice == nil
                ? needs.first(where: { $0.isOptionalPermission && !hiddenPermissions.contains($0.id) }) : nil
            let attention: Need?
            if let blocked, blocked.id == "creature:sleep" { attention = blocked }
            else if let top = needs.first(where: { !$0.isOptionalPermission }) { attention = top }
            else if let blocked { attention = blocked }
            else if let login {
                attention = login.hidden ? nil : login.code.map {
                    Self.card("signing-in", "Your code \($0.code) is on the clipboard. Paste it on the GitHub page I opened." +
                              (login.questionWaiting ? " Your question hasn't been sent. Finish signing in, then ask again." : ""),
                              "Open GitHub", "creature:show-code", dismiss: false,
                              extra: NeedOption(label: "Cancel sign-in", action: "creature:cancel-login"))
                } ?? Self.card("signing-in", "Getting your sign-in code. Choose Cancel sign-in to stop waiting.",
                               "Cancel sign-in", "creature:cancel-login", dismiss: false)
            } else if !quiet {
                switch mind {
                case .missing:
                    attention = Self.card("mind", "I can't find my mind. Choose Find my mind to try again.",
                                          "Find my mind", "creature:find")
                case .hungry, .noCopilot:
                    attention = Self.card("mind", mind == .noCopilot ? Self.copilotWords :
                        "I can't think yet. Choose Sign me in to feed me.", "Sign me in", "creature:sign-in")
                case .toolsMissing:
                    attention = Self.toolsCard
                default: attention = optional ?? startup
                }
            } else { attention = optional ?? startup }
            if let attention {
                view.need = attention
                view.line = view.need?.title ?? ""
                view.posture = .needsYou; view.expanded = true
            } else if loginSetupID != nil {
                view.posture = .thinking
                view.line = "Getting my mind ready for when you sign in to this Mac."
                view.expanded = true
            } else if mind == .finding && !quiet {
                view.posture = .thinking
                view.line = lookupTakingTime ? "Still getting my mind ready. The first time can take a while." : "Finding my mind."
                view.expanded = true
            } else if notice != nil {
                view.expanded = true
                view.canDismissLine = true
            }
        }
        presentation = view
    }

    public static func isSleepCommand(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
            .lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ") == "go to sleep"
    }

    public enum Permission: CaseIterable, Equatable { case microphone, speech, typing, screen, texts }
    public static func permissionCard(_ permission: Permission) -> Need {
        let pane: String, words: String
        switch permission {
        case .microphone: pane = "Microphone"; words = "To hear you, I need permission to use your microphone."
        case .speech: pane = "SpeechRecognition"; words = "To understand you, I need permission to turn speech into words."
        case .typing: pane = "Accessibility"; words = "To type for you, I need permission to use your keyboard."
        case .screen: pane = "ScreenCapture"; words = "To read your screen, I need permission to see it."
        case .texts: pane = "AllFiles"; words = "To read your texts and link your notes, I need your permission."
        }
        let finish = permission == .screen
            ? " Choose Open the setting, then allow OpenRappter. Choose Restart OpenRappter afterward, then ask about your screen again."
            : " Choose Open the setting, then allow OpenRappter."
        return card("permission-\(pane)", words + finish,
                    "Open the setting", "open:x-apple.systempreferences:com.apple.preference.security?Privacy_\(pane)")
    }

    private static let copilotWords = "This GitHub account has no Copilot. Enable Copilot for it, then choose Sign me in."
    private static var toolsCard: Need {
        card("tools", "I need Apple's tools to get ready. Choose Install, finish Apple's steps, then choose Find my mind.",
             "Install", "creature:install-tools",
             extra: NeedOption(label: "Find my mind", action: "creature:find"))
    }
    private static func card(_ id: String, _ words: String, _ label: String, _ action: String,
                             dismiss: Bool = true, extra: NeedOption? = nil) -> Need {
        var options = [NeedOption(label: label, rec: true, action: action)]
        if let extra { options.append(extra) }
        if dismiss { options.append(NeedOption(label: "Not now", action: "creature:dismiss")) }
        return Need(id: "creature:\(id)", title: words, opts: options, source: "openrappter")
    }
}

/// Effects have one injectable boundary, so tests can supply a mind, ears, voice, and a virtual clock.
@MainActor
public final class CreatureDriver {
    public private(set) var machine: CreatureStateMachine
    public var onChange: ((CreaturePresentation) -> Void)?
    private let perform: (CreatureEffect) async -> CreatureEvent?
    private var tasks: [UUID: (CreatureLane, Task<Void, Never>)] = [:]
    private var settled: [UUID: CheckedContinuation<Void, Never>] = [:]
    public init(machine: CreatureStateMachine = CreatureStateMachine(),
                perform: @escaping (CreatureEffect) async -> CreatureEvent?) {
        self.machine = machine; self.perform = perform
    }
    public func send(_ event: CreatureEvent) {
        let effects = machine.send(event)
        onChange?(machine.presentation)
        for effect in effects {
            if case .cancel(let lane) = effect {
                for (id, (kind, task)) in tasks where kind == lane { task.cancel(); tasks.removeValue(forKey: id) }
                continue
            }
            let id = UUID()
            let task = Task { [weak self, perform] in
                guard !Task.isCancelled else { return }
                let event = await perform(effect)
                guard !Task.isCancelled, let self else { return }
                self.tasks.removeValue(forKey: id)
                if let event { self.send(event) }
            }
            tasks[id] = (effect.lane, task)
        }
        if !machine.isWorking { finishWaiting() }
    }
    public func waitUntilSettled() async {
        guard machine.isWorking, !Task.isCancelled else { return }
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { settled[id] = $0 }
        } onCancel: {
            Task { @MainActor in self.settled.removeValue(forKey: id)?.resume() }
        }
    }
    public func cancelAll() {
        tasks.values.forEach { $0.1.cancel() }
        tasks.removeAll()
        finishWaiting()
    }
    private func finishWaiting() {
        let pending = settled.values
        settled.removeAll()
        pending.forEach { $0.resume() }
    }
}
