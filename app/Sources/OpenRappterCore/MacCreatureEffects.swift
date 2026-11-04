import AppKit

/// The real adapters. Tests replace this boundary, not the reducer, with fake ears, mind and clock.
@MainActor
public final class MacCreatureEffects {
    public var runner: MindRunner
    public let ears: Ears
    public let voice: Voice
    public let clipboard: ClipboardLease
    public let needs: NeedsQueue
    public var send: ((CreatureEvent) -> Void)?
    public var log: (String) -> Void = { _ in }
    public var sleep: (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }
    private var mind: MindClient?

    public init(runner: MindRunner, needs: NeedsQueue, ears: Ears? = nil, voice: Voice? = nil,
                clipboard: ClipboardLease? = nil) {
        self.runner = runner; self.needs = needs; self.ears = ears ?? Ears()
        self.voice = voice ?? Voice(); self.clipboard = clipboard ?? ClipboardLease()
    }

    public func perform(_ effect: CreatureEffect) async -> CreatureEvent? {
        switch effect {
        case .cancel: return nil
        case .findMind(let id):
            do {
                let (client, health) = try await runner.findMind(sleep: sleep)
                try Task.checkCancellation()
                mind = client
                return .found(id, .success(health))
            } catch {
                log("find mind: \(error)")
                return .found(id, .failure(failure(error)))
            }
        case .startLogin(let id):
            do {
                guard let mind else { throw MindError.unreachable("No mind") }
                let code = try await mind.startLogin()
                return .loginStarted(id, .success(LoginCode(code: code.code, url: code.url)))
            } catch { log("start sign-in: \(error)"); return .loginStarted(id, .failure(failure(error))) }
        case .pollLogin(let id):
            do {
                guard let mind else { throw MindError.unreachable("No mind") }
                return .loginPolled(id, .success(try await mind.loginProgress()))
            } catch { log("poll sign-in: \(error)"); return .loginPolled(id, .failure(failure(error))) }
        case .confirmLogin(let id):
            do {
                guard let mind else { throw MindError.unreachable("No mind") }
                return .loginConfirmed(id, .success(try await mind.health()))
            } catch { log("confirm sign-in: \(error)"); return .loginConfirmed(id, .failure(failure(error))) }
        case .showCode(let code):
            clipboard.copy(code.code)
            if !NSWorkspace.shared.open(code.url) { log("could not open sign-in page") }
        case .restoreClipboard: clipboard.restore()
        case .authorize(let id): return .authorized(id, await Ears.permission())
        case .startEars(let id):
            ears.onPartial = { [weak self] in self?.send?(.partial(id, $0)) }
            do { try ears.start(); return .earsStarted(id, true) }
            catch { log("start hearing: \(error)"); return .earsStarted(id, false) }
        case .stopEars(let id): return .heard(id, await ears.stop())
        case .cancelEars: ears.cancel()
        case .stopVoice: voice.stop()
        case .chat(let id, let message, let session, let history):
            do {
                guard let mind else { throw MindError.unreachable("No mind") }
                return .replied(id, .success(try await mind.chat(message, sessionId: session, history: history)))
            } catch { log("ask: \(error)"); return .replied(id, .failure(failure(error))) }
        case .readScreen(let id, _):
            do {
                let (app, text) = try await Eyes.frontWindowText()
                return .screenRead(id, .success("The user is looking at \(app). Text on that window:\n\(text.prefix(6000))"))
            } catch { log("read screen: \(error)"); return .screenRead(id, .failure(.unavailable)) }
        case .dictate(let id, let text):
            guard Dictation.trusted(prompt: false) else { return .dictated(id, false) }
            return .dictated(id, await Dictation.paste(text) != "denied")
        case .speak(let id, let text):
            await voice.speak(text)
            return .spoken(id)
        case .wait(let seconds, let wake):
            do { try await sleep(seconds); return .wake(wake) }
            catch { return nil } // Cancellation has no completion event.
        case .open(let url):
            if !NSWorkspace.shared.open(url) { log("could not open requested setting") }
        case .answer(let need, let option): needs.answer(need, option)
        case .later(let need): needs.later(need)
        case .installAtLogin(let id):
            do { try runner.prepareService(); return .installedAtLogin(id, true) }
            catch { log("set up return: \(error)"); return .installedAtLogin(id, false) }
        case .stopAtLogin:
            // Remove the mind first: stopping our own login item may terminate this app.
            runner.removeService()
            do { try LoginItem().remove() } catch { log("stop returning: \(error)") }
        case .installTools:
            let status = RuntimeTools.run("/usr/bin/xcode-select", ["--install"])
            log("requested Apple tools: \(status)")
        }
        return nil
    }

    private func failure(_ error: Error) -> CreatureFailure {
        switch error {
        case MindError.noCopilot: return .noCopilot
        case MindError.toolsMissing: return .toolsMissing
        case MindError.hungry: return .hungry
        default: return .unavailable
        }
    }
}
