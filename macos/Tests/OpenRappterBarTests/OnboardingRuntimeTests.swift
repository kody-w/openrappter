import Foundation
@testable import OpenRappterBarLib

@MainActor
final class OnboardingTestRuntime {
    var desktop = false
    var installed = true
    var provisions = 0
    var starts = 0
    var verifications: [Bool] = []
    var startFails = false
    var verificationFails = false
    var provisionInstalls = false
    var verificationGate: TestGate?

    func service() -> RuntimePrerequisiteService {
        RuntimePrerequisiteService(dependencies: RuntimePrerequisiteDependencies(
            desktopIsAuthoritative: { self.desktop },
            localRuntimeAvailable: { self.installed },
            provisionVerifiedRuntime: {
                self.provisions += 1
                if self.provisionInstalls { self.installed = true }
            },
            startLocalRuntime: {
                self.starts += 1
                if self.startFails { throw RuntimePrerequisiteError.disconnected }
            },
            verifyGateway: { desktop in
                self.verifications.append(desktop)
                if let gate = self.verificationGate { await gate.wait() }
                if self.verificationFails { throw RuntimePrerequisiteError.incompatible }
            }
        ))
    }
}

@MainActor
func onboardingFixture(
    files: AuthTestFiles? = nil,
    backend: OnboardingTestRuntime? = nil,
    timeout: TimeInterval = 60,
    autoStart: @escaping () async throws -> Void = {}
) -> (OnboardingViewModel, AuthTestFiles, OnboardingTestRuntime) {
    let files = files ?? AuthTestFiles()
    let backend = backend ?? OnboardingTestRuntime()
    let keychain = AuthTestKeychain()
    let store = GitHubCredentialStore(
        environment: LocalEnvironmentFile(homeDirectory: "/onboarding-fixture", files: files.access),
        keychain: keychain
    )
    let auth = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: store))
    let model = OnboardingViewModel(
        homeDir: "/onboarding-fixture",
        authService: auth,
        runtime: backend.service(),
        files: files.access,
        setupTimeout: timeout,
        autoStartInstaller: autoStart
    )
    return (model, files, backend)
}

