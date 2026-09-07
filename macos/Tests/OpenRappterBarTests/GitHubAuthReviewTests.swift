import Foundation
import SQLite3
@testable import OpenRappterBarLib

@MainActor
private final class InterveningKeychain: GitHubKeychainStoring {
    var token: String?
    var beforeWrite: ((String?) throws -> Void)?
    func read() throws -> String? { token }
    func write(_ token: String?) throws {
        try beforeWrite?(token)
        self.token = token
    }
}

@MainActor
func runGitHubAuthReviewTests() async {
    await suite("Authentication ownership and migration") {
        await test("verification failure never restores a snapshot over another writer's model update") {
            let files = AuthTestFiles()
            let url = URL(fileURLWithPath: "/fixture/.env")
            files.contents[url.path] = Data("OPENRAPPTER_MODEL=original\nGITHUB_TOKEN=fake_old\n".utf8)
            var access = files.access
            let write = access.write
            var intervened = false
            access.write = { path, data in
                try write(path, data)
                if !intervened {
                    intervened = true
                    files.contents[path.path] = Data(
                        String(data: data, encoding: .utf8)!
                            .replacingOccurrences(of: "OPENRAPPTER_MODEL=original", with: "OPENRAPPTER_MODEL=other_writer")
                            .utf8
                    )
                }
            }
            let keychain = AuthTestKeychain()
            keychain.token = "fake_old"
            keychain.rejectedToken = "fake_new"
            let store = GitHubCredentialStore(
                environment: LocalEnvironmentFile(homeDirectory: "/fixture", files: access),
                keychain: keychain
            )
            do {
                try store.saveToken("fake_new")
                throw AssertionError(description: "the fake Keychain must refuse")
            } catch is GitHubAuthError {}
            try expect(String(data: files.contents[url.path]!, encoding: .utf8)!.contains("OPENRAPPTER_MODEL=other_writer"))
        }

        await test("rollback never deletes a file another writer created") {
            let files = AuthTestFiles()
            let environment = LocalEnvironmentFile(homeDirectory: "/fixture", files: files.access)
            let foreign = Data("OPENRAPPTER_MODEL=other_writer\n".utf8)
            let keychain = InterveningKeychain()
            keychain.beforeWrite = { token in
                if token == "fake_new" {
                    files.contents[environment.url.path] = foreign
                    throw GitHubAuthError.persistence("Fake Keychain failure")
                }
            }
            let store = GitHubCredentialStore(environment: environment, keychain: keychain)
            do {
                try store.saveToken("fake_new")
                throw AssertionError(description: "the fake Keychain must refuse")
            } catch is GitHubAuthError {}
            try expectEqual(files.contents[environment.url.path], foreign)
        }

        await test("checking legacy divergent credentials never replaces the valid Keychain copy") {
            let files = AuthTestFiles()
            let environment = LocalEnvironmentFile(homeDirectory: "/fixture", files: files.access)
            let original = Data("GITHUB_TOKEN=fake_stale_env\n".utf8)
            files.contents[environment.url.path] = original
            let keychain = AuthTestKeychain()
            keychain.token = "fake_newer_keychain"
            let store = GitHubCredentialStore(environment: environment, keychain: keychain)
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: store, request: { _ in ["login": "fixture-user"] }
            ))
            await service.checkAuthStatus().value
            try expectEqual(keychain.token, "fake_newer_keychain")
            try expectEqual(files.contents[environment.url.path], original)
            try expectEqual(keychain.writes + files.writes, 0)
        }

        await test("existing-token validation cannot save locally after Desktop takes authority") {
            let credentials = AuthTestCredentials()
            credentials.token = "fake_existing"
            let gate = TestGate()
            var desktop = false
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: credentials, desktop: { desktop },
                request: { _ in await gate.wait(); return ["login": "local-user"] }
            ))
            let task = service.useExistingCredentials()
            await gate.waitUntilEntered()
            desktop = true
            await gate.open()
            try expect(!(await task.value))
            try expectEqual(credentials.saves, 0)
            try expect(service.authState != .authenticated)
        }

        await test("authority is checked again after waiting for the environment transaction") {
            let files = AuthTestFiles()
            var access = files.access
            var desktop = false
            access.transaction = { _, operation in
                desktop = true
                try operation()
            }
            let keychain = AuthTestKeychain()
            let store = GitHubCredentialStore(
                environment: LocalEnvironmentFile(homeDirectory: "/fixture", files: access),
                keychain: keychain
            )
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: store, desktop: { desktop }
            ))
            try expect(!service.saveManualToken("fake_new"))
            try expectEqual(files.writes + keychain.writes, 0)
        }

        await test("a rejected legacy Keychain token can use a validated environment fallback without startup writes") {
            let files = AuthTestFiles()
            let environment = LocalEnvironmentFile(homeDirectory: "/fixture", files: files.access)
            files.contents[environment.url.path] = Data("GITHUB_TOKEN=fake_valid_env\n".utf8)
            let keychain = AuthTestKeychain()
            keychain.token = "fake_invalid_keychain"
            let store = GitHubCredentialStore(environment: environment, keychain: keychain)
            let service = GitHubAuthService(dependencies: fakeAuthDependencies(
                credentials: store,
                request: { request in
                    if request.value(forHTTPHeaderField: "Authorization")?.contains("fake_invalid_keychain") == true {
                        throw GitHubAuthError.requestFailed(401)
                    }
                    return ["login": "valid-user"]
                }
            ))
            await service.checkAuthStatus().value
            try expectEqual(service.username, "valid-user")
            try expectEqual(keychain.token, "fake_invalid_keychain")
            try expectEqual(files.writes + keychain.writes, 0)
            try expect(await service.useExistingCredentials().value)
            try expectEqual(keychain.token, "fake_valid_env")
        }

        await test("managed environment writes honor the shared SQLite lock and support nested token updates") {
            let directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("bar-env-lock-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: directory) }
            let environment = LocalEnvironmentFile(homeDirectory: directory.path)
            var database: OpaquePointer?
            try expectEqual(sqlite3_open(environment.url.path + ".lock.sqlite3", &database), SQLITE_OK)
            defer { sqlite3_close(database) }
            try expectEqual(sqlite3_exec(database, "BEGIN IMMEDIATE", nil, nil, nil), SQLITE_OK)
            do {
                try EnvironmentFileTransaction.withLock(environment.url, timeout: 1) {
                    throw AssertionError(description: "another connection owns the environment transaction")
                }
                throw AssertionError(description: "a held transaction must refuse the writer")
            } catch is GitHubAuthError {}
            try expectEqual(sqlite3_exec(database, "ROLLBACK", nil, nil, nil), SQLITE_OK)
            try environment.transaction {
                try environment.set("OPENRAPPTER_MODEL", value: "fixture")
            }
            try expectEqual(try environment.value(for: "OPENRAPPTER_MODEL"), "fixture")
        }
    }
}
