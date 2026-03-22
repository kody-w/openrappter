import Foundation

/// Bridge between the OpenRappter daemon and iMessage via the menubar app.
/// The menubar app has FDA; the daemon doesn't. So the daemon asks the app
/// to read messages via a local HTTP endpoint.
@MainActor
public class MessageBridge {
    private var lastReadTimestamp: Double = Date().timeIntervalSince1970
    private var sentByAI: Set<String> = []
    private let chatIdentifier: String
    
    public init(chatIdentifier: String) {
        self.chatIdentifier = chatIdentifier
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
        let canRead = MessageReader.canReadMessages()
        log("FDA check: \(canRead ? "YES" : "NO")")
        log("Chat identifier: \(chatIdentifier)")

        if !canRead {
            log("WARNING: Neither FDA nor AppleScript available — bridge may not work")
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
        let messages = MessageReader.readMessages(
            chatIdentifier: chatIdentifier,
            sinceTimestamp: lastReadTimestamp,
            limit: 5
        )

        // Log every 20 polls (~60s) or when messages found
        if pollCount % 20 == 0 || !messages.isEmpty {
            log("Poll #\(pollCount): \(messages.count) msgs, since=\(lastReadTimestamp)")
        }

        for msg in messages {
            // Skip AI-sent messages
            let prefix = String(msg.text.prefix(20))
            if msg.isFromMe && sentByAI.contains(prefix) {
                sentByAI.remove(prefix)
                lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                continue
            }
            
            // Skip if it starts with the AI prefix (our own response)
            if msg.text.hasPrefix("🦖") {
                lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                continue
            }

            // Only respond if message contains @rappter tag
            let lower = msg.text.lowercased()
            guard lower.contains("@rappter") || lower.contains("@rapp") else {
                lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
                continue
            }

            log("📩 Message from \(msg.isFromMe ? "self" : "other"): \(msg.text.prefix(50))")

            // Strip the @rappter tag before forwarding
            let cleanText = msg.text
                .replacingOccurrences(of: "@rappter", with: "", options: .caseInsensitive)
                .replacingOccurrences(of: "@rapp", with: "", options: .caseInsensitive)
                .trimmingCharacters(in: .whitespacesAndNewlines)

            // Forward to daemon
            await forwardToDaemon(text: cleanText.isEmpty ? msg.text : cleanText, fromMe: msg.isFromMe, guid: msg.guid)
            lastReadTimestamp = max(lastReadTimestamp, msg.timestamp)
        }
    }
    
    private func forwardToDaemon(text: String, fromMe: Bool, guid: String) async {
        // Call the daemon's chat endpoint and get a response
        guard let url = URL(string: "http://127.0.0.1:18790/rpc") else { return }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        let rpc: [String: Any] = [
            "jsonrpc": "2.0",
            "method": "chat.send",
            "params": [
                "message": text,
                "sessionId": "imessage_self"
            ],
            "id": 1
        ]
        
        request.httpBody = try? JSONSerialization.data(withJSONObject: rpc)
        
        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let result = json["result"] as? [String: Any],
               let content = result["content"] as? String {
                // Strip |||VOICE||| if present
                var reply = content
                if let voiceIdx = reply.range(of: "|||VOICE|||") {
                    reply = String(reply[..<voiceIdx.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
                }
                
                // Send reply via iMessage
                let replyText = "🦖 \(reply)"
                sentByAI.insert(String(replyText.prefix(20)))
                sendMessage(replyText)
            }
        } catch {
            print("[MessageBridge] Daemon call failed: \(error)")
        }
    }
    
    private func sendMessage(_ text: String) {
        let escaped = text
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
        
        let script = """
        tell application "Messages"
            set targetService to 1st account whose service type = iMessage
            set targetBuddy to participant "\(chatIdentifier)" of targetService
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
