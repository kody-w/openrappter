import Foundation
@testable import OpenRappterBarLib

@MainActor
final class AuthTestCredentials: GitHubCredentialStoring {
    var token: String?
    var failSave = false
    var failRemove = false
    var reads = 0
    var saves = 0
    var removals = 0

    func readToken() throws -> String? { reads += 1; return token }
    func saveToken(_ token: String) throws {
        saves += 1
        if failSave { throw GitHubAuthError.persistence("Fake storage refused") }
        self.token = token
    }
    func removeToken() throws {
        removals += 1
        if failRemove { throw GitHubAuthError.persistence("Fake removal refused") }
        token = nil
    }
}

@MainActor
final class AuthTestKeychain: GitHubKeychainStoring {
    var token: String?
    var rejectedToken: String?
    var writes = 0
    func read() throws -> String? { token }
    func write(_ token: String?) throws {
        writes += 1
        if let token, token == rejectedToken { throw GitHubAuthError.persistence("Fake Keychain refused") }
        self.token = token
    }
}

@MainActor
final class AuthTestFiles {
    var contents: [String: Data] = [:]
    var refusedWrites: Set<String> = []
    var writes = 0
    var access: CredentialFileAccess {
        CredentialFileAccess(
            exists: { self.contents[$0.path] != nil },
            read: {
                guard let data = self.contents[$0.path] else { throw CocoaError(.fileReadNoSuchFile) }
                return data
            },
            write: { url, data in
                self.writes += 1
                if self.refusedWrites.contains(url.path) { throw CocoaError(.fileWriteNoPermission) }
                self.contents[url.path] = data
            },
            remove: { self.contents.removeValue(forKey: $0.path) }
        )
    }
}

@MainActor
final class AuthTestGateway: GatewayAuthenticating {
    var beginCount = 0
    var polls = 0
    var cancels = 0
    var failPoll = false
    var failCancel = false
    var cancellationCompleted = false
    var cancellationMissing = false
    var pending = false
    var profile: GatewayAuthProfile?
    var beginGate: TestGate?
    var pollGate: TestGate?

