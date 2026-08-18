import Foundation
@testable import OpenRappterBarLib

/// Pressing Stop has to do something visible.
///
/// `abortChat` caught its failure and did nothing with it — the comment said
/// "Silently ignore abort failures". `chatState` is only set to `.idle` on the
/// success path, and the Stop button only renders `if case .streaming`, so a
/// failed abort left the UI streaming with a button that did nothing however
/// many times it was pressed, and nothing to say the request had not landed.
@MainActor
func runChatAbortFailureTests() async {
    await suite("Chat abort failures") {

        func errorFrame(requestId: String, message: String) throws -> Data {
            try JSONSerialization.data(withJSONObject: [
                "type": "res",
                "id": requestId,
                "ok": false,
                "error": ["code": -32000, "message": message],
            ] as [String: Any])
        }

        func connectedClient() async throws -> (MockWebSocket, RpcClient) {
            let mock = MockWebSocket()
            let conn = GatewayConnection(transportFactory: { _ in mock })
            mock.enqueueReceive(try makeHelloOk(requestId: "rpc-1"))
            try await conn.connect()
            return (mock, RpcClient(connection: conn))
        }

        await test("a refused abort leaves the UI able to say so") {
            let (mock, rpc) = try await connectedClient()
            let vm = ChatViewModel()
            vm.configure(rpcClient: rpc, sessionStore: SessionStore())
            vm.currentSessionKey = "session-1"
            vm.chatState = .streaming

            vm.abortChat()

            // The response must not be enqueued until the request has actually
            // been sent: the mock's receive loop is already parked, and would
            // otherwise dequeue and discard it before `sendRequest` registers
            // the pending continuation for that id. Documented at
            // `withDeferredResponse` in RpcClientContractTests.
            let sent = try await mock.waitForSentCount(2)
            guard let data = sent.last,
                  let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let requestId = frame["id"] as? String else {
                throw AssertionError(description: "could not read the abort request id")
            }
            mock.enqueueReceive(try errorFrame(requestId: requestId, message: "no active stream"))

            for _ in 0..<80 {
                if case .streaming = vm.chatState {
                    try? await Task.sleep(for: .milliseconds(25))
                } else {
                    break
                }
            }

            switch vm.chatState {
            case .error(let message):
                try expect(message.contains("Could not stop the response"),
                           "the failure has to name what did not happen, got: \(message)")
            default:
                throw AssertionError(
                    description: "expected .error after a refused abort, got \(vm.chatState)")
            }
        }
    }
}
