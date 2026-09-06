import Foundation
@testable import OpenRappterBarLib

@MainActor
func runOnboardingEnvWriteTests() async {
    await suite("Onboarding env writes") {
        await test("keeps variables it is not writing") {
            let files = AuthTestFiles()
            files.contents["/onboarding-fixture/.env"] = Data("OPENRAPPTER_MODEL=gpt-4o\nGITHUB_TOKEN=old\n".utf8)
            let (model, _, _) = onboardingFixture(files: files)
            model.saveManualToken("new")
            let written = String(data: files.contents["/onboarding-fixture/.env"]!, encoding: .utf8)!
            try expect(written.contains("OPENRAPPTER_MODEL=gpt-4o"))
            try expect(written.contains("GITHUB_TOKEN=new"))
            try expect(!written.contains("GITHUB_TOKEN=old"))
        }

        await test("reports credential success only after verified persistence") {
            let (model, files, _) = onboardingFixture()
            model.saveManualToken("new")
            guard case .success = model.authState else {
                throw AssertionError(description: "expected a verified credential save")
            }
            try expectNotNil(files.contents["/onboarding-fixture/.env"])
            try expect(!model.isComplete, "saving a credential alone is not runtime readiness")
        }

        await test("refuses to overwrite a file it could not read") {
            let files = AuthTestFiles()
            let original = Data([0xFF, 0xFE, 0x00, 0x81])
            files.contents["/onboarding-fixture/.env"] = original
            let (model, _, _) = onboardingFixture(files: files)
            model.saveManualToken("new")
            try expectEqual(files.contents["/onboarding-fixture/.env"], original)
            guard case .failed = model.authState else {
                throw AssertionError(description: "unreadable credential storage must be visible")
            }
        }

        await test("does not claim auto-start when its installer refuses") {
            let (model, _, _) = onboardingFixture(autoStart: { throw CocoaError(.fileWriteNoPermission) })
            model.saveManualToken("new")
            model.wantsAutoStart = true
            await model.retryRuntimeSetup().value
            try expect(!model.autoStartInstalled)
            try expect(!model.isComplete)
            try expectNotNil(model.errorMessage)
        }

        await test("onboarding delegates auto-start to the same manager as Settings") {
            let path = #filePath.replacingOccurrences(
                of: "Tests/OpenRappterBarTests/OnboardingEnvWriteTests.swift",
                with: "Sources/OpenRappterBar/ViewModels/OnboardingViewModel.swift"
            )
            let source = try String(contentsOfFile: path, encoding: .utf8)
            try expect(source.contains("LaunchAgentManager("))
            try expect(source.contains(".setEnabled("))
            try expect(!source.contains("com.openrappter.daemon.plist"))
            try expect(!source.contains("shellStatus"))
        }

        await test("daemon startup is delegated instead of spawned from a data path") {
            let path = #filePath.replacingOccurrences(
                of: "Tests/OpenRappterBarTests/OnboardingEnvWriteTests.swift",
                with: "Sources/OpenRappterBar/ViewModels/OnboardingViewModel.swift"
            )
            let source = try String(contentsOfFile: path, encoding: .utf8)
            try expect(!source.contains("Process()"))
            try expect(!source.contains("isPortOpen"))
            try expect(source.contains("runtime.prepare()"))
        }
    }
}
