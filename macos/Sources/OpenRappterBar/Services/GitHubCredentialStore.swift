import Foundation
import Security

@MainActor
protocol GitHubCredentialStoring {
    func readToken() throws -> String?
    func saveToken(_ token: String) throws
    func removeToken() throws
    func hasRuntimeToken() throws -> Bool
}

extension GitHubCredentialStoring {
    func hasRuntimeToken() throws -> Bool { try readToken() != nil }
}

@MainActor
protocol GitHubKeychainStoring {
    func read() throws -> String?
    func write(_ token: String?) throws
}

struct CredentialFileAccess {
    var exists: (URL) -> Bool
    var read: (URL) throws -> Data
    var write: (URL, Data) throws -> Void
    var remove: (URL) throws -> Void

    static let live = CredentialFileAccess(
        exists: { FileManager.default.fileExists(atPath: $0.path) },
        read: { try Data(contentsOf: $0) },
        write: { url, data in
            let manager = FileManager.default
            try manager.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try data.write(to: url, options: .atomic)
            try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        },
        remove: { try FileManager.default.removeItem(at: $0) }
    )
}

@MainActor
final class LocalEnvironmentFile {
    let url: URL
    private let files: CredentialFileAccess

    init(homeDirectory: String, files: CredentialFileAccess = .live) {
        self.url = URL(fileURLWithPath: homeDirectory).appendingPathComponent(".env")
        self.files = files
    }

    func snapshot() throws -> Data? {
        guard files.exists(url) else { return nil }
        let data = try files.read(url)
        guard String(data: data, encoding: .utf8) != nil else {
            throw GitHubAuthError.persistence("The existing environment file is unreadable. It was not replaced.")
        }
        return data
    }

    func value(for key: String) throws -> String? {
        guard let data = try snapshot(), let text = String(data: data, encoding: .utf8) else { return nil }
        return text.components(separatedBy: "\n").reversed().compactMap { line -> String? in
            guard Self.key(in: line) == key, let separator = line.firstIndex(of: "=") else { return nil }
            var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if value.count >= 2,
               (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            return value
        }.first.flatMap { $0.isEmpty ? nil : $0 }
    }

    func set(_ key: String, value: String?) throws {
        if let value, value.isEmpty || value.contains(where: { $0.isNewline || $0 == "\"" || $0 == "'" }) {
            throw GitHubAuthError.persistence("The credential must be a nonempty, single-line value.")
        }
        let original = try snapshot()
        var lines = String(data: original ?? Data(), encoding: .utf8)!
            .components(separatedBy: "\n")
            .filter { Self.key(in: $0) != key }
        if lines.last == "" { lines.removeLast() }
        if let value { lines.append("\(key)=\(value)") }
        let updated = Data((lines.joined(separator: "\n") + "\n").utf8)
        do {
            try restore(updated)
        } catch {
            do { try restore(original) }
            catch { throw GitHubAuthError.persistence("Saving the environment failed and its original contents could not be restored.") }
            throw GitHubAuthError.persistence("The environment file could not be saved and verified.")
        }
    }

    func restore(_ data: Data?) throws {
        if let data {
            try files.write(url, data)
            guard try files.read(url) == data else {
                throw GitHubAuthError.persistence("Environment read-back verification failed.")
            }
        } else if files.exists(url) {
            try files.remove(url)
            guard !files.exists(url) else {
                throw GitHubAuthError.persistence("The environment file could not be removed.")
            }
        }
    }

    private static func key(in line: String) -> String? {
        var text = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("export ") { text = String(text.dropFirst(7)).trimmingCharacters(in: .whitespaces) }
        guard !text.hasPrefix("#"), let separator = text.firstIndex(of: "=") else { return nil }
        return String(text[..<separator]).trimmingCharacters(in: .whitespaces)
    }
}

@MainActor
final class GitHubCredentialStore: GitHubCredentialStoring {
    private let environment: LocalEnvironmentFile
    private let keychain: any GitHubKeychainStoring

    init(environment: LocalEnvironmentFile, keychain: any GitHubKeychainStoring) {
        self.environment = environment
        self.keychain = keychain
    }

    func readToken() throws -> String? {
        // The daemon consumes .env, so it wins over an older Keychain copy.
        if let token = try environment.value(for: "GITHUB_TOKEN") { return token }
        return try keychain.read()
    }

    func hasRuntimeToken() throws -> Bool {
        try environment.value(for: "GITHUB_TOKEN") != nil
    }

    func saveToken(_ token: String) throws {
        guard !token.isEmpty, token.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }) else {
            throw GitHubAuthError.persistence("The GitHub token is not a valid single-line credential.")
        }
        try replaceToken(token)
    }

    func removeToken() throws {
        try replaceToken(nil)
    }

    private func replaceToken(_ token: String?) throws {
        let originalFile = try environment.snapshot()
        let originalKeychain = try keychain.read()
        if originalKeychain == token, try environment.value(for: "GITHUB_TOKEN") == token { return }
        do {
            if token != nil || originalFile != nil {
                try environment.set("GITHUB_TOKEN", value: token)
            }
            try keychain.write(token)
            guard try keychain.read() == token else {
                throw GitHubAuthError.persistence("Keychain read-back verification failed.")
            }
        } catch {
            var rollbackFailed = false
            do { try environment.restore(originalFile) } catch { rollbackFailed = true }
            do { try keychain.write(originalKeychain) } catch { rollbackFailed = true }
            throw GitHubAuthError.persistence(
                rollbackFailed
                    ? "Credential storage failed; some previous settings could not be restored. Sign-in was not completed."
                    : "Credential storage failed. Previous credentials and settings were preserved."
            )
        }
    }
}

@MainActor
final class SystemGitHubKeychain: GitHubKeychainStoring {
    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.openrappter.bar",
            kSecAttrAccount as String: "github_token",
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
        ]
    }

    func read() throws -> String? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let token = String(data: data, encoding: .utf8) else {
            throw GitHubAuthError.persistence("Keychain is unavailable (status \(status)).")
        }
        return token
    }

    func write(_ token: String?) throws {
        guard let token else {
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw GitHubAuthError.persistence("Keychain removal failed (status \(status)).")
            }
            return
        }
        let value = [kSecValueData as String: Data(token.utf8)]
        var status = SecItemUpdate(query as CFDictionary, value as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(value) { _, new in new } as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            throw GitHubAuthError.persistence("Keychain storage failed (status \(status)).")
        }
    }
}
