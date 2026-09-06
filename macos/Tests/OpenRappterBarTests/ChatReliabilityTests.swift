import Foundation
@testable import OpenRappterBarLib

@MainActor
func runChatReliabilityTests() async {
    await suite("Chat reliability") {
        func event(
            session: String = "visible",
            run: String = "run-1",
            state: String = "final",
            text: String = "An answer"
        ) -> ChatEventPayload {
            ChatEventPayload.parse(from: [
                "sessionKey": session,
                "runId": run,
                "state": state,
                "message": ["content": [["type": "text", "text": text]]],
            ] as [String: Any])!
        }

        await test("foreign session events cannot alter the visible conversation") {
            let model = ChatViewModel()
            model.currentSessionKey = "visible"
            model.chatState = .streaming
            model.streamingText = "Current reply"
            model.handleChatEvent(event(session: "other"))
            try expect(model.messages.isEmpty)
            try expectEqual(model.streamingText, "Current reply")
            guard case .streaming = model.chatState else {
                throw AssertionError(description: "another session ended the current run")
            }
        }

        await test("New Chat cannot be repopulated by a late reply") {
            let model = ChatViewModel()
            model.currentSessionKey = "visible"
            model.newSession()
            model.handleChatEvent(event())
            try expectNil(model.currentSessionKey)
            try expect(model.messages.isEmpty)
        }

        await test("a completed run is committed once, including duplicate events") {
            let model = ChatViewModel()
            model.currentSessionKey = "visible"
            model.handleChatEvent(event())
            model.handleChatEvent(event())
            try expectEqual(model.messages.count, 1)
        }

        await test("a visible session still accepts its own externally started run") {
            let model = ChatViewModel()
            model.currentSessionKey = "visible"
            model.handleChatEvent(event(state: "delta", text: "Partial"))
            try expectEqual(model.streamingText, "Partial")
            model.handleChatEvent(event())
            try expectEqual(model.messages.first?.content, "An answer")
        }

        await test("Return and quick actions cannot send over a pending turn") {
            let model = ChatViewModel()
            model.chatInput = "Another message"
            model.chatState = .sending
            try expect(!model.canSend, "pending acceptance must block another send")
            model.chatState = .streaming
            try expect(!model.canSend, "streaming must block another send")
        }

        await test("first send creates one real session, not an empty-key copy") {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("bar-chat-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = SessionStore(filePath: directory.appendingPathComponent("sessions.json").path)
            let mock = MockWebSocket()
            let connection = GatewayConnection(host: "127.0.0.1", port: 1, transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloOk())
            try await connection.connect()
            let model = ChatViewModel()
            model.configure(rpcClient: RpcClient(connection: connection), sessionStore: store)
            model.chatInput = "First message"
            model.sendMessage()
            let frames = try await mock.waitForSentCount(2)
            let request = try JSONSerialization.jsonObject(with: frames.last!) as! [String: Any]
            let params = request["params"] as? [String: Any]
            let session = params?["sessionKey"] as? String ?? "allocated-session"
            mock.enqueueReceive(try JSONSerialization.data(withJSONObject: [
                "type": "res", "id": request["id"] as! String, "ok": true,
                "payload": ["runId": "accepted-run", "sessionKey": session,
                            "status": "accepted", "acceptedAt": 1],
            ] as [String: Any]))
            for _ in 0..<200 {
                if case .streaming = model.chatState { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            await connection.disconnect()
            guard case .streaming = model.chatState else {
                throw AssertionError(description: "send did not reach accepted state")
            }
            let sessions = await store.getSessions()
            try expectEqual(sessions.map(\.sessionKey), [session])
            try expect((await store.getMessages(sessionKey: "")).isEmpty)
            try expectEqual((await store.getMessages(sessionKey: session)).count, 1)
        }

        await test("cache upserts a message ID rather than duplicating it") {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("bar-cache-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: directory) }
            let store = SessionStore(filePath: directory.appendingPathComponent("sessions.json").path)
            let message = ChatMessage(id: "one-message", role: .user, content: "Hello", sessionKey: "visible")
            await store.addMessage(message)
            await store.addMessage(message)
            try expectEqual((await store.getMessages(sessionKey: "visible")).count, 1)
            try expectEqual((await store.getSession(sessionKey: "visible"))?.messageCount, 1)
        }
    }
}
