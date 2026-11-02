import Foundation
import SQLite3

/// The real doors/1 handlers. The app does the work itself, so macOS asks about OpenRappter alone.
/// Reminders go through AppleScript (not EventKit) on purpose: the reminder ids must stay the same
/// `x-apple-reminder://…` ids that existing callers (beam_local) already keyed their errands on.
public enum MacDoors {
    static func osaString(_ s: String) -> String {
        "\"" + s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    /// NSAppleScript is not thread safe: run it on the main thread.
    public static func runScript(_ src: String) throws -> String {
        var out: String?; var err: String?
        let work = {
            var info: NSDictionary?
            let r = NSAppleScript(source: src)?.executeAndReturnError(&info)
            if let info { err = (info[NSAppleScript.errorMessage] as? String) ?? "\(info)" } else { out = r?.stringValue ?? "" }
        }
        if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
        if let err { throw DoorError("macOS said: \(err)") }
        return out ?? ""
    }

    static func str(_ a: [String: Any], _ k: String, required: Bool = true) throws -> String {
        if let v = a[k] as? String, !(required && v.isEmpty) { return v }
        if let v = a[k] as? NSNumber { return v.stringValue }
        if required { throw DoorError("missing \"\(k)\"") }
        return ""
    }

    public static func install(on s: DoorServer, notesFolder: String = "Beam", remindersList: String = "Beam") {
        s.handlers["reminders.open"] = { a in
            let list = (a["list"] as? String) ?? remindersList
            let l = osaString(list)
            let src = """
            tell application "Reminders"
             if not (exists list \(l)) then make new list with properties {name:\(l)}
             set out to ""
             repeat with r in (reminders of list \(l) whose completed is false)
              set out to out & (id of r) & tab & (name of r) & linefeed
             end repeat
             return out
            end tell
            """
            let text = try runScript(src)
            return text.split(separator: "\n").compactMap { line -> [String: String]? in
                let p = line.split(separator: "\t", maxSplits: 1).map(String.init)
                return p.count == 2 ? ["id": p[0], "title": p[1]] : nil
            }
        }
        s.handlers["reminders.add"] = { a in
            let title = try str(a, "title"); let note = try str(a, "note", required: false)
            let l = osaString((a["list"] as? String) ?? remindersList)
            let id = try runScript("tell application \"Reminders\"\n if not (exists list \(l)) then make new list with properties {name:\(l)}\n set r to make new reminder at end of list \(l) with properties {name:\(osaString(title)), body:\(osaString(note))}\n return id of r\nend tell")
            return ["id": id, "title": title]
        }
        s.handlers["reminders.done"] = { a in
            let id = try str(a, "id"); let note = try str(a, "note", required: false)
            let body = osaString(note.isEmpty ? "Done" : note)
            if let list = a["list"] as? String {
                // Walk the open reminders of that list, like reminders.open: `reminder id` alone can hang Reminders for minutes.
                let l = osaString(list)
                let found = try runScript("tell application \"Reminders\"\n repeat with r in (reminders of list \(l) whose completed is false)\n  if (id of r) is \(osaString(id)) then\n   set body of r to \(body)\n   set completed of r to true\n   return \"yes\"\n  end if\n end repeat\n return \"no\"\nend tell")
                if found != "yes" { throw DoorError("no open reminder with that id in \(list)") }
            } else {
                _ = try runScript("tell application \"Reminders\"\n set r to reminder id \(osaString(id))\n set completed of r to true\n set body of r to \(body)\nend tell")
            }
            return ["id": id, "done": true] as [String: Any]
        }
        s.handlers["notes.read"] = { a in
            let title = try str(a, "title")
            let folder = (a["folder"] as? String) ?? notesFolder
            let body = try runScript("tell application \"Notes\" to return body of note \(osaString(title)) of folder \(osaString(folder))")
            return ["title": title, "body": body]
        }
        s.handlers["notes.publish"] = { a in
            let topic = try str(a, "topic"); let headline = try str(a, "headline"); let body = try str(a, "body", required: false)
            let folder = (a["folder"] as? String) ?? notesFolder
            let title = "Beam · " + topic
            let fmt = DateFormatter(); fmt.dateFormat = "MMM d, h:mm a"
            func esc(_ t: String) -> String { t.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") }
            let entry = "<div><b>\(esc(fmt.string(from: Date())))</b> \(esc(headline))</div>"
                + body.split(separator: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { "<div>\(esc(String($0)))</div>" }.joined()
                + "<div><br></div>"
            let t = osaString(title), f = osaString(folder)
            _ = try? runScript("tell application \"Notes\"\n if not (exists folder \(f)) then make new folder with properties {name:\(f)}\nend tell")
            let script: String
            if let cur = try? runScript("tell application \"Notes\" to return body of note \(t) of folder \(f)"), let r = cur.range(of: "</div>") {
                let merged = String(cur[..<r.upperBound]) + entry + String(cur[r.upperBound...])
                script = "tell application \"Notes\"\n set n to note \(t) of folder \(f)\n set body of n to \(osaString(merged))\n return id of n\nend tell"
            } else {
                script = "tell application \"Notes\"\n set n to make new note at folder \(f) with properties {name:\(t), body:\(osaString(entry))}\n return id of n\nend tell"
            }
            let noteId = try runScript(script)
            return ["note_id": noteId, "link": noteLink(noteId) ?? ""] as [String: Any]
        }
        s.handlers["messages.send"] = { a in
            let to = try str(a, "to"); let text = try str(a, "text")
            _ = try runScript("with timeout of 20 seconds\ntell application \"Messages\" to send \(osaString(text)) to participant \(osaString(to)) of (first account whose service type is iMessage)\nend timeout")
            return ["sent": true]
        }
        s.handlers["messages.recent"] = { a in
            let since = Int64((a["since_rowid"] as? NSNumber)?.int64Value ?? Int64((a["since_rowid"] as? String) ?? "0") ?? 0)
            let limit = min((a["limit"] as? NSNumber)?.intValue ?? 200, 1000)
            let newest = (a["newest"] as? Bool) ?? false
            return try recentMessages(since: since, limit: limit, newest: newest)
        }
    }

    /// Kody's chat.db, read-only, inside the app (needs Full Disk Access for OpenRappter).
    public static func recentMessages(since: Int64, limit: Int, newest: Bool = false, db path: String? = nil) throws -> [[String: Any]] {
        let p = path ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Messages/chat.db").path
        var db: OpaquePointer?
        guard sqlite3_open_v2("file:\(p)?mode=ro", &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK else {
            sqlite3_close(db)
            throw DoorError("cannot open the Messages database; give OpenRappter Full Disk Access in System Settings")
        }
        defer { sqlite3_close(db) }
        let q = "select m.ROWID, m.date/1000000000+978307200, m.text, m.is_from_me, coalesce(h.id,'') from message m left join handle h on h.ROWID=m.handle_id where m.ROWID>? and m.text is not null order by m.ROWID \(newest ? "desc" : "") limit ?"
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, q, -1, &st, nil) == SQLITE_OK else {
            throw DoorError("cannot read the Messages database: \(String(cString: sqlite3_errmsg(db))) (Full Disk Access?)")
        }
        defer { sqlite3_finalize(st) }
        sqlite3_bind_int64(st, 1, since); sqlite3_bind_int(st, 2, Int32(limit))
        var rows: [[String: Any]] = []
        while sqlite3_step(st) == SQLITE_ROW {
            rows.append(["rowid": sqlite3_column_int64(st, 0), "ts": sqlite3_column_int64(st, 1),
                         "text": sqlite3_column_text(st, 2).map { String(cString: $0) } ?? "",
                         "from_me": sqlite3_column_int(st, 3) == 1,
                         "handle": sqlite3_column_text(st, 4).map { String(cString: $0) } ?? ""])
        }
        return newest ? rows.reversed() : rows
    }

    /// Same tappable link beam_local makes: the note's iCloud identifier through the bounce page. nil when unreadable.
    static func noteLink(_ noteId: String) -> String? {
        guard let pkStr = noteId.components(separatedBy: "/p").last, let pk = Int64(pkStr) else { return nil }
        let p = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Group Containers/group.com.apple.notes/NoteStore.sqlite").path
        var db: OpaquePointer?
        guard sqlite3_open_v2("file:\(p)?mode=ro", &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK else { sqlite3_close(db); return nil }
        defer { sqlite3_close(db) }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, "select o.ZIDENTIFIER, a.ZUSERRECORDNAME from ZICCLOUDSYNCINGOBJECT o left join ZICCLOUDSYNCINGOBJECT a on a.Z_PK=o.ZACCOUNT7 where o.Z_PK=?", -1, &st, nil) == SQLITE_OK else { return nil }
        defer { sqlite3_finalize(st) }
        sqlite3_bind_int64(st, 1, pk)
        guard sqlite3_step(st) == SQLITE_ROW, let ident = sqlite3_column_text(st, 0).map({ String(cString: $0) }) else { return nil }
        let owner = sqlite3_column_text(st, 1).map { String(cString: $0) }
        return "https://airaptr.github.io/note-link/?n=\(ident)" + (owner.map { "&o=\($0)" } ?? "")
    }
}
