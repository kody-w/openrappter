import AVFoundation
import Foundation
import Speech
import XCTest
@testable import OpenRappterCore

final class DoctorTests: XCTestCase {
    func testMindReadyAndHungryAgainstFakeMind() async throws {
        for (health, expected) in [("ok", "ok"), ("unauthenticated", "hungry"), ("unknown", "unreachable")] {
            let mind = try FakeKernel(healthStatus: health)
            defer { mind.stop() }
            let check = await Doctor.checkMind(address: "http://127.0.0.1:\(mind.port)")
            XCTAssertEqual(check.name, "mind")
            XCTAssertEqual(check.status, expected)
        }
    }

    func testMindUnreachableAndInvalidAddresses() async {
        for address in ["http://127.0.0.1:1", "", "/relative", "file:///tmp/mind", "http://"] {
            let start = Date()
            let check = await Doctor.checkMind(address: address)
            XCTAssertEqual(check.status, "unreachable")
            XCTAssertLessThan(Date().timeIntervalSince(start), 20)
        }
    }

    func testMindThatNeverAnswersFinishesWithinTwentySeconds() async throws {
        let mind = try FakeKernel(respondToHealth: false)
        defer { mind.stop() }
        let start = Date()
        let check = await Doctor.checkMind(address: "http://127.0.0.1:\(mind.port)")
        XCTAssertEqual(check.status, "unreachable")
        XCTAssertLessThan(Date().timeIntervalSince(start), 20)
    }

    func testPermissionsDescribeEveryKnownStateWithoutAsking() {
        let microphone: [(AVAuthorizationStatus, String)] = [
            (.authorized, "ok"), (.notDetermined, "needed"), (.denied, "blocked"), (.restricted, "restricted"),
        ]
        let speech: [(SFSpeechRecognizerAuthorizationStatus, String)] = [
            (.authorized, "ok"), (.notDetermined, "needed"), (.denied, "blocked"), (.restricted, "restricted"),
        ]
        for (status, expected) in microphone {
            XCTAssertEqual(Doctor.microphoneCheck(status).status, expected)
        }
        for (status, expected) in speech {
            XCTAssertEqual(Doctor.speechCheck(status).status, expected)
        }
    }

    func testLoginItemIsReadOnlyAndChecksItsSavedSettings() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let item = Doctor.loginItemURL(home: home)
        XCTAssertEqual(Doctor.loginItemCheck(at: item).status, "missing")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: home.path), [])

        try FileManager.default.createDirectory(at: item.deletingLastPathComponent(), withIntermediateDirectories: true)
        let settings: [String: Any] = [
            "Label": Doctor.loginItemLabel, "RunAtLoad": true, "KeepAlive": true,
            "ProgramArguments": ["/usr/bin/true"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: settings, format: .xml, options: 0)
        try data.write(to: item)
        XCTAssertEqual(Doctor.loginItemCheck(at: item).status, "ok")
        XCTAssertEqual(try Data(contentsOf: item), data)

        var broken = settings
        broken["RunAtLoad"] = false
        try PropertyListSerialization.data(fromPropertyList: broken, format: .xml, options: 0).write(to: item)
        XCTAssertEqual(Doctor.loginItemCheck(at: item).status, "needs-attention")
        broken = settings
        broken["ProgramArguments"] = ["/missing/OpenRappter"]
        try PropertyListSerialization.data(fromPropertyList: broken, format: .xml, options: 0).write(to: item)
        XCTAssertEqual(Doctor.loginItemCheck(at: item).status, "needs-attention")

        let unreadable = Data("not a saved setting".utf8)
        try unreadable.write(to: item)
        XCTAssertEqual(Doctor.loginItemCheck(at: item).status, "unreadable")
        XCTAssertEqual(try Data(contentsOf: item), unreadable)
    }

    func testReportShapePlainWordsAndReadOnlyHomeInAllMindStates() async throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        for state in ["ok", "hungry", "unreachable"] {
            let mind = try FakeKernel(healthStatus: state == "hungry" ? "unauthenticated" : "ok")
            defer { mind.stop() }
            let address = state == "unreachable" ? "http://127.0.0.1:1" : "http://127.0.0.1:\(mind.port)"
            let start = Date()
            let report = await Doctor.check(env: [
                "HOME": home.path, "OPENRAPPTER_MIND": address,
                "OPENRAPPTER_OWN_MIND": "1", "OPENRAPPTER_NO_LAUNCH": "1",
            ])
            XCTAssertLessThan(Date().timeIntervalSince(start), 20)
            XCTAssertEqual(report.checks.map(\.name), ["mind", "microphone", "speech", "login-item"])
            XCTAssertEqual(report.checks.first?.status, state)
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: home.path), [])
            let encoded = try report.output(json: true)
            let decoded = try JSONDecoder().decode(DoctorReport.self, from: Data(encoded.utf8))
            XCTAssertEqual(decoded.checks, report.checks)
            XCTAssertEqual(decoded.next, report.next)
            XCTAssertTrue((8...140).contains(report.next.count))
            XCTAssertEqual(try report.output(json: false).split(separator: "\n").count, 5)
            for words in report.checks.map(\.words) + [report.next] {
                XCTAssertFalse(words.isEmpty)
                XCTAssertLessThanOrEqual(words.count, 140)
                for jargon in ["kernel", "launchd", "plist", "json", "http", "port", "socket", "token", "process"] {
                    XCTAssertFalse(words.lowercased().contains(jargon), "\(words) contains \(jargon)")
                }
            }
        }
    }
}
