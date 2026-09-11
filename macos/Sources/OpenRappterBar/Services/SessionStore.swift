import Foundation

// MARK: - Session Store

/// Persists session and message data locally as JSON.
/// Syncs with the gateway when connected.
public actor SessionStore {
    private let filePath: String
    private var cache: SessionCache

    public init(filePath: String? = nil) {
        let path = filePath ?? (NSHomeDirectory() + "/.openrappter/bar-sessions.json")
        self.filePath = path
        self.cache = SessionCache()
    }

    // MARK: - Load / Save

    public func load() {
        guard FileManager.default.fileExists(atPath: filePath) else { return }
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: filePath))
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            cache = try decoder.decode(SessionCache.self, from: data)
            Log.app.info("Loaded \(self.cache.sessions.count) sessions from cache")
        } catch {
            Log.app.warning("Failed to load session cache: \(error.localizedDescription)")
        }
    }

    public func save() {
        do {
            // Ensure directory exists
            let dir = (filePath as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(cache)
            try data.write(to: URL(fileURLWithPath: filePath))
        } catch {
            Log.app.warning("Failed to save session cache: \(error.localizedDescription)")
        }
    }

    // MARK: - Sessions

    public func getSessions() -> [Session] {
        cache.sessions.sorted { $0.updatedAt > $1.updatedAt }
    }

    public func getSession(sessionKey: String) -> Session? {
        cache.sessions.first { $0.sessionKey == sessionKey }
    }

    public func upsertSession(_ session: Session) {
        if let index = cache.sessions.firstIndex(where: { $0.sessionKey == session.sessionKey }) {
            cache.sessions[index] = session
        } else {
            cache.sessions.append(session)
        }
        save()
    }

    public func deleteSession(sessionKey: String) {
        cache.sessions.removeAll { $0.sessionKey == sessionKey }
        cache.messages.removeValue(forKey: sessionKey)
        save()
    }

    /// Ensure a session exists for the given key, creating one if needed.
    @discardableResult
    public func ensureSession(sessionKey: String) -> Session {
        if let existing = getSession(sessionKey: sessionKey) {
            return existing
        }
        let session = Session(sessionKey: sessionKey)
        cache.sessions.append(session)
        save()
        return session
    }

    // MARK: - Messages

    public func getMessages(sessionKey: String) -> [ChatMessage] {
        cache.messages[sessionKey] ?? []
    }

    public func addMessage(_ message: ChatMessage) {
        var messages = cache.messages[message.sessionKey] ?? []
        messages.append(message)
        cache.messages[message.sessionKey] = messages

        // Update session metadata
        if var session = getSession(sessionKey: message.sessionKey) {
            session.updatedAt = message.timestamp
            session.messageCount = messages.count
            upsertSession(session)
        } else {
            var session = Session(sessionKey: message.sessionKey)
            session.messageCount = messages.count
            upsertSession(session)
        }
    }

    public func clearMessages(sessionKey: String) {
        cache.messages[sessionKey] = []
        if var session = getSession(sessionKey: sessionKey) {
            session.messageCount = 0
            upsertSession(session)
        }
    }

    /// Sync sessions from gateway RPC data.
    public func syncFromGateway(sessions: [[String: Any]]) {
        for sessionData in sessions {
            guard let key = sessionData["sessionKey"] as? String else { continue }
            if getSession(sessionKey: key) == nil {
                let title = sessionData["title"] as? String
                let session = Session(sessionKey: key, title: title)
                cache.sessions.append(session)
            }
        }
        save()
    }
}
