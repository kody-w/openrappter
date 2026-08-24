import Foundation
import Security

enum CredentialStoreError: LocalizedError, Equatable {
    case keychain(OSStatus)
    case decodeFailed

    var errorDescription: String? {
        switch self {
        case let .keychain(status):
            return "Keychain refused the operation (OSStatus \(status))."
        case .decodeFailed:
            return "The stored device credential could not be read back."
        }
    }

    /// The simulator can refuse keychain access outright when the running
    /// bundle has no keychain entitlement. Callers surface this rather than
    /// pretending the credential was saved.
    var isMissingEntitlement: Bool {
        self == .keychain(errSecMissingEntitlement)
    }
}

protocol CredentialStoring {
    func save(_ credential: DeviceCredential) async throws
    func load() async throws -> DeviceCredential?
    func clear() async throws
}

/// The device credential's only home.
///
/// An actor because the store is shared by the pairing screen, the gateway
/// client and the revoke control, and none of them should race the others.
actor KeychainCredentialStore: CredentialStoring {
    private let service: String
    private let account: String

    init(service: String = "com.openrappter.rappidfield.device-credential", account: String = "default") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func save(_ credential: DeviceCredential) async throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let data = try encoder.encode(credential)

        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(query as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            return
        case errSecDuplicateItem:
            let update = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            guard update == errSecSuccess else { throw CredentialStoreError.keychain(update) }
        default:
            throw CredentialStoreError.keychain(status)
        }
    }

    func load() async throws -> DeviceCredential? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { throw CredentialStoreError.decodeFailed }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(DeviceCredential.self, from: data)
        case errSecItemNotFound:
            return nil
        default:
            throw CredentialStoreError.keychain(status)
        }
    }

    func clear() async throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CredentialStoreError.keychain(status)
        }
    }
}

/// Used by the synthetic paired mode and by tests. Never persisted anywhere.
actor InMemoryCredentialStore: CredentialStoring {
    private var credential: DeviceCredential?

    init(credential: DeviceCredential? = nil) {
        self.credential = credential
    }

    func save(_ credential: DeviceCredential) async throws { self.credential = credential }
    func load() async throws -> DeviceCredential? { credential }
    func clear() async throws { credential = nil }
}
