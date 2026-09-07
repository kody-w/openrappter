import Foundation
@testable import OpenRappterBarLib

func runSessionStoreTests() async {
    await suite("Session Store") {
        await test("starts with empty sessions") {
            let store = SessionStore(filePath: "/tmp/openrappter-test-sessions-\(UUID().uuidString).json")
            let sessions = await store.getSessions()
            try expect(sessions.isEmpty, "Should have no sessions initially")
        }

        await test("upsert and retrieve session") {
            let store = SessionStore(filePath: "/tmp/openrappter-test-sessions-\(UUID().uuidString).json")
            let session = Session(sessionKey: "sess_1", title: "Test Session")
            await store.upsertSession(session)

            let sessions = await store.getSessions()
            try expectEqual(sessions.count, 1)
            try expectEqual(sessions[0].sessionKey, "sess_1")
            try expectEqual(sessions[0].title, "Test Session")
        }

        await test("delete session") {
            let store = SessionStore(filePath: "/tmp/openrappter-test-sessions-\(UUID().uuidString).json")
            let session = Session(sessionKey: "sess_del")
            await store.upsertSession(session)
            try expectEqual((await store.getSessions()).count, 1)

            await store.deleteSession(sessionKey: "sess_del")
            try expectEqual((await store.getSessions()).count, 0)
        }

        await test("add and retrieve messages") {
            let store = SessionStore(filePath: "/tmp/openrappter-test-sessions-\(UUID().uuidString).json")
            let msg = ChatMessage(role: .user, content: "Hello", sessionKey: "sess_msg")
            await store.addMessage(msg)

            let messages = await store.getMessages(sessionKey: "sess_msg")
            try expectEqual(messages.count, 1)
            try expectEqual(messages[0].content, "Hello")
            try expectEqual(messages[0].role, .user)

            // Session should have been auto-created
            let sessions = await store.getSessions()
            try expectEqual(sessions.count, 1)
            try expectEqual(sessions[0].messageCount, 1)
        }

        await test("clear messages keeps session") {
            let store = SessionStore(filePath: "/tmp/openrappter-test-sessions-\(UUID().uuidString).json")
            let msg = ChatMessage(role: .user, content: "Hello", sessionKey: "sess_clr")
            await store.addMessage(msg)

            await store.clearMessages(sessionKey: "sess_clr")
            let messages = await store.getMessages(sessionKey: "sess_clr")
            try expect(messages.isEmpty, "Messages should be cleared")

            let sessions = await store.getSessions()
            try expectEqual(sessions.count, 1)
        }

        await test("ensureSession creates if missing") {
            let store = SessionStore(filePath: "/tmp/openrappter-test-sessions-\(UUID().uuidString).json")
            let session = await store.ensureSession(sessionKey: "sess_new")
            try expectEqual(session.sessionKey, "sess_new")

            // Calling again returns existing
            let again = await store.ensureSession(sessionKey: "sess_new")
            try expectEqual(again.id, session.id)
            try expectEqual((await store.getSessions()).count, 1)
        }

        await test("sessions sorted by updatedAt descending") {
            let store = SessionStore(filePath: "/tmp/openrappter-test-sessions-\(UUID().uuidString).json")
            let s1 = Session(sessionKey: "old", updatedAt: Date(timeIntervalSince1970: 1000))
            let s2 = Session(sessionKey: "new", updatedAt: Date(timeIntervalSince1970: 2000))
            await store.upsertSession(s1)
            await store.upsertSession(s2)

            let sessions = await store.getSessions()
            try expectEqual(sessions[0].sessionKey, "new")
            try expectEqual(sessions[1].sessionKey, "old")
        }

        await test("sync accepts the live gateway's id and timestamp fields") {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("bar-session-sync-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = SessionStore(filePath: directory.appendingPathComponent("sessions.json").path)
            await store.syncFromGateway(sessions: [[
                "id": "remote", "messageCount": 3,
                "createdAt": "1970-01-01T00:00:00.000Z", "updatedAt": "1970-01-01T00:00:01.250Z",
            ]])
            let session = await store.getSession(sessionKey: "remote")
            try expectEqual(session?.messageCount, 3)
            try expectEqual(session?.createdAt.timeIntervalSince1970, 0)
            try expectEqual(session?.updatedAt.timeIntervalSince1970, 1.25)
        }

        await test("legacy empty-key duplicates are removed without losing unsent messages") {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("bar-session-recovery-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: directory) }
            let file = directory.appendingPathComponent("sessions.json")
            let duplicate = ChatMessage(id: "sent", role: .user, content: "Saved question", sessionKey: "")
            let unsent = ChatMessage(id: "unsent", role: .user, content: "Unsent question", sessionKey: "")
            var cache = SessionCache()
            cache.sessions = [Session(sessionKey: ""), Session(sessionKey: "real")]
            cache.messages = [
                "": [duplicate, unsent],
                "real": [ChatMessage(id: "sent", role: .user, content: "Saved question", sessionKey: "real")],
            ]
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            try encoder.encode(cache).write(to: file)
            let store = SessionStore(filePath: file.path)
            await store.load()
            let sessions = await store.getSessions()
            try expectEqual(sessions.count, 2)
            try expect(!sessions.contains { $0.sessionKey.isEmpty })
            let recovered = sessions.first { $0.sessionKey != "real" }!
            try expectEqual((await store.getMessages(sessionKey: recovered.sessionKey)).map(\.content), ["Unsent question"])
            try expectEqual((await store.getMessages(sessionKey: "real")).count, 1)
            let reopened = SessionStore(filePath: file.path)
            await reopened.load()
            try expectEqual(Set((await reopened.getSessions()).map(\.sessionKey)), Set(sessions.map(\.sessionKey)))
        }
    }
}
