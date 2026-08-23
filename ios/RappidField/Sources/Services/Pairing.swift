import Foundation

/// Where authentication lives.
///
/// GitHub and Copilot credentials belong to the host and never travel to a
/// phone. The device receives a scoped, revocable credential that can only
/// speak the RAPPID habitat methods, and the host can revoke it without
/// touching any upstream account.
enum AuthPolicy {
    static let oauthTokensOnDevice = false
    static let deviceCredentialIsScoped = true
    static let deviceCredentialIsRevocableFromHost = true

    static let explanation = """
    Copilot and GitHub stay signed in on your host machine. This phone never \
    sees those tokens. Pairing gives this device its own narrow credential for \
    the RAPPID habitat methods only, and your host can revoke it at any time \
    without signing anything else out.
    """

    /// The only scopes this prototype ever asks for.
    static let requestedScopes = [
        "rappid.list",
        "rappid.asset",
        "rappid.autocomplete",
        "rappid.grow",
    ]
}

/// A one-time pairing code, in an alphabet with no ambiguous glyphs.
struct OneTimeCode: Equatable, CustomStringConvertible {
    static let alphabet = Array("23456789ABCDEFGHJKLMNPQRSTUVWXYZ")
    static let groupLength = 4
    static let groupCount = 3

    let normalised: String

    enum CodeError: LocalizedError, Equatable {
        case wrongLength(Int)
        case badCharacter(Character)

        var errorDescription: String? {
            switch self {
            case let .wrongLength(count):
                return "A link code is \(OneTimeCode.groupLength * OneTimeCode.groupCount) characters; this one has \(count)."
            case let .badCharacter(character):
                return "\"\(character)\" is not part of the link-code alphabet."
            }
        }
    }

    init(_ raw: String) throws {
        let cleaned = raw.uppercased().filter { $0 != "-" && !$0.isWhitespace }
        guard cleaned.count == Self.groupLength * Self.groupCount else {
            throw CodeError.wrongLength(cleaned.count)
        }
        if let bad = cleaned.first(where: { !Self.alphabet.contains($0) }) {
            throw CodeError.badCharacter(bad)
        }
        normalised = cleaned
    }

    /// Display form only. The raw code is never put on the wire.
    var description: String {
        stride(from: 0, to: normalised.count, by: Self.groupLength).map { offset in
            let start = normalised.index(normalised.startIndex, offsetBy: offset)
            let end = normalised.index(start, offsetBy: Self.groupLength)
            return String(normalised[start..<end])
        }.joined(separator: "-")
    }
}

/// What the host shows: an original RAPPID link, as text or as a QR code.
struct RappidLink: Equatable {
    static let scheme = "rappid-link"

    let host: URL
    let code: OneTimeCode
    /// A short host key fingerprint the operator can eyeball. Not a secret.
    let hostFingerprint: String

    enum LinkError: LocalizedError, Equatable {
        case notALink
        case missingField(String)
        case badHost(String)

        var errorDescription: String? {
            switch self {
            case .notALink:
                return "That is not a RAPPID link."
            case let .missingField(field):
                return "The link is missing \(field)."
            case let .badHost(value):
                return "\"\(value)\" is not a host address this app will talk to."
            }
        }
    }

    init(host: URL, code: OneTimeCode, hostFingerprint: String) throws {
        guard let scheme = host.scheme?.lowercased(),
              scheme == "https" || (scheme == "http" && Self.isLoopback(host)) else {
            throw LinkError.badHost(host.absoluteString)
        }
        self.host = host
        self.code = code
        self.hostFingerprint = hostFingerprint
    }

    /// A local host on the loopback interface is allowed over plain HTTP: it
    /// never leaves the device. Everything else must be HTTPS.
    static func isLoopback(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1" || host == "::1"
    }

    init(parsing text: String) throws {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme?.lowercased() == Self.scheme,
              components.host?.lowercased() == "pair" else {
            throw LinkError.notALink
        }
        let items = components.queryItems ?? []
        func value(_ name: String) throws -> String {
            guard let found = items.first(where: { $0.name == name })?.value, !found.isEmpty else {
                throw LinkError.missingField(name)
            }
            return found
        }
        guard let hostURL = URL(string: try value("host")) else {
            throw LinkError.badHost(try value("host"))
        }
        try self.init(
            host: hostURL,
            code: try OneTimeCode(try value("code")),
            hostFingerprint: try value("fp")
        )
    }

    var text: String {
        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = "pair"
        components.queryItems = [
            URLQueryItem(name: "host", value: host.absoluteString),
            URLQueryItem(name: "code", value: code.description),
            URLQueryItem(name: "fp", value: hostFingerprint),
        ]
        return components.string ?? ""
    }
}

/// The pairing payload this device sends to the host.
///
/// It deliberately carries no secret. The one-time code stays on the device
/// and in the operator's eyes; what travels is a proof derived from it, so a
/// captured request cannot be replayed into a second pairing.
struct PairingRequest: Codable, Equatable {
    let schema: String
    let deviceName: String
    /// A random per-install value. Never a hardware or advertising identifier.
    let deviceInstallID: String
    let requestedScopes: [String]
    let nonce: String
    let proof: String

