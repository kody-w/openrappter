import AppKit
import ApplicationServices

/// What to do with an ask while the owner may be using this Mac.
public enum DoorWait: Equatable {
    case go                 // carry it out now
    case wait               // leave it in the folder and come back to it
    case giveUp(String)     // answer it with this plain line, without doing it
}

/// The asks that are waiting for the owner to finish, and when each was first held back.
struct DoorPolite {
    var since: [String: Date] = [:]
    var shown = 0           // the count the page last showed
}

/// It never fights you for the mouse: anything that presses, types or opens waits until the owner has stopped.
extension Door {
    /// The asks that move the mouse, type, or change what is on screen.
    public nonisolated static let acting: Set<String> = ["press", "click", "type", "key", "open", "job", "always"]
    /// The owner counts as using the Mac for this long after the last touch.
    public nonisolated static let quietFor: Double = 20
    /// After this long in total, a waiting ask is turned down instead.
    public nonisolated static let patience: Double = 600
    public nonisolated static let gaveUp = "you were using this Mac, so I did not interrupt. Ask again when you are done."

    /// Seconds since the last real touch of this Mac's mouse or keys. The door's own presses do not count.
    public nonisolated static func hardwareIdle() -> Double {
        let kinds: [CGEventType] = [.mouseMoved, .keyDown, .leftMouseDown, .scrollWheel]
        return kinds.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
    }

    /// The whole decision. `idle` is seconds since the owner last touched the Mac; `waited` is how long this ask has been held back.
    public nonisolated static func shouldWait(do what: String, idle: Double, with: [String]?, waited: Double) -> DoorWait {
        guard acting.contains(what) else { return .go }                                   // looking and reading never wait
        if (with ?? []).contains(where: { $0.lowercased() == "now" }) { return .go }       // the owner asked for it this instant
        if !(idle < quietFor) { return .go }                                               // also lets through a reading that is not a number
        if waited >= patience { return .giveUp(gaveUp) }
        return .wait
    }

    /// The line for the top of the page, or nothing when nothing is waiting.
    public nonisolated static func waitingLine(_ count: Int) -> String {
        count <= 0 ? "" : "Waiting for you to finish before I do \(count) \(count == 1 ? "thing" : "things")."
    }

    func politeDecision(_ ask: DoorAsk, now: Date) -> DoorWait {
        // Hands off gets its own plain answer straight away. A button the owner just pressed on the page is the owner asking now.
        if held || ask.id.hasPrefix("pick-") { return .go }
        let waited = polite.since[ask.id].map { now.timeIntervalSince($0) } ?? 0
        return Door.shouldWait(do: ask.do, idle: ownerIdle(), with: ask.with, waited: waited)
    }

    /// The next ask to carry out, oldest first, stepping past the ones that wait for the owner.
    /// Returns nil when everything left is waiting, so the queue never spins; the next tick comes back to them.
    func nextUp() -> DoorAsk? {
        let now = clock()
        let all = waiting()
        let ids = Set(all.map(\.id))
        polite.since = polite.since.filter { ids.contains($0.key) }
        var next: DoorAsk?
        for ask in all {
            let d = politeDecision(ask, now: now)
            if d == .go { polite.since[ask.id] = nil; next = ask; break }
            if case .giveUp(let said) = d {
                polite.since[ask.id] = nil
                let answer = DoorAnswer(id: ask.id, ok: false, said: said, front: nil, words: nil, picture: nil, at: now.timeIntervalSince1970)
                write(answer); record(ask, answer); onDone?()
            } else if polite.since[ask.id] == nil {
                polite.since[ask.id] = now
            }
        }
        // The page says so while something waits, and stops saying so when nothing does.
        let count = polite.since.count
        if count != polite.shown {
            polite.shown = count
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("page.html").path) { _ = writePage(hours: 24, now: now) }
        }
        return next
    }

    /// A job the door started itself (a watch going off). While the owner is using the Mac it goes in the folder to wait its turn.
    func parked(_ ask: DoorAsk, now: Date) -> Bool {
        guard politeDecision(ask, now: now) != .go, let d = try? JSONEncoder().encode(ask),
              (try? d.write(to: dir.appendingPathComponent("\(ask.id).json"), options: .atomic)) != nil else { return false }
        polite.since[ask.id] = now
        return true
    }

    /// How many asks are waiting for the owner to finish.
    public func politeCount() -> Int { polite.since.count }

    func politeLine() -> String {
        let line = Door.waitingLine(politeCount())
        return line.isEmpty ? "" : "<p class=\"sub\">\(line)</p>"
    }
}
