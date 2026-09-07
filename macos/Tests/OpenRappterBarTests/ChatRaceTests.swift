import Foundation
@testable import OpenRappterBarLib

@MainActor
private final class ChatRaceFixture {
    let directory: URL
    let mock = MockWebSocket()
    let connection: GatewayConnection
    let store: SessionStore
    let model = ChatViewModel()
    var tasks: [Task<Void, Never>] = []

    init() {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("bar-races-\(UUID().uuidString)")
        store = SessionStore(filePath: directory.appendingPathComponent("sessions.json").path)
        let transport = mock
        connection = GatewayConnection(host: "127.0.0.1", port: 1, transportFactory: { _ in transport })
    }

    func connect() async throws {
        mock.enqueueReceive(try makeHelloOk())
        try await connection.connect()
        model.configure(rpcClient: RpcClient(connection: connection), sessionStore: store)
    }

    func send(_ text: String) -> Task<Void, Never> {
        model.chatInput = text
        let task = model.sendMessage()
        tasks.append(task)
        return task
    }

    func select(_ session: String) -> Task<Void, Never> {
        let task = model.switchToSession(sessionKey: session)
        tasks.append(task)
        return task
    }

    func abort() -> Task<Void, Never> {
        let task = model.abortChat()
        tasks.append(task)
        return task
    }

    func request(_ count: Int) async throws -> [String: Any] {
        let frames = try await mock.waitForSentCount(count)
        return try JSONSerialization.jsonObject(with: frames[count - 1]) as! [String: Any]
    }

    func reply(_ request: [String: Any], payload: Any) throws {
        mock.enqueueReceive(try JSONSerialization.data(withJSONObject: [
            "type": "res", "id": request["id"] as! String, "ok": true, "payload": payload,
        ]))
    }

    func session(_ request: [String: Any]) throws -> String {
        guard let params = request["params"] as? [String: Any],
              let key = params["sessionKey"] as? String, !key.isEmpty else {
            throw AssertionError(description: "a sent turn must have a nonempty session key")
        }
        return key
    }

    func accept(_ request: [String: Any], run: String) throws {
        try reply(request, payload: [
            "runId": run, "sessionKey": session(request), "status": "accepted", "acceptedAt": 1,
        ] as [String: Any])
    }

    func event(session: String, run: String, state: String = "final", text: String = "Answer") {
        model.handleChatEvent(ChatEventPayload.parse(from: [
            "sessionKey": session, "runId": run, "state": state,
            "message": ["content": [["type": "text", "text": text]]],
        ] as [String: Any])!)
    }

    func close() async {
        model.clearConfiguration()
        await connection.disconnect()
        for task in tasks { await task.value }
        await model.flushPendingMessages()
        try? FileManager.default.removeItem(at: directory)
    }
}

@MainActor
private func withChatRaceFixture(_ body: (ChatRaceFixture) async throws -> Void) async throws {
    let fixture = ChatRaceFixture()
    do {
        try await fixture.connect()
        try await body(fixture)
        await fixture.close()
    } catch {
        await fixture.close()
        throw error
    }
}