@MainActor
func runOnboardingRuntimeTests() async {
    await suite("Onboarding runtime prerequisites") {
        await test("first-run uses the shared device flow before verified runtime completion") {
            let files = AuthTestFiles()
            let credentials = AuthTestCredentials()
            let backend = OnboardingTestRuntime()
            var requests = 0
            let auth = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: credentials,
                request: { request in
                    requests += 1
                    if request.url?.path == "/login/device/code" {
                        return ["device_code": "fake-code", "user_code": "ABCD-EFGH", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 1]
                    }
                    return ["access_token": "fake_onboarding_token"]
                }
            ))
            let model = OnboardingViewModel(
                homeDir: "/onboarding-fixture",
                authService: auth,
                runtime: backend.service(),
                files: files.access
            )
            model.advance()
            try expectEqual(model.currentStep, .github)
            model.startGitHubAuth()
            try expect(await auth.login().value)
            guard case .success = model.authState else {
                throw AssertionError(description: "onboarding must reflect the shared auth result")
            }
            try expect(!model.isComplete)
            model.advance()
            model.skipTelegram()
            model.advance()
            await model.retryRuntimeSetup().value
            try expect(model.isComplete)
            try expectEqual(requests, 2)
            try expectEqual(backend.starts, 1)
            try expectEqual(credentials.token, "fake_onboarding_token")
        }

        await test("configured Desktop bypasses the local credential wizard") {
            let backend = OnboardingTestRuntime()
            backend.desktop = true
            backend.installed = false
            let (model, files, _) = onboardingFixture(backend: backend)
            try expect(!model.needsOnboarding)
            try expectEqual(files.writes, 0)
            try expectEqual(backend.starts, 0)
        }

        await test("empty or commented token is not completed onboarding") {
            let files = AuthTestFiles()
            files.contents["/onboarding-fixture/.env"] = Data("# GITHUB_TOKEN=not-a-setting\nGITHUB_TOKEN=\"\"\n".utf8)
            let (model, _, _) = onboardingFixture(files: files)
            try expect(model.needsOnboarding)
            try expect(!model.isComplete)
        }

        await test("a token without an installed runtime still needs setup") {
            let backend = OnboardingTestRuntime()
            backend.installed = false
            let (model, _, _) = onboardingFixture(backend: backend)
            model.saveManualToken("fake_token")
            try expect(model.needsOnboarding)
            await model.retryRuntimeSetup().value
            try expect(!model.isComplete)
            try expectEqual(backend.provisions, 1)
            try expectEqual(backend.starts, 0)
            try expect(model.errorMessage?.contains("not installed") == true)
        }

        await test("provisioning success is rechecked rather than trusted") {
            let backend = OnboardingTestRuntime()
            backend.installed = false
            let (model, files, _) = onboardingFixture(backend: backend)
            model.saveManualToken("fake_token")
            await model.retryRuntimeSetup().value
            try expect(!model.daemonStarted)
            try expectNil(files.contents["/onboarding-fixture/config.json"])
        }

        await test("an injected verified provisioner can install then reach readiness inline") {
            let backend = OnboardingTestRuntime()
            backend.installed = false
            backend.provisionInstalls = true
            let (model, _, _) = onboardingFixture(backend: backend)
            model.saveManualToken("fake_token")
            await model.retryRuntimeSetup().value
            try expect(model.isComplete)
            try expectEqual(backend.provisions, 1)
            try expectEqual(backend.starts, 1)
            try expectEqual(backend.verifications, [false])
        }

        await test("startup failure stays retryable and never writes completion") {
            let backend = OnboardingTestRuntime()
            backend.startFails = true
            let (model, files, _) = onboardingFixture(backend: backend)
            model.saveManualToken("fake_token")
            await model.retryRuntimeSetup().value
            try expectEqual(model.currentStep, .starting)
            try expect(!model.isStarting)
            try expect(!model.isComplete)
            try expectNil(files.contents["/onboarding-fixture/config.json"])
            backend.startFails = false
            await model.retryRuntimeSetup().value
            try expect(model.isComplete)
        }

        await test("an incompatible listening gateway cannot finish setup") {
            let backend = OnboardingTestRuntime()
            backend.verificationFails = true
            let (model, files, _) = onboardingFixture(backend: backend)
            model.saveManualToken("fake_token")
            await model.retryRuntimeSetup().value
            try expect(!model.isComplete)
            try expectNil(files.contents["/onboarding-fixture/config.json"])
        }

        await test("readiness requires chat methods and Desktop authentication methods") {
            do {
                try RuntimePrerequisiteService.requireCompatibleMethods(["ping"], desktop: false)
                throw AssertionError(description: "a generic listener must not qualify")
            } catch is RuntimePrerequisiteError {}
            let chat = ["chat.send", "chat.abort", "chat.list", "chat.messages"]
            try RuntimePrerequisiteService.requireCompatibleMethods(chat, desktop: false)
            do {
                try RuntimePrerequisiteService.requireCompatibleMethods(chat, desktop: true)
                throw AssertionError(description: "Desktop must supply its authority methods")
            } catch is RuntimePrerequisiteError {}
            try RuntimePrerequisiteService.requireCompatibleMethods(
                chat + ["auth.login", "auth.poll", "auth.cancel", "auth.active"], desktop: true
            )
        }

        await test("Desktop selection never provisions or starts a competing daemon") {
            let backend = OnboardingTestRuntime()
            backend.desktop = true
            backend.installed = false
            try expect(try await backend.service().prepare())
            try expectEqual(backend.starts + backend.provisions, 0)
            try expectEqual(backend.verifications, [true])
        }

        await test("completion preserves existing runtime configuration and does not claim optional setup") {
            let files = AuthTestFiles()
            files.contents["/onboarding-fixture/config.json"] = Data(#"{"projectPath":"/kept-runtime","custom":"kept"}"#.utf8)
            var installs = 0
            let (model, _, _) = onboardingFixture(files: files, autoStart: { installs += 1 })
            model.saveManualToken("fake_token")
            await model.retryRuntimeSetup().value
            let config = try JSONSerialization.jsonObject(with: files.contents["/onboarding-fixture/config.json"]!) as! [String: Any]
            try expect(model.isComplete)
            try expectEqual(config["projectPath"] as? String, "/kept-runtime")
            try expectEqual(config["custom"] as? String, "kept")
            try expectEqual(config["gatewayVerified"] as? Bool, true)
            try expectNil(config["copilotAvailable"])
            try expectEqual(installs, 0)
            try expect(!model.autoStartInstalled)
        }

        await test("unreadable configuration is preserved and blocks completion") {
            let files = AuthTestFiles()
            let original = Data("not JSON".utf8)
            files.contents["/onboarding-fixture/config.json"] = original
            let (model, _, _) = onboardingFixture(files: files)
            model.saveManualToken("fake_token")
            await model.retryRuntimeSetup().value
            try expect(!model.isComplete)
            try expectEqual(files.contents["/onboarding-fixture/config.json"], original)
        }

        await test("failed configuration persistence cannot report Done") {
            let files = AuthTestFiles()
            files.refusedWrites.insert("/onboarding-fixture/config.json")
            let (model, _, _) = onboardingFixture(files: files)
            model.saveManualToken("fake_token")
            await model.retryRuntimeSetup().value
            try expect(!model.isComplete)
            try expectNotNil(model.errorMessage)
        }

        await test("cancelled readiness cannot later set Done") {
            let backend = OnboardingTestRuntime()
            let gate = TestGate()
            backend.verificationGate = gate
            let (model, files, _) = onboardingFixture(backend: backend)
            model.saveManualToken("fake_token")
            let pending = model.retryRuntimeSetup()
            await gate.waitUntilEntered()
            model.cancelRuntimeSetup()
            await gate.open()
            await pending.value
            try expect(!model.isComplete)
            try expect(!model.daemonStarted)
            try expectNil(files.contents["/onboarding-fixture/config.json"])
        }

        await test("a stale setup completion cannot overwrite a successful retry") {
            let backend = OnboardingTestRuntime()
            let gate = TestGate()
            backend.verificationGate = gate
            let (model, _, _) = onboardingFixture(backend: backend)
            model.saveManualToken("fake_token")
            let pending = model.retryRuntimeSetup()
            await gate.waitUntilEntered()
            model.cancelRuntimeSetup()
            backend.verificationGate = nil
            await model.retryRuntimeSetup().value
            try expect(model.isComplete)
            await gate.open()
            await pending.value
            try expect(model.isComplete)
            try expectNil(model.errorMessage)
        }

        await test("stalled readiness has a bounded visible failure") {
            let backend = OnboardingTestRuntime()
            let gate = TestGate()
            backend.verificationGate = gate
            let (model, _, _) = onboardingFixture(backend: backend, timeout: 0.01)
            model.saveManualToken("fake_token")
            let pending = model.retryRuntimeSetup()
            await gate.waitUntilEntered()
            for _ in 0..<100 where model.isStarting {
                try await Task.sleep(for: .milliseconds(5))
            }
            try expect(!model.isStarting)
            try expect(model.errorMessage?.contains("timed out") == true)
            await gate.open()
            await pending.value
            try expect(!model.isComplete)
        }
    }
}
