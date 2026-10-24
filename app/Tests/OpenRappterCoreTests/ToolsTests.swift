import XCTest
@testable import OpenRappterCore

final class ToolsTests: XCTestCase {
    func testNothingMissingWithTheToolsInstalled() {
        let r: [String: String?] = ["git": "/usr/bin/git", "python3": "/usr/bin/python3"]
        XCTAssertEqual(MindRunner.missingTools(commandLineToolsInstalled: true, resolved: r), [])
    }

    func testAppleStubsCountAsMissingWithoutTheTools() {
        let r: [String: String?] = ["git": "/usr/bin/git", "python3": "/usr/bin/python3"]
        XCTAssertEqual(MindRunner.missingTools(commandLineToolsInstalled: false, resolved: r), ["git", "python3"])
    }

    func testHomebrewToolsAreFineWithoutTheTools() {
        let r: [String: String?] = ["git": "/opt/homebrew/bin/git", "python3": "/usr/bin/python3"]
        XCTAssertEqual(MindRunner.missingTools(commandLineToolsInstalled: false, resolved: r), ["python3"])
    }

    func testAbsentToolIsMissingEvenWithTheTools() {
        let r: [String: String?] = ["git": nil]
        XCTAssertEqual(MindRunner.missingTools(commandLineToolsInstalled: true, resolved: r), ["git", "python3"])
    }

    func testServiceInstalledFollowsThePlist() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("kh-\(UUID().uuidString)")
        let runner = MindRunner(kernelDir: home, kernelHome: home, env: [:])
        // The plist lives under the real ~/Library/LaunchAgents; only read it, never write it from a test.
        XCTAssertEqual(runner.serviceInstalled, FileManager.default.fileExists(atPath: runner.launchAgentURL.path))
    }
}
