import AVFoundation
import Speech
import XCTest
@testable import OpenRappterCore

final class DoctorGuidanceRegressionTests: XCTestCase {
    func testFirstPermissionRequestPointsToTheHotkeyNotAnEmptySettingsPane() async throws {
        let kernel = try FakeKernel()
        defer { kernel.stop() }
        let home = try testDirectory(self)
        for (microphone, speech) in [(AVAuthorizationStatus.notDetermined, SFSpeechRecognizerAuthorizationStatus.authorized),
                                     (.authorized, .notDetermined), (.notDetermined, .notDetermined)] {
            let report = await Doctor.check(env: ["HOME": home.path, "OPENRAPPTER_MIND": "http://127.0.0.1:\(kernel.port)"],
                                            microphone: microphone, speech: speech)
            XCTAssertEqual(report.next, "Hold Option and Space once in OpenRappter and allow the permission prompts.")
            XCTAssertFalse(report.next.contains("System Settings"))
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: home.path), [])
    }

    func testDeniedPermissionsPointToSettingsAndRestrictedPermissionsToTheMacManager() async throws {
        let kernel = try FakeKernel()
        defer { kernel.stop() }
        let home = try testDirectory(self)
        let env = ["HOME": home.path, "OPENRAPPTER_MIND": "http://127.0.0.1:\(kernel.port)"]
        for (mic, speech) in [(AVAuthorizationStatus.denied, SFSpeechRecognizerAuthorizationStatus.authorized),
                              (.authorized, .denied)] {
            let report = await Doctor.check(env: env, microphone: mic, speech: speech)
            XCTAssertEqual(report.next, "Allow OpenRappter to use the microphone and speech recognition in System Settings.")
        }
        for (mic, speech) in [(AVAuthorizationStatus.restricted, SFSpeechRecognizerAuthorizationStatus.authorized),
                              (.authorized, .restricted), (.denied, .restricted)] {
            let report = await Doctor.check(env: env, microphone: mic, speech: speech)
            XCTAssertEqual(report.next, "This Mac's rules block permission to hear you; ask whoever manages it.")
            XCTAssertFalse(report.next.contains("System Settings"))
        }
    }

    func testSignedInAccountWithoutCopilotGetsAnEnableCopilotStepNotAnotherFeeding() async throws {
        let kernel = try FakeKernel(copilot: "no_access")
        defer { kernel.stop() }
        let home = try testDirectory(self)
        let report = await Doctor.check(env: ["HOME": home.path, "OPENRAPPTER_MIND": "http://127.0.0.1:\(kernel.port)"],
                                        microphone: .authorized, speech: .authorized)
        XCTAssertEqual(report.checks[0].status, "no-copilot")
        XCTAssertEqual(report.checks[0].words, "You're signed in, but that GitHub account has no Copilot.")
        XCTAssertEqual(report.next, "Enable Copilot for that GitHub account, or use one that has it, then choose Sign in to my mind.")
        XCTAssertFalse(report.next.contains("feed me"))
        let decoded = try JSONDecoder().decode(DoctorReport.self, from: Data(try report.output(json: true).utf8))
        XCTAssertEqual(decoded.checks[0].status, "no-copilot")
        XCTAssertEqual(decoded.next, report.next)
    }

    func testStoppedLoginChoiceIsObservedWithoutNaggingOrChangingIt() async throws {
        let kernel = try FakeKernel()
        defer { kernel.stop() }
        let home = try testDirectory(self)
        let preference = StartupPreference(home: home)
        try preference.stop()
        let before = try Data(contentsOf: preference.url)
        let report = await Doctor.check(env: ["HOME": home.path, "OPENRAPPTER_MIND": "http://127.0.0.1:\(kernel.port)"],
                                        microphone: .authorized, speech: .authorized)
        XCTAssertEqual(report.checks[3].status, "off-by-choice")
        XCTAssertEqual(report.checks[3].words, "You've told me not to start on my own.")
        XCTAssertEqual(report.next, "Everything is ready; hold Option and Space to talk to me.")
        XCTAssertEqual(try Data(contentsOf: preference.url), before)
        XCTAssertFalse(FileManager.default.fileExists(atPath: Doctor.loginItemURL(home: home).path))
    }

    func testEnvironmentOptOutIsAlsoAnIntentionalChoice() async throws {
        let kernel = try FakeKernel()
        defer { kernel.stop() }
        let home = try testDirectory(self)
        let report = await Doctor.check(env: [
            "HOME": home.path, "OPENRAPPTER_MIND": "http://127.0.0.1:\(kernel.port)", "OPENRAPPTER_NO_LOGIN_ITEM": "1",
        ], microphone: .authorized, speech: .authorized)
        XCTAssertEqual(report.checks[3].status, "off-by-choice")
        XCTAssertEqual(report.next, "Everything is ready; hold Option and Space to talk to me.")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: home.path), [])
    }

    func testOptionalStartupAdviceSaysThisMacStartsNotGitHubSignIn() async throws {
        let kernel = try FakeKernel()
        defer { kernel.stop() }
        let home = try testDirectory(self)
        let report = await Doctor.check(env: ["HOME": home.path, "OPENRAPPTER_MIND": "http://127.0.0.1:\(kernel.port)"],
                                        microphone: .authorized, speech: .authorized)
        XCTAssertEqual(report.checks[3].status, "missing")
        XCTAssertEqual(report.next, "Everything works. To have me return each time this Mac starts, open OpenRappter from your Applications folder once.")
        XCTAssertFalse(report.next.contains("sign in"))
    }
}