@MainActor
func runChatRaceTests() async {
    await suite("Chat ordering and recovery") {
        await test("late acceptance cannot undo New Chat") {
            try await withChatRaceFixture { fixture in
                let send = fixture.send("Old question")
                let request = try await fixture.request(2)
                fixture.model.newSession()
                try fixture.accept(request, run: "old")
                await send.value
                try expectNil(fixture.model.currentSessionKey)
                try expect(fixture.model.messages.isEmpty)
            }
        }

        await test("a final arriving before acceptance is committed once without a stuck spinner") {
            try await withChatRaceFixture { fixture in
                let send = fixture.send("Question")
                let request = try await fixture.request(2)
                let session = try fixture.session(request)
                fixture.event(session: session, run: "fast")
                try expectEqual(fixture.model.messages.count, 1)
                try fixture.accept(request, run: "fast")
                await send.value
                fixture.event(session: session, run: "fast")
                try expectEqual(fixture.model.messages.filter { $0.role == .assistant }.count, 1)
                guard case .idle = fixture.model.chatState else {
                    throw AssertionError(description: "acceptance overwrote a terminal event")
                }
            }
        }

        await test("late history cannot replace the newly selected conversation") {
            try await withChatRaceFixture { fixture in
                let first = fixture.select("first")
                let firstRequest = try await fixture.request(2)
                let second = fixture.select("second")
                let secondRequest = try await fixture.request(3)
                try fixture.reply(secondRequest, payload: [
                    ["id": "second-message", "role": "user", "content": "Second", "timestamp": "1970-01-01T00:00:00.000Z"],
                ])
                await second.value
                try fixture.reply(firstRequest, payload: [
                    ["id": "first-message", "role": "user", "content": "First"],
                ])
                await first.value
                try expectEqual(fixture.model.currentSessionKey, "second")
                try expectEqual(fixture.model.messages.map(\.id), ["second-message"])
                try expectEqual(fixture.model.messages.first?.timestamp.timeIntervalSince1970, 0)
            }
        }

        await test("sending while history loads cannot lose the submitted message") {
            try await withChatRaceFixture { fixture in
                let history = fixture.select("visible")
                let historyRequest = try await fixture.request(2)
                let send = fixture.send("New question")
                let request = try await fixture.request(3)
                try fixture.accept(request, run: "new")
                await send.value
                try fixture.reply(historyRequest, payload: [
                    ["id": "old", "role": "user", "content": "Old history"],
                ])
                await history.value
                try expectEqual(fixture.model.messages.map(\.content), ["New question"])
            }
        }

        await test("a previous run cannot finish a newer run in the same session") {
            try await withChatRaceFixture { fixture in
                let first = fixture.send("First")
                let firstRequest = try await fixture.request(2)
                let session = try fixture.session(firstRequest)
                try fixture.accept(firstRequest, run: "first")
                await first.value
                fixture.event(session: session, run: "first")
                let second = fixture.send("Second")
                let secondRequest = try await fixture.request(3)
                try fixture.accept(secondRequest, run: "second")
                await second.value
                fixture.event(session: session, run: "first", state: "aborted")
                fixture.event(session: session, run: "unrelated")
                guard case .streaming = fixture.model.chatState else {
                    throw AssertionError(description: "an unrelated run stopped the active response")
                }
                fixture.event(session: session, run: "second")
                try expectEqual(fixture.model.messages.filter { $0.role == .assistant }.count, 2)
            }
        }

        await test("disconnect invalidates an outstanding send continuation") {
            try await withChatRaceFixture { fixture in
                let send = fixture.send("Question")
                let request = try await fixture.request(2)
                fixture.model.clearConfiguration()
                try fixture.accept(request, run: "late")
                await send.value
                guard case .error = fixture.model.chatState else {
                    throw AssertionError(description: "late acceptance hid the disconnected state")
                }
            }
        }

        await test("abort carries its run ID and cannot end a different new conversation") {
            try await withChatRaceFixture { fixture in
                let first = fixture.send("First")
                let firstRequest = try await fixture.request(2)
                try fixture.accept(firstRequest, run: "first")
                await first.value
                let abort = fixture.abort()
                let abortRequest = try await fixture.request(3)
                try expectEqual((abortRequest["params"] as? [String: Any])?["runId"] as? String, "first")
                fixture.model.newSession()
                let second = fixture.send("Second")
                let secondRequest = try await fixture.request(4)
                try fixture.accept(secondRequest, run: "second")
                await second.value
                try fixture.reply(abortRequest, payload: ["aborted": true])
                await abort.value
                guard case .streaming = fixture.model.chatState else {
                    throw AssertionError(description: "late abort stopped the new conversation")
                }
            }
        }

        await test("a late abort response cannot stop a new external run in the same session") {
            try await withChatRaceFixture { fixture in
                let send = fixture.send("First")
                let request = try await fixture.request(2)
                let session = try fixture.session(request)
                try fixture.accept(request, run: "first")
                await send.value
                let abort = fixture.abort()
                let abortRequest = try await fixture.request(3)
                fixture.event(session: session, run: "first", state: "aborted")
                fixture.event(session: session, run: "second", state: "delta", text: "New response")
                try fixture.reply(abortRequest, payload: ["aborted": true])
                await abort.value
                guard case .streaming = fixture.model.chatState else {
                    throw AssertionError(description: "late abort stopped an unrelated live run")
                }
                try expectEqual(fixture.model.streamingText, "New response")
            }
        }

        await test("a second submit preserves the draft without dispatching another turn") {
            try await withChatRaceFixture { fixture in
                let first = fixture.send("First")
                let request = try await fixture.request(2)
                let second = fixture.send("Second")
                await second.value
                try expectEqual(fixture.model.messages.count, 1)
                try expectEqual(fixture.model.chatInput, "Second")
                try expectEqual(fixture.mock.sentMessages.count, 2)
                try fixture.accept(request, run: "first")
                await first.value
            }
        }

        await test("off-screen replies remain available after disconnecting") {
            try await withChatRaceFixture { fixture in
                let send = fixture.send("Question in A")
                let request = try await fixture.request(2)
                let session = try fixture.session(request)
                try fixture.accept(request, run: "a")
                await send.value
                fixture.model.newSession()
                fixture.event(session: session, run: "a", text: "A's completed answer")
                try expect(fixture.model.messages.isEmpty)
                await fixture.model.flushPendingMessages()
                fixture.model.clearConfiguration()
                await fixture.select(session).value
                try expectEqual(fixture.model.messages.map(\.content), ["Question in A", "A's completed answer"])
            }
        }

        await test("off-screen final without text uses its own accumulated reply") {
            try await withChatRaceFixture { fixture in
                let send = fixture.send("Question")
                let request = try await fixture.request(2)
                let session = try fixture.session(request)
                try fixture.accept(request, run: "a")
                await send.value
                fixture.event(session: session, run: "a", state: "delta", text: "Partial")
                fixture.model.newSession()
                fixture.event(session: session, run: "a", state: "delta", text: "Completed off-screen")
                fixture.model.handleChatEvent(ChatEventPayload.parse(from: [
                    "sessionKey": session, "runId": "a", "state": "final",
                ])!)
                await fixture.model.flushPendingMessages()
                try expectEqual((await fixture.store.getMessages(sessionKey: session)).last?.content,
                                "Completed off-screen")
            }
        }

        await test("an immediate send does not invalidate same-session cached history") {
            try await withChatRaceFixture { fixture in
                await fixture.store.addMessage(ChatMessage(
                    id: "earlier", role: .assistant, content: "Earlier answer", sessionKey: "visible"
                ))
                let selection = fixture.select("visible")
                let send = fixture.send("New question")
                for count in 2...3 {
                    let request = try await fixture.request(count)
                    if request["method"] as? String == "chat.send" {
                        try fixture.accept(request, run: "new")
                    } else {
                        try expectEqual(request["method"] as? String, "chat.messages")
                        try fixture.reply(request, payload: [
                            ["id": "earlier", "role": "assistant", "content": "Earlier answer"],
                        ])
                    }
                }
                await selection.value
                await send.value
                try expectEqual(fixture.model.messages.map(\.content), ["Earlier answer", "New question"])
            }
        }
    }
}
