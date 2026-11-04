import Foundation
import XCTest
@testable import OpenRappterCore

final class MindFixtureProtocol: URLProtocol, @unchecked Sendable {
    static var reply: (URLRequest) -> (Int, String) = { _ in (500, "{}") }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, body) = Self.reply(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

final class MindProtocolRegressionTests: XCTestCase {
    func client(_ reply: @escaping (URLRequest) -> (Int, String)) -> MindClient {
        MindFixtureProtocol.reply = reply
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MindFixtureProtocol.self]
        var mind = MindClient(baseURL: URL(string: "https://fake-mind.invalid")!)
        mind.session = URLSession(configuration: configuration)
        addTeardownBlock { mind.session.invalidateAndCancel() }
        return mind
    }

    func testCopilotAccessRequiredByHealthAndChat() async throws {
        let mind = client { request in
            if request.url?.path == "/health" {
                return (200, #"{"status":"ok","copilot":"no_access","version":"fake","agents":[]}"#)
            }
            return (200, #"{"error":"NO_COPILOT_ACCESS:owner","no_copilot_access":true}"#)
        }
        let health = try await mind.health()
        XCTAssertTrue(health.isHungry)
        XCTAssertEqual(health.copilot, "no_access")
        do { _ = try await mind.chat("Hello"); XCTFail("An account without Copilot must not be treated as unreachable") }
        catch { XCTAssertEqual(error as? MindError, .noCopilot) }
    }

    func testLoginProgressKeepsFailureReason() async throws {
        for reason in ["Login failed: access_denied", "NO_COPILOT_ACCESS:owner", "No login in progress"] {
            let mind = client { request in
                XCTAssertEqual(request.httpMethod, "POST")
                XCTAssertEqual(request.url?.path, "/login/poll")
                return (200, #"{"status":"error","error":"\#(reason)"}"#)
            }
            let progress = try await mind.loginProgress()
            XCTAssertEqual(progress.error, reason)
            XCTAssertEqual(progress.status, "error")
            XCTAssertEqual(progress.denied, reason.contains("access_denied"))
            XCTAssertEqual(progress.noCopilot, reason.contains("NO_COPILOT_ACCESS"))
            XCTAssertEqual(progress.lost, reason.contains("No login"))
        }
    }

    func testInvalidHealthNeverAttachesAsFed() async throws {
        for body in ["{}", #"{"status":"starting"}"#, "not a reply"] {
            let mind = client { _ in (200, body) }
            do { _ = try await mind.health(); XCTFail("Invalid health cannot mean ready") } catch { }
        }
    }

    func testMalformedSignInResultIsNotFifteenMinutesOfPending() async throws {
        for body in ["{}", #"{"status":"unknown"}"#, #"{"status":42}"#] {
            let mind = client { _ in (200, body) }
            do { _ = try await mind.loginProgress(); XCTFail("Missing sign-in outcome must be an error") } catch { }
        }
    }

    func testDeviceCodeRequiresSafePageAndNonemptyCode() async throws {
        for body in [
            #"{"user_code":"","verification_uri":"https://github.com/login/device"}"#,
            #"{"user_code":"ABCD","verification_uri":"file:///private/anything"}"#,
            #"{"user_code":"ABCD","verification_uri":"/relative"}"#,
        ] {
            let mind = client { _ in (200, body) }
            do { _ = try await mind.startLogin(); XCTFail("Invalid sign-in page must not open") } catch { }
        }
    }
}