    static let schemaVersion = "rappid-field-pair/1"

    init(deviceName: String, deviceInstallID: String, nonce: String, code: OneTimeCode) {
        self.schema = Self.schemaVersion
        self.deviceName = deviceName
        self.deviceInstallID = deviceInstallID
        self.requestedScopes = AuthPolicy.requestedScopes
        self.nonce = nonce
        self.proof = PairingProof.compute(code: code, nonce: nonce, deviceInstallID: deviceInstallID)
    }
}

enum PairingProof {
    static let domain = "rappid-field/1:pair"

    /// `sha256("<domain>\n<canonical json>")` — domain separated, so a proof
    /// for pairing can never be replayed as a proof for anything else.
    static func compute(code: OneTimeCode, nonce: String, deviceInstallID: String) -> String {
        let body = CanonicalJSON.render(.object([
            "code": .string(code.normalised),
            "device_install_id": .string(deviceInstallID),
            "nonce": .string(nonce),
        ]))
        return Digest.sha256Hex("\(domain)\n\(body)")
    }
}

/// What this device shows the host to be scanned.
///
/// It is an offer, not a secret: a name, a random per-install value, the
/// scopes it wants, and a nonce. A photograph of this QR code gives an
/// onlooker nothing to authenticate with, because the host still requires the
/// one-time code it displayed.
struct PairingOffer: Equatable {
    let schema: String
    let deviceName: String
    let deviceInstallID: String
    let requestedScopes: [String]
    let nonce: String

    init(deviceName: String, deviceInstallID: String, nonce: String) {
        self.schema = PairingRequest.schemaVersion
        self.deviceName = deviceName
        self.deviceInstallID = deviceInstallID
        self.requestedScopes = AuthPolicy.requestedScopes
        self.nonce = nonce
    }

    /// The exact string the QR code carries.
    var qrPayload: String {
        var components = URLComponents()
        components.scheme = "rappid-field"
        components.host = "offer"
        components.queryItems = [
            URLQueryItem(name: "schema", value: schema),
            URLQueryItem(name: "device", value: deviceName),
            URLQueryItem(name: "install", value: deviceInstallID),
            URLQueryItem(name: "scopes", value: requestedScopes.joined(separator: ",")),
            URLQueryItem(name: "nonce", value: nonce),
        ]
        return components.string ?? ""
    }
}

/// What the host returns. The token is the only secret, and it never leaves
/// the Keychain once stored.
struct DeviceCredential: Codable, Equatable, CustomStringConvertible {
    let credentialID: String
    let token: String
    let scopes: [String]
    let hostURL: URL
    let hostFingerprint: String
    let issuedAt: Date
    let expiresAt: Date?
    /// True when this app minted the grant locally because no host was
    /// contacted. It decides whether the habitat is served by a real host or by
    /// deterministic fixtures, so a prototype grant can never make a fixture
    /// look like a verified organism.
    var isSyntheticGrant: Bool = false

    init(
        credentialID: String,
        token: String,
        scopes: [String],
        hostURL: URL,
        hostFingerprint: String,
        issuedAt: Date,
        expiresAt: Date?,
        isSyntheticGrant: Bool = false
    ) {
        self.credentialID = credentialID
        self.token = token
        self.scopes = scopes
        self.hostURL = hostURL
        self.hostFingerprint = hostFingerprint
        self.issuedAt = issuedAt
        self.expiresAt = expiresAt
        self.isSyntheticGrant = isSyntheticGrant
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        credentialID = try container.decode(String.self, forKey: .credentialID)
        token = try container.decode(String.self, forKey: .token)
        scopes = try container.decode([String].self, forKey: .scopes)
        hostURL = try container.decode(URL.self, forKey: .hostURL)
        hostFingerprint = try container.decode(String.self, forKey: .hostFingerprint)
        issuedAt = try container.decode(Date.self, forKey: .issuedAt)
        expiresAt = try container.decodeIfPresent(Date.self, forKey: .expiresAt)
        isSyntheticGrant = try container.decodeIfPresent(Bool.self, forKey: .isSyntheticGrant) ?? false
    }

    /// Redacted on purpose: a credential that prints itself ends up in a log.
    var description: String {
        "DeviceCredential(id: \(credentialID), scopes: \(scopes.joined(separator: ",")), host: \(hostURL.absoluteString), token: <redacted>)"
    }

    func isExpired(at moment: Date = Date()) -> Bool {
        guard let expiresAt else { return false }
        return moment >= expiresAt
    }

    var isScopedToHabitatMethodsOnly: Bool {
        !scopes.isEmpty && scopes.allSatisfy { AuthPolicy.requestedScopes.contains($0) }
    }
}

enum PairingStatus: Equatable {
    case unpaired
    case synthetic
    case paired(DeviceCredential)

    var isPaired: Bool {
        if case .paired = self { return true }
        return false
    }

    var origin: DataOrigin {
        switch self {
        case .unpaired, .synthetic: return .syntheticFixture
        case let .paired(credential): return .pairedHost(credential.hostURL)
        }
    }
}
