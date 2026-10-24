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
        } else if path == "/login" {
            if req.hasPrefix("POST") { body = #"{"user_code":"ABCD-1234","verification_uri":"https://github.com/login/device"}"# }
            else { status = "405 Method Not Allowed"; body = "Method Not Allowed" }   // exactly what the grail does to a GET
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

    func testSignInIsAPostThatHandsBackACode() async throws {
        let k = try FakeKernel()
        let client = MindClient(baseURL: URL(string: "http://127.0.0.1:\(k.port)")!, timeout: 5)
        let s = try await client.beginSignIn()
        XCTAssertEqual(s, SignIn(code: "ABCD-1234", url: URL(string: "https://github.com/login/device")!))
    }

    func testSignInParseRejectsJunk() {
        XCTAssertNil(SignIn.parse(Data("Method Not Allowed".utf8)))
        XCTAssertNil(SignIn.parse(Data(#"{"user_code":"","verification_uri":"https://github.com/login/device"}"#.utf8)))
        XCTAssertNil(SignIn.parse(Data(#"{"user_code":"X","verification_uri":"http://evil.example/"}"#.utf8)))
        XCTAssertNotNil(SignIn.parse(Data(#"{"pending":true,"user_code":"3FA0-965E","verification_uri":"https://github.com/login/device","expires_in":892}"#.utf8)))
    }

    func testCandidatesHonourEnv() {
        let d = URL(fileURLWithPath: "/nonexistent")
        XCTAssertEqual(MindRunner(kernelDir: d, env: [:]).candidates.map(\.absoluteString),
                       ["http://127.0.0.1:18790", "http://127.0.0.1:7071"])
        // Never share a Brainstem someone else installed on :7071.
        XCTAssertEqual(MindRunner(kernelDir: d, env: ["OPENRAPPTER_OWN_MIND": "1"]).candidates.map(\.absoluteString),
                       ["http://127.0.0.1:18790"])
        // An explicit mind comes first (evidence runs on Kody's Mac attach to :7181, never :7071).
        let explicit = MindRunner(kernelDir: d, env: ["OPENRAPPTER_MIND": "http://127.0.0.1:7181"]).candidates
        XCTAssertEqual(explicit.first?.port, 7181)
        XCTAssertEqual(explicit.count, 3)
    }

    /// A temp kernelDir + kernelHome with the given pins written as kernel.json (nil = no file).
    private func pinDirs(bundled: (sha: String, version: String)?, installed: (sha: String, version: String)?) throws -> (URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("openrappter-pin-\(UUID().uuidString)")
        let dir = root.appendingPathComponent("kernel"), home = root.appendingPathComponent("home")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: home.appendingPathComponent("launcher"), withIntermediateDirectories: true)
        if let b = bundled { try #"{"sha":"\#(b.sha)","version":"\#(b.version)"}"#.write(to: dir.appendingPathComponent("kernel.json"), atomically: true, encoding: .utf8) }
        if let i = installed { try #"{"sha":"\#(i.sha)","version":"\#(i.version)"}"#.write(to: home.appendingPathComponent("launcher/kernel.json"), atomically: true, encoding: .utf8) }
        return (dir, home)
    }

    func testAttachSkipsOwnKernelBehindThePin() async throws {
        let k = try FakeKernel()   // reports 0.6.16
        let own = URL(string: "http://127.0.0.1:\(k.port)")!
        func runner(_ dir: URL, _ home: URL) -> MindRunner {
            var r = MindRunner(kernelDir: dir, kernelHome: home, env: [:]); r.ownPort = Int(k.port); r.candidates = [own]; return r
        }
        // Same version and sha as the pin: attach.
        var (dir, home) = try pinDirs(bundled: ("aaa", "0.6.16"), installed: ("aaa", "0.6.16"))
        var r = runner(dir, home)
        var h = try await MindClient(baseURL: own).health()
        XCTAssertFalse(r.ownKernelIsStale(h))
        var got = await r.attach(); XCTAssertNotNil(got)
        // The app ships a newer version than the running kernel reports: skip it so the app relaunches the pinned one.
        (dir, home) = try pinDirs(bundled: ("bbb", "0.6.17"), installed: ("aaa", "0.6.16"))
        r = runner(dir, home)
        h = try await MindClient(baseURL: own).health()
        XCTAssertTrue(r.ownKernelIsStale(h))
        got = await r.attach(); XCTAssertNil(got)
        // Same version, but the pin moved to another sha: the service copy tells.
        (dir, home) = try pinDirs(bundled: ("ccc", "0.6.16"), installed: ("aaa", "0.6.16"))
        got = await runner(dir, home).attach(); XCTAssertNil(got)
        // No service copy (kernel started another way): only the version can be compared.
        (dir, home) = try pinDirs(bundled: ("ccc", "0.6.16"), installed: nil)
        got = await runner(dir, home).attach(); XCTAssertNotNil(got)
        // No readable pin: nothing to compare, attach as before.
        (dir, home) = try pinDirs(bundled: nil, installed: ("aaa", "0.6.16"))
        got = await runner(dir, home).attach(); XCTAssertNotNil(got)
        // A kernel that is not ours is never judged by our pin.
        (dir, home) = try pinDirs(bundled: ("bbb", "0.6.17"), installed: nil)
        var other = MindRunner(kernelDir: dir, kernelHome: home, env: [:]); other.candidates = [own]   // ownPort stays 18790
        got = await other.attach(); XCTAssertNotNil(got)
    }

    func testServicePlistCanBeBootedOutLater() {
        let home = URL(fileURLWithPath: "/tmp/openrappter-home")
        let r = MindRunner(kernelDir: URL(fileURLWithPath: "/nonexistent"), kernelHome: home, env: [:])
        let p = r.servicePlist()
        // `launchctl bootout gui/$UID/<Label>` needs the label to match the plist file name.
        XCTAssertEqual(p["Label"] as? String, MindRunner.serviceLabel)
        XCTAssertEqual(r.launchAgentURL.lastPathComponent, "\(MindRunner.serviceLabel).plist")
        XCTAssertEqual(p["ProgramArguments"] as? [String], ["/bin/sh", "/tmp/openrappter-home/launcher/run.sh"])
        XCTAssertEqual((p["EnvironmentVariables"] as? [String: String])?["OPENRAPPTER_KERNEL_PORT"], "18790")
        XCTAssertEqual(p["KeepAlive"] as? Bool, true)
        XCTAssertEqual(p["RunAtLoad"] as? Bool, true)
        XCTAssertNoThrow(try PropertyListSerialization.data(fromPropertyList: p, format: .xml, options: 0))
    }
}
