import Foundation
import SQLite3

/// Reads iMessage chat.db — only works when the host .app has Full Disk Access
public struct MessageReader {
    
    public struct Message {
        public let guid: String
        public let text: String
        public let timestamp: Double
        public let isFromMe: Bool
        public let sender: String
        public let chatIdentifier: String
    }
    
    /// Read recent messages from a specific chat
    public static func readMessages(chatIdentifier: String, sinceTimestamp: Double = 0, limit: Int = 10) -> [Message] {
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
        ORDER BY m.date ASC
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
        
        return messages
    }
    
    /// Check if we have FDA access
    public static func canReadMessages() -> Bool {
        let home = NSHomeDirectory()
        let dbPath = "\(home)/Library/Messages/chat.db"
        var db: OpaquePointer?
        let result = sqlite3_open_v2(dbPath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK
        if result { sqlite3_close(db) }
        return result
    }
}
