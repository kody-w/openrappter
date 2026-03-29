import Foundation
import SQLite3
import AppKit

/// Bridge between the OpenRappter daemon and iMessage via the menubar app.
/// The menubar app has FDA; the daemon doesn't. So the bridge reads messages
/// directly via SQLite and forwards them to the daemon for AI processing.
@MainActor
public class MessageBridge {
    private var lastReadTimestamp: Double = Date().timeIntervalSince1970
    private var sentByAI: Set<String> = []
    private let selfId: String
    private let watchContacts: [String]
    
    /// Per-conversation real-time mode toggle.
    /// When a message starts with @, toggle real-time mode for that chat.
    /// Real-time ON → respond to every message.
    /// Real-time OFF → only respond to @ messages.
    private var realtimeMode: [String: Bool] = [:]
    
    public init(selfId: String, watchContacts: [String] = []) {
        self.selfId = selfId
        self.watchContacts = watchContacts
    }
    
    private func log(_ msg: String) {
        let line = "[MessageBridge] \(msg)\n"
        print(line, terminator: "")
        let logFile = NSHomeDirectory() + "/.openrappter/imessage-bridge.log"
        if let handle = FileHandle(forWritingAtPath: logFile) {
            handle.seekToEndOfFile()
            handle.write(line.data(using: .utf8) ?? Data())
            handle.closeFile()
        } else {
            FileManager.default.createFile(atPath: logFile, contents: line.data(using: .utf8))
        }
    }

    public func start() {
        let home = NSHomeDirectory()
        let dbPath = "\(home)/Library/Messages/chat.db"
        var testDb: OpaquePointer?
        let hasFDA = sqlite3_open_v2(dbPath, &testDb, SQLITE_OPEN_READONLY, nil) == SQLITE_OK
        if hasFDA { sqlite3_close(testDb) }

        log("FDA check: \(hasFDA ? "YES ✅" : "NO — need Full Disk Access")")
        log("Self ID: \(selfId)")
        log("Watch contacts: \(watchContacts.joined(separator: ", "))")

        if !hasFDA {
            log("Opening System Settings for FDA grant...")
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
                NSWorkspace.shared.open(url)
            }
        }

        Task {
            while true {
                try? await Task.sleep(for: .seconds(3))
                await pollAndForward()
            }
        }

        log("Started — polling every 3s")
    }
    
    private var pollCount = 0
    private func pollAndForward() async {
        pollCount += 1
        
        // Poll all watched chats: self + allowed contacts
        let allIds = ([selfId] + watchContacts).filter { !$0.isEmpty }
        
        for chatId in allIds {
            let messages = MessageReader.readMessages(
                chatIdentifier: chatId,
                sinceTimestamp: lastReadTimestamp,
                limit: 5
            )
            
            if pollCount % 20 == 0 && chatId == allIds.first {
                log("Poll #\(pollCount): checking \(allIds.count) chats, since=\(lastReadTimestamp)")
            }

            for msg in messages {
                // Skip AI-sent messages
                let prefix = String(msg.text.prefix(20))
                if msg.isFromMe && sentByAI.contains(prefix) {
                    sentByAI.remove(prefix)
                    lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                    continue
                }
                
                // Skip our own responses (emoji prefix)
                if msg.text.hasPrefix("🦖") {
                    lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                    continue
                }
                
                // Skip from-me messages that aren't self-chat
                if msg.isFromMe && chatId != selfId {
                    lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                    continue
                }

                let content = msg.text.trimmingCharacters(in: .whitespacesAndNewlines)
                let isAtMessage = content.hasPrefix("@")
                let wasRealtime = realtimeMode[chatId] ?? false
                
                if isAtMessage {
                    if wasRealtime {
                        // Exit real-time mode
                        realtimeMode[chatId] = false
                        log("💬 [\(chatId)] real-time chat OFF")
                        sendMessage("🦖 Real-time chat ended. Send @ to start again.", to: chatId)
                        lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                        continue
                    } else {
                        // Enter real-time mode
                        realtimeMode[chatId] = true
                        log("💬 [\(chatId)] real-time chat ON")
                        // Strip @ and process the message
                        let cleaned = String(content.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
                        let text = cleaned.isEmpty ? "Hey" : cleaned
                        log("📩 [\(chatId)] \(msg.isFromMe ? "self" : msg.sender): \(text.prefix(80))")
                        await forwardToDaemon(text: text, chatId: chatId, fromMe: msg.isFromMe, guid: msg.guid)
                        lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                        continue
                    }
                }
                
                if !wasRealtime {
                    // Not in real-time and no @ prefix — skip
                    lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                    continue
                }
                
                // Real-time mode: forward everything
                log("📩 [\(chatId)] \(msg.isFromMe ? "self" : msg.sender): \(content.prefix(80))")
                await forwardToDaemon(text: content, chatId: chatId, fromMe: msg.isFromMe, guid: msg.guid)
                lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
            }
        }
    }
    
    private func forwardToDaemon(text: String, chatId: String, fromMe: Bool, guid: String) async {
        guard let url = URL(string: "http://127.0.0.1:\(AppConstants.defaultPort)/rpc") else { return }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let rpc: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "chat.send",
            "params": [
                "message": text,
                "sessionId": "imessage_\(chatId)"
            ],
            "id": 1
        ]
        
        request.httpBody = try? JSONSerialization.data(withJSONObject: rpc)
        
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let result = json["result"] as? [String: Any],
               let content = result["content"] as? String {
                var reply = content
                if let voiceIdx = reply.range(of: "|||VOICE|||") {
                    reply = String(reply[..<voiceIdx.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                
                let replyText = "🦖 \(reply)"
                sentByAI.insert(String(replyText.prefix(20)))
                sendMessage(replyText, to: chatId)
                log("🦖 → [\(chatId)]: \(reply.prefix(80))")
            }
        } catch {
            log("Daemon call failed: \(error)")
        }
    }
    
    private func sendMessage(_ text: String, to chatId: String) {
        let escaped = text
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        
        let script = """
        tell application "Messages"
            set targetService to 1st account whose service type = iMessage
            set targetBuddy to participant "\(chatId)" of targetService
            send "\(escaped)" to targetBuddy
        end tell
        """
        
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        proc.arguments = ["-e", script]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
    }
}
