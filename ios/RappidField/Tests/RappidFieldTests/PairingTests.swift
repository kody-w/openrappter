import XCTest
@testable import RappidField

final class PairingTests: XCTestCase {
    private let code = try! OneTimeCode("H7K2-9QMR-3TVX")
    private let host = URL(string: "https://studio.local:8787")!

    func testNoOAuthCredentialEverLivesOnTheDevice() {
        XCTAssertFalse(AuthPolicy.oauthTokensOnDevice)
        XCTAssertTrue(AuthPolicy.deviceCredentialIsScoped)
        XCTAssertTrue(AuthPolicy.deviceCredentialIsRevocableFromHost)
        XCTAssertEqual(AuthPolicy.requestedScopes, ["rappid.list", "rappid.asset", "rappid.autocomplete", "rappid.grow"])
        XCTAssertEqual(Set(AuthPolicy.requestedScopes), Set(GatewayMethod.allCases.map(\.rawValue)))
    }

    /// The one thing a pairing payload must never contain.
    func testPairingRequestCarriesNoCredentialAndNotTheCodeItself() throws {
        let request = PairingRequest(
            deviceName: "Field phone",
            deviceInstallID: "8E3F2C0A-INSTALL",
            nonce: "nonce-1",
            code: code
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let json = String(decoding: try encoder.encode(request), as: UTF8.self)
        let lowered = json.lowercased()

        for forbidden in ["token", "secret", "password", "bearer", "oauth", "gho_", "ghp_", "github", "copilot", "access_key", "apikey", "api_key"] {
            XCTAssertFalse(lowered.contains(forbidden), "pairing payload must not mention \(forbidden): \(json)")
        }
        XCTAssertFalse(json.contains(code.normalised), "the one-time code must not travel")
        XCTAssertFalse(json.contains(code.description), "the one-time code must not travel, formatted or not")

        XCTAssertEqual(request.schema, "rappid-field-pair/1")
        XCTAssertEqual(request.requestedScopes, AuthPolicy.requestedScopes)
        XCTAssertEqual(request.proof.count, 64, "what travels is a digest")
    }

    func testPairingProofIsDomainSeparatedAndBoundToTheDeviceAndNonce() {
        let base = PairingProof.compute(code: code, nonce: "n1", deviceInstallID: "device-a")
        XCTAssertNotEqual(base, PairingProof.compute(code: code, nonce: "n2", deviceInstallID: "device-a"))
        XCTAssertNotEqual(base, PairingProof.compute(code: code, nonce: "n1", deviceInstallID: "device-b"))
        XCTAssertNotEqual(base, PairingProof.compute(code: try! OneTimeCode("H7K2-9QMR-3TVY"), nonce: "n1", deviceInstallID: "device-a"))
        XCTAssertEqual(base, PairingProof.compute(code: code, nonce: "n1", deviceInstallID: "device-a"))
        XCTAssertNotEqual(base, Digest.sha256Hex("\(code.normalised)device-an1"), "the proof is domain separated, not a bare concatenation")
    }

    func testScannableOfferCarriesNoSecret() {
        let offer = PairingOffer(deviceName: "Field phone", deviceInstallID: "install-1", nonce: "nonce-1")
        let payload = offer.qrPayload.lowercased()
        for forbidden in ["token", "secret", "proof", "code=", "bearer", "password"] {
            XCTAssertFalse(payload.contains(forbidden), "the QR offer must not carry \(forbidden): \(offer.qrPayload)")
        }
        XCTAssertTrue(offer.qrPayload.hasPrefix("rappid-field://offer?"))
        XCTAssertTrue(offer.qrPayload.contains("scopes=rappid.list"))
    }

    func testDeviceCredentialRedactsItsTokenWhenPrinted() {
        let credential = DeviceCredential(
            credentialID: "cred-1",
            token: "super-secret-token-value",
            scopes: AuthPolicy.requestedScopes,
            hostURL: host,
            hostFingerprint: "ab12cd34",
            issuedAt: Date(timeIntervalSince1970: 0),
            expiresAt: Date(timeIntervalSince1970: 86_400)
        )
        XCTAssertFalse("\(credential)".contains("super-secret-token-value"))
        XCTAssertTrue("\(credential)".contains("<redacted>"))
        XCTAssertTrue(credential.isScopedToHabitatMethodsOnly)
        XCTAssertFalse(credential.isExpired(at: Date(timeIntervalSince1970: 100)))
        XCTAssertTrue(credential.isExpired(at: Date(timeIntervalSince1970: 200_000)))

        let wide = DeviceCredential(
            credentialID: "cred-2",
            token: "t",
            scopes: ["rappid.list", "repo", "admin:org"],
            hostURL: host,
            hostFingerprint: "ab12cd34",
            issuedAt: Date(),
            expiresAt: nil
        )
        XCTAssertFalse(wide.isScopedToHabitatMethodsOnly, "a wider grant than we asked for must be visible")
    }

    func testOneTimeCodeRejectsAmbiguousAndWrongLengthInput() throws {
        XCTAssertEqual(try OneTimeCode("h7k2 9qmr 3tvx").normalised, "H7K29QMR3TVX")
        XCTAssertEqual(try OneTimeCode("H7K29QMR3TVX").description, "H7K2-9QMR-3TVX")
        XCTAssertThrowsError(try OneTimeCode("H7K2-9QMR"))
        XCTAssertThrowsError(try OneTimeCode("O0I1-9QMR-3TVX"))
    }

    func testLinkRoundTripsAndRefusesInsecureRemoteHosts() throws {
        let link = try RappidLink(host: host, code: code, hostFingerprint: "ab12cd34")
        let parsed = try RappidLink(parsing: link.text)
        XCTAssertEqual(parsed, link)
        XCTAssertEqual(parsed.host, host)
        XCTAssertEqual(parsed.code.normalised, code.normalised)

        // Loopback over plain HTTP is fine; it never leaves the device.
        XCTAssertNoThrow(try RappidLink(host: URL(string: "http://localhost:8787")!, code: code, hostFingerprint: "aa"))
        XCTAssertNoThrow(try RappidLink(host: URL(string: "http://studio.local")!, code: code, hostFingerprint: "aa"))
        // Plain HTTP to somewhere else is not.
        XCTAssertThrowsError(try RappidLink(host: URL(string: "http://example.com")!, code: code, hostFingerprint: "aa"))
        XCTAssertThrowsError(try RappidLink(parsing: "https://example.com/pair"))
        XCTAssertThrowsError(try RappidLink(parsing: "rappid-link://pair?host=https://a.b"))
    }

    func testCredentialStoreRoundTrip() async throws {
        let store = InMemoryCredentialStore()
        let credential = DeviceCredential(
            credentialID: "cred-1",
            token: "t",
            scopes: AuthPolicy.requestedScopes,
            hostURL: host,
            hostFingerprint: "ab12cd34",
            issuedAt: Date(timeIntervalSince1970: 0),
            expiresAt: nil
        )
        var loaded = try await store.load()
        XCTAssertNil(loaded)
        try await store.save(credential)
        loaded = try await store.load()
        XCTAssertEqual(loaded, credential)
        try await store.clear()
        loaded = try await store.load()
        XCTAssertNil(loaded)
    }

    func testKeychainStoreRoundTripOnThisDevice() async throws {
        let store = KeychainCredentialStore(service: "com.openrappter.rappidfield.tests", account: "round-trip")
        let credential = DeviceCredential(
            credentialID: "cred-keychain",
            token: "t",
            scopes: AuthPolicy.requestedScopes,
            hostURL: host,
            hostFingerprint: "ab12cd34",
            issuedAt: Date(timeIntervalSince1970: 0),
            expiresAt: nil
        )
        do {
            try await store.clear()
            try await store.save(credential)
            let loaded = try await store.load()
            XCTAssertEqual(loaded?.credentialID, credential.credentialID)
            XCTAssertEqual(loaded?.token, credential.token)
            try await store.clear()
            let cleared = try await store.load()
            XCTAssertNil(cleared)
        } catch let error as CredentialStoreError where error.isMissingEntitlement {
            throw XCTSkip("This runner has no keychain entitlement; the store surfaced the refusal rather than hiding it.")
        }
    }
}
