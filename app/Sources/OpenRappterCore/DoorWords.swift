import Foundation

public enum DoorWords {
    public static let verbs: [String: String] = [
        "reminders.open": "read your reminders", "reminders.add": "add a reminder",
        "reminders.done": "finish a reminder", "messages.send": "send a text for you",
        "messages.recent": "read your recent texts", "clipboard.read": "read what you copied",
        "clipboard.write": "copy something for you", "browser.open": "open a page",
        "calendar.today": "read today's plans", "notes.read": "read a note",
        "notes.publish": "write a note", "doors.hello": "see what I can do",
        "doors.log": "read recent choices", "doors.trust": "see who you trust",
        "doors.report": "read your weekly report", "twin.object": "object to a choice",
        "stream.post": "leave you an update",
    ]
    public static func verb(_ door: String) -> String { verbs[door] ?? "do that task" }
    public static func name(_ name: String) -> String {
        let value = (name as NSString).lastPathComponent.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        return value.isEmpty ? "Your helper" : value
    }
    public static func approval(_ caller: DoorCaller, door: String, id: String, now: Double) -> Need {
        let why = caller.why.isEmpty ? "" : caller.why + "\n"
        return Need(id: id, title: "\(name(caller.name)) wants to \(verb(door)).",
                    ctx: why + "Choose Allow once to let it, or No to stop it.",
                    opts: [NeedOption(label: "Allow once", rec: true, action: "door:once"),
                           NeedOption(label: "Always", action: "door:always"), NeedOption(label: "No", action: "door:no")],
                    source: "doors", created: now)
    }
    public static func twinLine(_ caller: String, door: String, allowed: Bool, confidence: Double) -> String {
        let action = allowed ? "let \(name(caller))" : "stopped \(name(caller)) from trying to"
        return "Your twin \(action) \(verb(door)) (\(Int(confidence * 100))% sure)."
    }
    public static let objectionStep = "To object to this, tap Object in OpenRappter on your Mac."
}
