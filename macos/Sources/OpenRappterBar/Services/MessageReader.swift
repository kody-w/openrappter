import Foundation
import SQLite3

/// Reads iMessage — tries sqlite3 (FDA), falls back to AppleScript (no FDA).
/// The fallback pattern: always have a local route that works.
public struct MessageReader {

    public struct Message {
        public let guid: String
        public let text: String
        public let timestamp: Double
        public let isFromMe: Bool
        public let sender: String
        public let chatIdentifier: String
    }

    /// Read recent messages — tries sqlite3 first, falls back to AppleScript
    public static func readMessages(chatIdentifier: String, sinceTimestamp: Double = 0, limit: Int = 5) -> [Message] {
        // Try sqlite3 (fast, reliable, needs FDA)
        let sqlMessages = readViaSqlite(chatIdentifier: chatIdentifier, sinceTimestamp: sinceTimestamp, limit: limit)
        if !sqlMessages.isEmpty { return sqlMessages }

        // Fallback: AppleScript (slower, no FDA needed)
        return readViaAppleScript(chatIdentifier: chatIdentifier, limit: limit)
    }

    /// Check if we can read messages by any method
    public static func canReadMessages() -> Bool {
        // Try sqlite3
        let home = NSHomeDirectory()
        let dbPath = "\(home)/Library/Messages/chat.db"
        var db: OpaquePointer?
        if sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK {
            sqlite3_close(db)
            return true
        }
        // Fallback: check AppleScript
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", "tell application \"Messages\" to return count of chats"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do {
            try proc.run()
            proc.waitUntilExit()
            if proc.terminationStatus == 0 {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "0"
                return (Int(output) ?? 0) > 0
            }
        } catch {}
        return false
    }

    // MARK: - sqlite3 (needs FDA)

    private static func readViaSqlite(chatIdentifier: String, sinceTimestamp: Double, limit: Int) -> [Message] {
        let home = NSHomeDirectory()
        let dbPath = "\(home)/Library/Messages/chat.db"

        var db: OpaquePointer?
        guard sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_close(db) }

        let macEpochOffset: Double = 978307200
        let sinceApple = (sinceTimestamp - macEpochOffset) * 1000000000

        let query = """
        SELECT m.guid, m.text, m.date/1000000000+978307200 as ts, m.is_from_me,
               COALESCE(h.id, '') as sender, COALESCE(c.chat_identifier, '') as chat_id
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
        LEFT JOIN chat c ON cmj.chat_id = c.ROWID
        WHERE c.chat_identifier LIKE '%\(chatIdentifier)%'
          AND m.date > \(Int64(sinceApple))
        ORDER BY m.date DESC
        LIMIT \(limit)
        """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, query, -1, &stmt, nil) == SQLITE_OK else {
            return []
        }
        defer { sqlite3_finalize(stmt) }

        var messages: [Message] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            let guid = sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? ""
            let text = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
            let ts = sqlite3_column_double(stmt, 2)
            let fromMe = sqlite3_column_int(stmt, 3) == 1
            let sender = sqlite3_column_text(stmt, 4).map { String(cString: $0) } ?? ""
            let chatId = sqlite3_column_text(stmt, 5).map { String(cString: $0) } ?? ""
            if !text.isEmpty {
                messages.append(Message(guid: guid, text: text, timestamp: ts, isFromMe: fromMe, sender: sender, chatIdentifier: chatId))
            }
        }
        return messages.reversed() // Restore ASC order
    }

    // MARK: - AppleScript fallback (no FDA needed)

    private static func readViaAppleScript(chatIdentifier: String, limit: Int) -> [Message] {
        let escaped = chatIdentifier.replacingOccurrences(of: "\"", with: "\\\"")
        let script = """
        tell application "Messages"
            set output to ""
            set allChats to every chat
            repeat with aChat in allChats
                try
                    set chatId to id of aChat
                    if chatId contains "\(escaped)" then
                        set msgs to messages of aChat
                        set msgCount to count of msgs
                        if msgCount > 0 then
                            set startIdx to msgCount - \(limit - 1)
                            if startIdx < 1 then set startIdx to 1
                            repeat with i from startIdx to msgCount
                                set aMsg to item i of msgs
                                try
                                    set msgContent to content of aMsg
                                    set msgId to id of aMsg
                                    set fromMe to "0"
                                    try
                                        if sender of aMsg is missing value then set fromMe to "1"
                                    end try
                                    set output to output & msgId & "||||" & msgContent & "||||" & fromMe & (ASCII character 10)
                                end try
                            end repeat
                        end if
                        exit repeat
                    end if
                end try
            end repeat
            return output
        end tell
        """

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice

        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else { return [] }

            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            guard let output = String(data: data, encoding: .utf8), !output.isEmpty else { return [] }

            var messages: [Message] = []
            for line in output.split(separator: "\n") {
                let parts = line.split(separator: "||||", omittingEmptySubsequences: false).map(String.init)
                guard parts.count >= 3 else { continue }
                let guid = parts[0]
                let text = parts[1]
                let fromMe = parts[2].trimmingCharacters(in: .whitespacesAndNewlines) == "1"
                if !text.isEmpty {
                    messages.append(Message(
                        guid: guid, text: text,
                        timestamp: Date().timeIntervalSince1970,
                        isFromMe: fromMe,
                        sender: fromMe ? "self" : chatIdentifier,
                        chatIdentifier: chatIdentifier
                    ))
                }
            }
            return messages
        } catch {
            return []
        }
    }
}
