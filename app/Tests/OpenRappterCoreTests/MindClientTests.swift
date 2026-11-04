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
    var lastBody: [String: Any] = [:]
    private let queue = DispatchQueue(label: "OpenRappterTests.FakeKernel")
    private var loginStarted = false
    private var loginPollCount = 0
    let healthStatus: String
    let respondToHealth: Bool

    init(healthStatus: String = "ok", respondToHealth: Bool = true) throws {
        self.healthStatus = healthStatus
        self.respondToHealth = respondToHealth
        listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { [weak self] st in
            if case .ready = st, let self { self.port = self.listener.port!.rawValue; ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] c in self?.serve(c) }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success else {
            listener.cancel()
            throw MindError.unreachable("Fake mind did not become ready")
        }
    }

    func stop() { listener.cancel() }

    func serve(_ c: NWConnection) {
        c.start(queue: queue)
        var buf = Data()
        func pump() {
            c.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { data, _, complete, error in
                if let data { buf.append(data) }
                if error != nil || (complete && data?.isEmpty != false) { c.cancel(); return }
                let req = String(decoding: buf, as: UTF8.self)
                // Headers and body may arrive in separate segments: wait for the whole body.
                guard let hdrEnd = req.range(of: "\r\n\r\n") else { return pump() }
                let headers = req[..<hdrEnd.lowerBound]
                let want = headers.split(separator: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
                    .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                let bodyBytes = req[hdrEnd.upperBound...].utf8.count
                if bodyBytes < want { return pump() }
                self.respond(c, req: req, body: String(req[hdrEnd.upperBound...]))
            }
        }
        pump()
    }

    func respond(_ c: NWConnection, req: String, body reqBody: String) {
        let path = req.split(separator: " ").dropFirst().first.map(String.init) ?? ""
        var status = "200 OK", body = "{}"
        let method = req.split(separator: " ").first.map(String.init) ?? ""
        if path == "/login" || path == "/login/poll" {
            XCTAssertEqual(method, "POST")
            XCTAssertEqual(reqBody, "{}", req)
            XCTAssertTrue(req.lowercased().contains("content-type: application/json"))
            if method != "POST" || reqBody != "{}" || !req.lowercased().contains("content-type: application/json") {
                status = "400 Bad Request"
            } else if path == "/login" {
                loginStarted = true
                loginPollCount = 0
                body = #"{"user_code":"ABCD-1234","verification_uri":"https://github.com/login/device"}"#
            } else if !loginStarted {
                status = "409 Conflict"
            } else {
                loginPollCount += 1
                body = loginPollCount == 1 ? #"{"status":"pending"}"# : #"{"status":"success"}"#
            }
        } else if path.hasPrefix("/health") {
            if !respondToHealth {
                c.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, _, _ in c.cancel() }
                return
            }
            body = #"{"status":"\#(healthStatus)","version":"0.6.16","model":"fake","agents":["A","B"],"quarantined":[]}"#
        } else if path.hasPrefix("/chat") {
            if let obj = try? JSONSerialization.jsonObject(with: Data(reqBody.utf8)) as? [String: Any] { self.lastBody = obj }
            if self.hungry {
                // Exactly what grail 0.6.16 returns with no sign-in: HTTP 500 and this text.
                status = "500 Internal Server Error"; body = #"{"error":"Not authenticated. Visit /login in your browser to sign in with GitHub."}"#
            } else {
                body = #"{"schema":"rapp-chat/1.0","status":"success","response":"Hello!\n\n|||VOICE||| Hi there.","content":"Hello!","session_id":"s-1","agent_logs":""}"#
            }
        } else { status = "404 Not Found" }
        let resp = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        c.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in c.cancel() })
    }
}

final class MindClientTests: XCTestCase {
    func testDeviceLoginStartsThenPollsPendingAndSuccess() async throws {
        let mind = try FakeKernel()
        defer { mind.stop() }
        let client = MindClient(baseURL: URL(string: "http://127.0.0.1:\(mind.port)")!, timeout: 5)

        let login = try await client.startLogin()
        XCTAssertEqual(login.code, "ABCD-1234")
        XCTAssertEqual(login.url.absoluteString, "https://github.com/login/device")
        let pending = try await client.loginPoll()
        XCTAssertEqual(pending, "pending")
        let success = try await client.loginPoll()
        XCTAssertEqual(success, "success")
    }

    func testHealthAndChatContract() async throws {
        let k = try FakeKernel()
        defer { k.stop() }
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
        defer { k.stop() }
        let client = MindClient(baseURL: URL(string: "http://127.0.0.1:\(k.port)")!, timeout: 5)
        do { _ = try await client.chat("hello"); XCTFail("expected hungry") }
        catch MindError.hungry(let why) { XCTAssertTrue(why.contains("Not authenticated")) }
    }

    func testRunnerAttachesToFirstLiveCandidate() async throws {
        let k = try FakeKernel()
        defer { k.stop() }
        var runner = MindRunner(kernelDir: URL(fileURLWithPath: "/nonexistent"), env: ["OPENRAPPTER_MIND": "http://127.0.0.1:\(k.port)"])
        runner.candidates = [URL(string: "http://127.0.0.1:1")!] + runner.candidates   // a dead one first
        let attached = await runner.attach()
        XCTAssertEqual(attached?.0.baseURL.port, Int(k.port))
    }
}
