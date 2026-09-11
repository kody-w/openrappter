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
    }
}
