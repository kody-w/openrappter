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
              scheme == "https" || (scheme == "http" && Self.isLoopback(host)),
              host.user == nil,
              host.password == nil,
              host.query == nil,
              host.fragment == nil,
              host.path.isEmpty || host.path == "/",
              hostFingerprint.range(
                of: #"^[0-9a-f]{8}$"#,
                options: .regularExpression
              ) != nil else {
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

struct HostPairingClient {
    let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    func complete(_ requestBody: PairingRequest, with link: RappidLink) async throws -> DeviceCredential {
        let encodedRequest = try JSONEncoder().encode(requestBody)
        guard let params = try JSONSerialization.jsonObject(with: encodedRequest) as? [String: Any] else {
            throw GatewayError.malformedResponse("pairing request could not be encoded")
        }
        let body = try JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0",
            "id": UUID().uuidString,
            "method": "rappid.pairing.complete",
            "params": params,
        ], options: [.sortedKeys])
        var request = URLRequest(url: link.host)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayError.transport("pairing returned no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw GatewayError.rpc(
                code: http.statusCode,
                message: String(decoding: data, as: UTF8.self)
            )
        }
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GatewayError.malformedResponse("pairing response is not JSON-RPC")
        }
        if let error = envelope["error"] as? [String: Any] {
            throw GatewayError.rpc(
                code: error["code"] as? Int ?? -1,
                message: error["message"] as? String ?? "pairing refused"
            )
        }
        guard let result = envelope["result"] as? [String: Any] else {
            throw GatewayError.malformedResponse("pairing response has no credential")
        }
        let credentialData = try JSONSerialization.data(withJSONObject: result)
        let credential = try JSONDecoder().decode(DeviceCredential.self, from: credentialData)
        guard !credential.isSyntheticGrant,
              !credential.credentialID.isEmpty,
              !credential.token.isEmpty,
              !credential.isExpired(),
              credential.hostURL == link.host,
              credential.hostFingerprint == link.hostFingerprint,
              credential.isScopedToHabitatMethodsOnly,
              Set(credential.scopes) == Set(requestBody.requestedScopes) else {
            throw GatewayError.malformedResponse(
                "pairing credential is not bound to this host link and requested scope"
            )
        }
        return credential
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

    private enum CodingKeys: String, CodingKey {
        case credentialID
        case token
        case scopes
        case hostURL
        case hostFingerprint
        case issuedAt
        case expiresAt
        case isSyntheticGrant
    }

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
        issuedAt = try Self.decodeDate(container, key: .issuedAt)
        expiresAt = try Self.decodeOptionalDate(container, key: .expiresAt)
        isSyntheticGrant = try container.decodeIfPresent(Bool.self, forKey: .isSyntheticGrant) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(credentialID, forKey: .credentialID)
        try container.encode(token, forKey: .token)
        try container.encode(scopes, forKey: .scopes)
        try container.encode(hostURL, forKey: .hostURL)
        try container.encode(hostFingerprint, forKey: .hostFingerprint)
        try container.encode(Self.dateText(issuedAt), forKey: .issuedAt)
        if let expiresAt {
            try container.encode(Self.dateText(expiresAt), forKey: .expiresAt)
        }
        try container.encode(isSyntheticGrant, forKey: .isSyntheticGrant)
    }

    private static func dateText(_ value: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: value)
    }

    private static func date(_ text: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }

    private static func decodeDate(
        _ container: KeyedDecodingContainer<CodingKeys>,
        key: CodingKeys
    ) throws -> Date {
        let text = try container.decode(String.self, forKey: key)
        guard let parsed = date(text) else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: container,
                debugDescription: "date is not ISO 8601"
            )
        }
        return parsed
    }

    private static func decodeOptionalDate(
        _ container: KeyedDecodingContainer<CodingKeys>,
        key: CodingKeys
    ) throws -> Date? {
        guard let text = try container.decodeIfPresent(String.self, forKey: key) else {
            return nil
        }
        guard let parsed = date(text) else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: container,
                debugDescription: "date is not ISO 8601"
            )
        }
        return parsed
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
