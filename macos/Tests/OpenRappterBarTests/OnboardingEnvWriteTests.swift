import Foundation
@testable import OpenRappterBarLib

/// Saving a token has to actually save it, and must not take the others with it.
///
/// `saveEnvVar` read the file as `(try? String(contentsOfFile:)) ?? ""` and then
/// rewrote it. A file that exists and cannot be decoded therefore became an
/// empty string, and the rewrite replaced every variable in it with the single
/// one being saved. `~/.openrappter/.env` is shared with the CLI — `openrappter
/// models set` keeps `OPENRAPPTER_MODEL` there — so the blast radius was not
/// limited to onboarding's own keys.
///
/// The write was `try?` as well, and `saveManualToken` set `authState = .success`
/// immediately after it. A token that never reached disk looked identical to one
/// that did.
@MainActor
func runOnboardingEnvWriteTests() async {
    await suite("Onboarding env writes") {

        func scratchHome() throws -> String {
            let path = NSTemporaryDirectory() + "onboarding-env-\(UUID().uuidString)"
            try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
            return path
        }

        await test("keeps variables it is not writing") {
            let home = try scratchHome()
            let envPath = home + "/.env"
            try "OPENRAPPTER_MODEL=gpt-4o\nGITHUB_TOKEN=old\n"
                .write(toFile: envPath, atomically: true, encoding: .utf8)

            let model = OnboardingViewModel(homeDir: home)
            model.saveManualToken("new")

            let written = try String(contentsOfFile: envPath, encoding: .utf8)
            try expect(written.contains("OPENRAPPTER_MODEL=gpt-4o"),
                           "the CLI's variable must survive the Bar saving a token")
            try expect(written.contains("GITHUB_TOKEN=new"))
            try expect(!written.contains("GITHUB_TOKEN=old"))
        }

        await test("reports success only when the token reached disk") {
            let home = try scratchHome()
            let model = OnboardingViewModel(homeDir: home)
            model.saveManualToken("new")

            switch model.authState {
            case .success: break
            default: throw AssertionError(description: "expected .success, got \(model.authState)")
            }
        }

        await test("refuses to overwrite a file it could not read") {
            let home = try scratchHome()
            let envPath = home + "/.env"
            // Bytes that are not valid UTF-8: the file exists and decoding fails,
            // which is the case that used to yield "" and take everything with it.
            try Data([0xFF, 0xFE, 0x00, 0x81]).write(to: URL(fileURLWithPath: envPath))
            let before = try Data(contentsOf: URL(fileURLWithPath: envPath))

            let model = OnboardingViewModel(homeDir: home)
            model.saveManualToken("new")

            let after = try Data(contentsOf: URL(fileURLWithPath: envPath))
            try expect(before == after, "an unreadable env file must be left alone")

            switch model.authState {
            case .failed: break
            default: throw AssertionError(description: "expected .failed, got \(model.authState)")
            }
        }

        await test("does not claim auto-start when the plist could not be written") {
            let home = try scratchHome()
            // A directory the write cannot succeed into. `installLaunchAgent`
            // returns before reaching launchctl, so no real launch agent is
            // touched and nothing is loaded.
            let agents = try scratchHome()
            try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: agents)
            defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: agents) }

            let model = OnboardingViewModel(homeDir: home, launchAgentsDir: agents)
            model.installLaunchAgent()

            try expect(model.autoStartInstalled == false,
                       "a plist that was never written must not report auto-start installed")
            try expectNotNil(model.errorMessage)
            try expect(!FileManager.default.fileExists(atPath: agents + "/com.openrappter.daemon.plist"))
        }
    }
}
