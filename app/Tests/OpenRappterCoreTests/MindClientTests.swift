import XCTest
import Foundation
import Network
@testable import OpenRappterCore

/// A tiny fake kernel on a loopback port: answers /health and /chat in the rapp-chat/1.0 shape.
/// Keeps the client contract honest without a live Brainstem.
final class FakeKernel: @unchecked Sendable {
    let listener: NWListener
    private(set) var port: UInt16 = 0
    var hungry = false
    var noCopilot = false      // signed in, account has no Copilot (grail 0.6.16 shapes)
    var busy = false           // Copilot rate-limited: 502 with the kernel's plain sentence
    var version = "0.6.16"
    var lastBody: [String: Any] = [:]

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] st in
            if case .ready = st, let self { self.port = self.listener.port!.rawValue; ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] c in self?.serve(c) }
        listener.start(queue: .global())
        _ = ready.wait(timeout: .now() + 5)
    }

    func serve(_ c: NWConnection) {
        c.start(queue: .global())
        var buf = Data()
        func pump() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, _, _ in
                if let data { buf.append(data) }
                let req = String(decoding: buf, as: UTF8.self)
                // Headers and body may arrive in separate segments: wait for the whole body.
                guard let hdrEnd = req.range(of: "\r\n\r\n") else { return pump() }
                let headers = req[..<hdrEnd.lowerBound]
                let want = headers.split(separator: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
                    .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                let bodyBytes = buf.count - req.distance(from: req.startIndex, to: hdrEnd.upperBound)
                if bodyBytes < want { return pump() }
                self.respond(c, req: req, body: String(req[hdrEnd.upperBound...]))
            }
        }
        pump()
    }

    func respond(_ c: NWConnection, req: String, body reqBody: String) {
        let path = req.split(separator: " ").dropFirst().first.map(String.init) ?? ""
        var status = "200 OK", body = "{}"
        if path.hasPrefix("/health") {
            if self.noCopilot {
                // grail 0.6.16 /health for a signed-in account with no Copilot: status stays "ok".
                body = #"{"status":"ok","version":"\#(self.version)","model":"fake","agents":[],"quarantined":[],"copilot":"no_access","copilot_username":"kody"}"#
            } else {
                body = #"{"status":"ok","version":"\#(self.version)","model":"fake","agents":["A","B"],"quarantined":[]}"#
            }
        } else if path.hasPrefix("/chat") {
            if let obj = try? JSONSerialization.jsonObject(with: Data(reqBody.utf8)) as? [String: Any] { self.lastBody = obj }
            if self.hungry {
                // Exactly what grail 0.6.16 returns with no sign-in: HTTP 500 and this text.
                status = "500 Internal Server Error"; body = #"{"error":"Not authenticated. Visit /login in your browser to sign in with GitHub."}"#
            } else if self.noCopilot {
                // Exactly what grail 0.6.16 returns for a signed-in account with no Copilot: HTTP 200, no `response`.
                body = #"{"error":"NO_COPILOT_ACCESS:kody","no_copilot_access":true,"copilot_username":"kody"}"#
            } else if self.busy {
                // Exactly what grail 0.6.16 returns when Copilot rate-limits.
                status = "502 Bad Gateway"; body = #"{"error":"Copilot usage limit reached — wait a minute and try again.","model":"fake","detail":"429"}"#
            } else {
                body = #"{"schema":"rapp-chat/1.0","status":"success","response":"Hello!\n\n|||VOICE||| Hi there.","content":"Hello!","session_id":"s-1","agent_logs":""}"#
            }
        } else { status = "404 Not Found" }
        let resp = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        c.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in c.cancel() })
    }
}

final class MindClientTests: XCTestCase {
    func testHealthAndChatContract() async throws {
        let k = try FakeKernel()
        let client = MindClient(baseURL: URL(string: "http://127.0.0.1:\(k.port)")!, timeout: 5)
        let h = try await client.health()
        XCTAssertEqual(h, MindHealth(status: "ok", version: "0.6.16", model: "fake", agentCount: 2))
        let r = try await client.chat("hello", sessionId: "s-1")
        XCTAssertEqual(r.text, "Hello!")
        XCTAssertEqual(r.voice, "Hi there.")
        XCTAssertEqual(r.sessionId, "s-1")
        // Both the rapp-chat/1.0 field and the legacy alias go out, so any kernel answers.
        XCTAssertEqual(k.lastBody["message"] as? String, "hello")
        XCTAssertEqual(k.lastBody["user_input"] as? String, "hello")
        XCTAssertEqual(k.lastBody["session_id"] as? String, "s-1")
    }

    func testHungryKernelIsHungryNotCrash() async throws {
        let k = try FakeKernel(); k.hungry = true
        let client = MindClient(baseURL: URL(string: "http://127.0.0.1:\(k.port)")!, timeout: 5)
        do { _ = try await client.chat("hello"); XCTFail("expected hungry") }
        catch MindError.hungry(let why) { XCTAssertTrue(why.contains("Not authenticated")) }
    }

    func testSignedInWithoutCopilotIsNoCopilotNotFed() async throws {
        let k = try FakeKernel(); k.noCopilot = true
        let client = MindClient(baseURL: URL(string: "http://127.0.0.1:\(k.port)")!, timeout: 5)
        let h = try await client.health()
        XCTAssertFalse(h.isHungry)                       // a sign-in will not fix this
        XCTAssertTrue(h.needsCopilot)                    // and it is not "fed" either
        XCTAssertEqual(h.copilotUsername, "kody")
        do { _ = try await client.chat("hello"); XCTFail("expected noCopilot") }
        catch MindError.noCopilot(let sentence) {
            XCTAssertTrue(sentence.contains("kody"), sentence)
            XCTAssertTrue(sentence.contains("can't use Copilot yet"), sentence)
            XCTAssertFalse(sentence.contains("NO_COPILOT_ACCESS"), sentence)   // the creature speaks plain words
        }
    }

    func testKernelFailureSentenceIsKept() async throws {
        let k = try FakeKernel(); k.busy = true
        let client = MindClient(baseURL: URL(string: "http://127.0.0.1:\(k.port)")!, timeout: 5)
        do { _ = try await client.chat("hello"); XCTFail("expected badBody") }
        catch MindError.badBody(let why) { XCTAssertTrue(why.contains("wait a minute"), why) }
    }

    func testHealthAuthErrorIsStillHungry() throws {
        // grail 0.6.16 /health with a bad stored GitHub sign-in: unauthenticated + auth_error. Sign in again fixes it.
        let h = MindHealth(status: "unauthenticated", version: "0.6.16", model: "m", agentCount: 0, authError: "invalid_credentials")
        XCTAssertTrue(h.isHungry); XCTAssertFalse(h.needsCopilot)
        XCTAssertEqual(MindError.noCopilotSentence(""), "This GitHub account can't use Copilot yet. Turn it on at github.com/settings/copilot, then ask me again.")
    }

    func testRunnerAttachesToFirstLiveCandidate() async throws {
        let k = try FakeKernel()
        var runner = MindRunner(kernelDir: URL(fileURLWithPath: "/nonexistent"), env: ["OPENRAPPTER_MIND": "http://127.0.0.1:\(k.port)"])
        runner.candidates = [URL(string: "http://127.0.0.1:1")!] + runner.candidates   // a dead one first
        let attached = await runner.attach()
        XCTAssertEqual(attached?.0.baseURL.port, Int(k.port))
    }
}
