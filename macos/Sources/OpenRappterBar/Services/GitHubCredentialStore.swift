import Foundation
import Security
import SQLite3

@MainActor
protocol GitHubCredentialStoring {
    func readToken() throws -> String?
    func saveToken(_ token: String) throws
    func removeToken() throws
    func hasRuntimeToken() throws -> Bool
    func fallbackToken() throws -> String?
    func saveToken(_ token: String, authorize: () throws -> Void) throws
    func removeToken(authorize: () throws -> Void) throws
}

extension GitHubCredentialStoring {
    func hasRuntimeToken() throws -> Bool { try readToken() != nil }
    func fallbackToken() throws -> String? { nil }
    func saveToken(_ token: String, authorize: () throws -> Void) throws {
        try authorize()
        try saveToken(token)
    }
    func removeToken(authorize: () throws -> Void) throws {
        try authorize()
        try removeToken()
    }
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
    var transaction: @MainActor (URL, () throws -> Void) throws -> Void = { _, operation in try operation() }

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
        remove: { try FileManager.default.removeItem(at: $0) },
        transaction: { url, operation in try EnvironmentFileTransaction.withLock(url, operation) }
    )
}

@MainActor
enum EnvironmentFileTransaction {
    private static var held: Set<String> = []

    static func withLock(_ url: URL, timeout: Int32 = 5_000, _ operation: () throws -> Void) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]
        )
        let lock = directory.resolvingSymlinksInPath()
            .appendingPathComponent(url.lastPathComponent + ".lock.sqlite3")
        if held.contains(lock.path) { try operation(); return }
        func requireRegularLock() throws {
            guard FileManager.default.fileExists(atPath: lock.path) else { return }
            let attributes = try FileManager.default.attributesOfItem(atPath: lock.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular,
                  (attributes[.referenceCount] as? NSNumber)?.intValue == 1 else {
                throw GitHubAuthError.persistence("The environment lock must be a regular private file.")
            }
        }
        try requireRegularLock()
        var database: OpaquePointer?
        guard sqlite3_open_v2(lock.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let database else {
            if let database { sqlite3_close(database) }
            throw GitHubAuthError.persistence("The environment transaction lock could not be opened.")
        }
        defer { sqlite3_close(database) }
        try requireRegularLock()
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: lock.path)
        sqlite3_busy_timeout(database, timeout)
        guard sqlite3_exec(database, "BEGIN IMMEDIATE", nil, nil, nil) == SQLITE_OK else {
            throw GitHubAuthError.persistence("The environment is being updated elsewhere. Please retry.")
        }
        held.insert(lock.path)
        defer {
            held.remove(lock.path)
            sqlite3_exec(database, "ROLLBACK", nil, nil, nil)
        }
        // This is the same sidecar/SQLite protocol as the managed TypeScript writers.
        guard sqlite3_exec(database, "CREATE TABLE IF NOT EXISTS memory_lock (id INTEGER PRIMARY KEY)", nil, nil, nil) == SQLITE_OK else {
            throw GitHubAuthError.persistence("The environment transaction could not be initialized.")
        }
        try operation()
        guard sqlite3_exec(database, "COMMIT", nil, nil, nil) == SQLITE_OK else {
            throw GitHubAuthError.persistence("The environment transaction could not be committed.")
        }
    }
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

    struct Change {
        let original: Data?
        let written: Data
    }

    func transaction(_ operation: () throws -> Void) throws {
        try files.transaction(url, operation)
    }

    @discardableResult
    func set(_ key: String, value: String?) throws -> Change {
        var result: Change?
        try transaction { result = try setLocked(key, value: value) }
        return result!
    }

    private func setLocked(_ key: String, value: String?) throws -> Change {
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
            try files.write(url, updated)
            guard try self.value(for: key) == value else {
                throw GitHubAuthError.persistence("Environment read-back verification failed.")
            }
        } catch {
            do { _ = try restoreIfUnchanged(Change(original: original, written: updated)) }
            catch { throw GitHubAuthError.persistence("Saving the environment failed and its original contents could not be restored.") }
            throw GitHubAuthError.persistence("The environment file could not be saved and verified.")
        }
        return Change(original: original, written: updated)
    }

    @discardableResult
    func restoreIfUnchanged(_ change: Change) throws -> Bool {
        guard try snapshot() == change.written else { return false }
        try restore(change.original)
        return true
    }

    private func restore(_ data: Data?) throws {
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
        if let token = try keychain.read() { return token }
        return try environment.value(for: "GITHUB_TOKEN")
    }

    func fallbackToken() throws -> String? {
        try environment.value(for: "GITHUB_TOKEN")
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

    func saveToken(_ token: String, authorize: () throws -> Void) throws {
        try environment.transaction {
            try authorize()
            try saveToken(token)
        }
    }

    func removeToken(authorize: () throws -> Void) throws {
        try environment.transaction {
            try authorize()
            try removeToken()
        }
    }

    private func replaceToken(_ token: String?) throws {
        try environment.transaction { try replaceTokenLocked(token) }
    }

    private func replaceTokenLocked(_ token: String?) throws {
        let originalFile = try environment.snapshot()
        let originalKeychain = try keychain.read()
        if originalKeychain == token, try environment.value(for: "GITHUB_TOKEN") == token { return }
        var change: LocalEnvironmentFile.Change?
        var touchedKeychain = false
        do {
            if token != nil || originalFile != nil {
                change = try environment.set("GITHUB_TOKEN", value: token)
            }
            touchedKeychain = true
            try keychain.write(token)
            guard try keychain.read() == token else {
                throw GitHubAuthError.persistence("Keychain read-back verification failed.")
            }
        } catch {
            var rollbackFailed = false
            var interveningChange = false
            if let change {
                do { interveningChange = try !environment.restoreIfUnchanged(change) }
                catch { rollbackFailed = true }
            }
            if touchedKeychain {
                do {
                    let current = try keychain.read()
                    if current == token { try keychain.write(originalKeychain) }
                    else if current != originalKeychain { interveningChange = true }
                } catch { rollbackFailed = true }
            }
            throw GitHubAuthError.persistence(
                rollbackFailed
                    ? "Credential storage failed; some previous settings could not be restored. Sign-in was not completed."
                    : interveningChange
                    ? "Credential storage failed. Newer settings were preserved; sign-in was not completed."
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