    func beginGatewayAuthentication() async throws -> GatewayAuthLoginResponse {
        beginCount += 1
        if let beginGate { await beginGate.wait() }
        return try JSONDecoder().decode(GatewayAuthLoginResponse.self, from: Data(
            #"{"userCode":"ABCD-EFGH","verificationUri":"https://github.com/login/device","deviceCode":"fake-device"}"#.utf8
        ))
    }
    func pollGatewayAuthentication(deviceCode: String) async throws -> GatewayAuthPollResponse {
        polls += 1
        if let pollGate { await pollGate.wait() }
        if failPoll { throw GatewayConnectionError.notConnected }
        return try JSONDecoder().decode(GatewayAuthPollResponse.self, from: Data(
            (pending ? #"{"status":"pending"}"# : #"{"status":"success","username":"fixture-user"}"#).utf8
        ))
    }
    func cancelGatewayAuthentication(deviceCode: String) async throws -> GatewayAuthCancelResponse {
        cancels += 1
        if failCancel { throw GatewayConnectionError.notConnected }
        let response = cancellationCompleted
            ? #"{"ok":false,"status":"completed"}"#
            : cancellationMissing
                ? #"{"ok":false,"status":"missing"}"#
                : #"{"ok":true,"status":"cancelled"}"#
        return try JSONDecoder().decode(GatewayAuthCancelResponse.self, from: Data(response.utf8))
    }
    func activeGatewayAuthProfile() async throws -> GatewayAuthProfile? { profile }
    func removeGatewayAuthProfile(id: String) async throws { profile = nil }
}

@MainActor
final class AuthTestClock {
    var date = Date(timeIntervalSince1970: 1_000)
    var sleeps: [TimeInterval] = []
    func sleep(_ interval: TimeInterval) async throws {
        try Task.checkCancellation()
        sleeps.append(interval)
        date.addTimeInterval(interval)
        await Task.yield()
    }
}

@MainActor
func fakeAuthDependencies(
    credentials: any GitHubCredentialStoring,
    clock: AuthTestClock? = nil,
    desktop: @escaping () -> Bool = { false },
    request: @escaping (URLRequest) async throws -> [String: Any] = { _ in throw GitHubAuthError.invalidResponse },
    browser: @escaping (URL) -> Bool = { _ in true }
) -> GitHubAuthDependencies {
    let clock = clock ?? AuthTestClock()
    return GitHubAuthDependencies(
        credentials: credentials,
        request: { requestValue in
            let body = try await request(requestValue)
            return (
                try JSONSerialization.data(withJSONObject: body),
                HTTPURLResponse(url: requestValue.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            )
        },
        openBrowser: browser,
        desktopIsAuthoritative: desktop,
        sleep: { try await clock.sleep($0) },
        now: { clock.date }
    )
}

@MainActor
func runGitHubAuthReliabilityTests() async {
    await suite("GitHub auth reliability") {
        await test("first-run device flow obtains a real code, honors slow_down, and verifies persistence") {
            let credentials = AuthTestCredentials()
            let clock = AuthTestClock()
            var tokenPolls = 0
            var opened: [String] = []
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: credentials,
                clock: clock,
                request: { request in
                    if request.url?.path == "/login/device/code" {
                        return ["device_code": "fake-code", "user_code": "ABCD-EFGH", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 2]
                    }
                    tokenPolls += 1
                    return tokenPolls == 1 ? ["error": "slow_down"] : ["access_token": "fake_saved_token"]
                },
                browser: { opened.append($0.absoluteString); return true }
            ))
            var codes: [String] = []
            let succeeded = await service.login { code, _ in codes.append(code) }.value
            try expect(succeeded)
            try expectEqual(codes, ["ABCD-EFGH"])
            try expectEqual(opened, ["https://github.com/login/device"])
            try expectEqual(clock.sleeps, [2, 7])
            try expectEqual(credentials.token, "fake_saved_token")
            try expectEqual(service.authState, .authenticated)
        }

        await test("persistence refusal never becomes authenticated") {
            let credentials = AuthTestCredentials()
            credentials.failSave = true
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: credentials))
            try expect(!service.saveManualToken("fake_token"))
            try expectEqual(service.authState, .unauthenticated)
            try expectNotNil(service.error)
        }

        await test("OAuth success cannot conceal failed credential persistence") {
            let credentials = AuthTestCredentials()
            credentials.token = "fake_old"
            credentials.failSave = true
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: credentials,
                request: { request in
                    if request.url?.path == "/login/device/code" {
                        return ["device_code": "fake-code", "user_code": "ABCD-EFGH", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 1]
                    }
                    return ["access_token": "fake_new"]
                }
            ))
            try expect(!(await service.login().value))
            try expectEqual(service.authState, .unauthenticated)
            try expectEqual(credentials.token, "fake_old")
            try expectNotNil(service.error)
        }

        await test("existing-token authentication also requires persistence to succeed") {
            let credentials = AuthTestCredentials()
            credentials.token = "fake_existing"
            credentials.failSave = true
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: credentials,
                request: { _ in ["login": "fixture-user"] }
            ))
            try expect(!(await service.useExistingCredentials().value))
            try expectEqual(service.authState, .unauthenticated)
            try expectNotNil(service.error)
        }

        await test("Desktop without a connected authority never falls back to local OAuth or storage") {
            let credentials = AuthTestCredentials()
            var requests = 0
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: credentials, desktop: { true },
                request: { _ in requests += 1; return [:] }
            ))
            let result = await service.login().value
            try expect(!result)
            try expectEqual(requests, 0)
            try expectEqual(credentials.reads, 0)
            try expectEqual(credentials.saves, 0)
        }

        await test("Desktop authentication uses its gateway and never touches local credentials") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            let service = GitHubAuthService(
                dependencies: fakeAuthDependencies(credentials: credentials, desktop: { true }),
                gateway: gateway
            )
            try expect(await service.login().value)
            try expectEqual(gateway.beginCount, 1)
            try expectEqual(gateway.polls, 1)
            try expectEqual(credentials.reads + credentials.saves, 0)
            try expectEqual(service.username, "fixture-user")
        }

        await test("late device-code response after cancellation cannot reopen the browser") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            let gate = TestGate()
            gateway.beginGate = gate
            var opens = 0
            let service = GitHubAuthService(
                dependencies: fakeAuthDependencies(credentials: credentials, browser: { _ in opens += 1; return true }),
                gateway: gateway
            )
            let login = service.login()
            await gate.waitUntilEntered()
            await service.cancelLogin().value
            await gate.open()
            try expect(!(await login.value))
            try expectEqual(opens, 0)
            try expectEqual(gateway.cancels, 1)
            try expect(service.userCode.isEmpty)
            try expectEqual(service.authState, .unauthenticated)
        }

        await test("late successful poll after cancellation cannot authenticate") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            let gate = TestGate()
            gateway.pollGate = gate
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: credentials), gateway: gateway)
            let login = service.login()
            await gate.waitUntilEntered()
            await service.cancelLogin().value
            await gate.open()
            try expect(!(await login.value))
            try expectEqual(service.authState, .unauthenticated)
            try expectEqual(gateway.cancels, 1)
        }

        await test("gateway transport failure and cancellation retries are bounded") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            gateway.failPoll = true
            gateway.failCancel = true
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: credentials), gateway: gateway)
            try expect(!(await service.login().value))
            try expectEqual(gateway.polls, 3)
            try expectEqual(gateway.cancels, 3)
            try expectEqual(service.authState, .unauthenticated)
            try expect(service.error?.contains("cancellation could not be confirmed") == true)
        }

        await test("pending gateway authorization expires instead of polling forever") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            gateway.pending = true
            var dependencies = fakeAuthDependencies(credentials: credentials)
            dependencies.maximumLoginDuration = 3
            let service = GitHubAuthService(dependencies: dependencies, gateway: gateway)
            try expect(!(await service.login().value))
            try expectEqual(gateway.polls, 3)
            try expect(service.error?.contains("expired") == true)
        }

        await test("duplicate login requests join one device flow") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            let gate = TestGate()
            gateway.beginGate = gate
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: credentials), gateway: gateway)
            let first = service.login()
            await gate.waitUntilEntered()
            let second = service.login()
            await gate.open()
            try expect(await first.value)
            try expect(await second.value)
            try expectEqual(gateway.beginCount, 1)
        }

        await test("retry never advertises the previous device code before requesting a new one") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: credentials), gateway: gateway)
            try expect(await service.login().value)
            try expect(service.userCode.isEmpty)
            let gate = TestGate()
            gateway.beginGate = gate
            var codes: [String] = []
            let second = service.login { code, _ in codes.append(code) }
            await gate.waitUntilEntered()
            try expect(codes.isEmpty)
            await gate.open()
            try expect(await second.value)
            try expectEqual(codes, ["ABCD-EFGH"])
        }

        await test("cancellation truthfully reports authentication that already completed on Desktop") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            gateway.cancellationCompleted = true
            gateway.profile = try JSONDecoder().decode(GatewayAuthProfile.self, from: Data(#"{"id":"fixture","username":"fixture-user"}"#.utf8))
            let gate = TestGate()
            gateway.pollGate = gate
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: credentials), gateway: gateway)
            let login = service.login()
            await gate.waitUntilEntered()
            await service.cancelLogin().value
            try expectEqual(service.authState, .authenticated)
            try expect(service.error?.contains("already completed") == true)
            await gate.open()
            try expect(!(await login.value))
        }

        await test("an expired missing Desktop flow is reconciled without endless cancellation retries") {
            let credentials = AuthTestCredentials()
            let gateway = AuthTestGateway()
            gateway.cancellationMissing = true
            let gate = TestGate()
            gateway.pollGate = gate
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: credentials), gateway: gateway)
            let login = service.login()
            await gate.waitUntilEntered()
            await service.cancelLogin().value
            try expectEqual(gateway.cancels, 1)
            try expectEqual(service.authState, .unauthenticated)
            try expectNil(service.error)
            await gate.open()
            try expect(!(await login.value))
        }

        await test("a denied local device flow offers a clean retry") {
            let credentials = AuthTestCredentials()
            var denied = true
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: credentials,
                request: { request in
                    if request.url?.path == "/login/device/code" {
                        return ["device_code": "fake-code", "user_code": "ABCD-EFGH", "verification_uri": "https://github.com/login/device", "expires_in": 900, "interval": 1]
                    }
                    return denied ? ["error": "access_denied"] : ["access_token": "fake_retry_token"]
                }
            ))
            try expect(!(await service.login().value))
            denied = false
            try expect(await service.login().value)
            try expectNil(service.error)
            try expectEqual(credentials.saves, 1)
        }

        await test("logout storage failure does not falsely claim removal") {
            let credentials = AuthTestCredentials()
            credentials.token = "fake_existing_token"
            credentials.failRemove = true
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(credentials: credentials))
            await service.logout().value
            try expectEqual(service.authState, .unknown)
            try expectNotNil(service.error)
            try expectEqual(credentials.token, "fake_existing_token")
        }

        await test("environment updates preserve other keys and remove duplicate token assignments") {
            let files = AuthTestFiles()
            let environment = LocalEnvironmentFile(homeDirectory: "/fixture", files: files.access)
            files.contents[environment.url.path] = Data("# keep\nOPENRAPPTER_MODEL=fixture\nexport GITHUB_TOKEN='old'\n GITHUB_TOKEN = old_again\n".utf8)
            let keychain = AuthTestKeychain()
            let store = GitHubCredentialStore(environment: environment, keychain: keychain)
            try store.saveToken("fake_new")
            let text = String(data: files.contents[environment.url.path]!, encoding: .utf8)!
            try expect(text.contains("# keep\nOPENRAPPTER_MODEL=fixture\n"))
            try expectEqual(text.components(separatedBy: "GITHUB_TOKEN").count, 2)
            try expectEqual(try environment.value(for: "GITHUB_TOKEN"), "fake_new")
            try expectEqual(keychain.token, "fake_new")
        }

        await test("unreadable environment is never clobbered or partially migrated to Keychain") {
            let files = AuthTestFiles()
            let environment = LocalEnvironmentFile(homeDirectory: "/fixture", files: files.access)
            let original = Data([0xFF, 0xFE])
            files.contents[environment.url.path] = original
            let keychain = AuthTestKeychain()
            let store = GitHubCredentialStore(environment: environment, keychain: keychain)
            do {
                try store.saveToken("fake_new")
                throw AssertionError(description: "unreadable environment should refuse the write")
            } catch is GitHubAuthError {}
            try expectEqual(files.contents[environment.url.path], original)
            try expectEqual(files.writes + keychain.writes, 0)
        }

        await test("Keychain failure restores the exact previous environment and credential") {
            let files = AuthTestFiles()
            let environment = LocalEnvironmentFile(homeDirectory: "/fixture", files: files.access)
            let original = Data("OPENRAPPTER_MODEL=fixture\nGITHUB_TOKEN=fake_old\n".utf8)
            files.contents[environment.url.path] = original
            let keychain = AuthTestKeychain()
            keychain.token = "fake_old"
            keychain.rejectedToken = "fake_new"
            let store = GitHubCredentialStore(environment: environment, keychain: keychain)
            do {
                try store.saveToken("fake_new")
                throw AssertionError(description: "Keychain refusal must fail the transaction")
            } catch is GitHubAuthError {}
            try expectEqual(files.contents[environment.url.path], original)
            try expectEqual(keychain.token, "fake_old")
        }
    }
}
