import XCTest
@testable import RappidField

/// Captures whatever URLSession is asked to send, so the wire shape can be
/// asserted instead of assumed.
final class CapturingURLProtocol: URLProtocol {
    static var lastRequest: URLRequest?
    static var lastBody: Data?
    static var requests: [URLRequest] = []
    static var bodies: [Data] = []
    static var responseBody = Data()
    static var responseBodies: [Data] = []
    static var statusCode = 200

    static func reset() {
        lastRequest = nil
        lastBody = nil
        requests = []
        bodies = []
        responseBody = Data()
        responseBodies = []
        statusCode = 200
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        Self.requests.append(request)
        if let body = request.httpBody {
            Self.lastBody = body
            Self.bodies.append(body)
        } else if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4_096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(contentsOf: buffer[0..<read])
            }
            stream.close()
            Self.lastBody = data
            Self.bodies.append(data)
        }

        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        let responseData = Self.responseBodies.isEmpty
            ? Self.responseBody
            : Self.responseBodies.removeFirst()
        client?.urlProtocol(self, didLoad: responseData)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

struct StubCredentialProvider: CredentialProviding {
    var credential: DeviceCredential?
    func currentCredential() async -> DeviceCredential? { credential }
}

final class GatewayTests: XCTestCase {
    private let host = URL(string: "https://studio.local:8787")!

    private func credential(token: String = "scoped-device-token") -> DeviceCredential {
        DeviceCredential(
            credentialID: "cred-1",
            token: token,
            scopes: AuthPolicy.requestedScopes,
            hostURL: host,
            hostFingerprint: "ab12cd34",
            issuedAt: Date(timeIntervalSince1970: 0),
            expiresAt: nil
        )
    }

    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CapturingURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    func testTheHostMethodsIncludeApprovalWithoutRequestingItAsADeviceScope() {
        XCTAssertEqual(
            GatewayMethod.allCases.map(\.rawValue),
            [
                "rappid.list",
                "rappid.asset",
                "rappid.autocomplete",
                "rappid.approval.issue",
                "rappid.grow",
            ]
        )
        XCTAssertEqual(
            AuthPolicy.requestedScopes,
            ["rappid.list", "rappid.asset", "rappid.autocomplete", "rappid.grow"]
        )
    }

    func testCallBodyIsJSONRPCAndCarriesNoCredential() throws {
        let call = GatewayCall(id: "call-1", method: .autocomplete, params: ["rappid": "rappid:@a/b:\(String(repeating: "0", count: 64))", "dimension": "sonic"])
        let json = String(decoding: try call.encodedBody(), as: UTF8.self)
        XCTAssertTrue(json.contains("\"jsonrpc\":\"2.0\""))
        XCTAssertTrue(json.contains("\"method\":\"rappid.autocomplete\""))
        XCTAssertTrue(json.contains("\"dimension\":\"sonic\""))
        XCTAssertFalse(json.lowercased().contains("token"))
        XCTAssertFalse(json.lowercased().contains("bearer"))
    }

    func testCredentialTravelsOnlyInTheAuthorizationHeader() async throws {
        CapturingURLProtocol.reset()
        CapturingURLProtocol.responseBody = Data(#"{"jsonrpc":"2.0","id":"1","result":[]}"#.utf8)

        let transport = HTTPHostTransport(
            hostURL: host,
            credentials: StubCredentialProvider(credential: credential()),
            session: session()
        )
        let gateway = HostGateway(transport: transport, hostURL: host)
        let companions = try await gateway.list()
        XCTAssertTrue(companions.isEmpty)

        let request = try XCTUnwrap(CapturingURLProtocol.lastRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer scoped-device-token"
        )
        XCTAssertEqual(request.url, host)
        XCTAssertFalse(try XCTUnwrap(request.url).absoluteString.contains("scoped-device-token"), "no credential in the URL")

        let body = String(decoding: try XCTUnwrap(CapturingURLProtocol.lastBody), as: UTF8.self)
        XCTAssertTrue(body.contains("rappid.list"))
        XCTAssertFalse(body.contains("scoped-device-token"), "no credential in the body")
    }

    func testUnpairedTransportRefusesBeforeItReachesTheNetwork() async {
        CapturingURLProtocol.reset()
        let transport = HTTPHostTransport(
            hostURL: host,
            credentials: StubCredentialProvider(credential: nil),
            session: session()
        )
        do {
            _ = try await transport.send(GatewayCall(id: "1", method: .list, params: [:]))
            XCTFail("an unpaired device must not call out")
        } catch {
            XCTAssertEqual(error as? GatewayError, .notPaired)
        }
        XCTAssertNil(CapturingURLProtocol.lastRequest)
    }

    func testRPCErrorsAreSurfacedNotSwallowed() async {
        CapturingURLProtocol.reset()
        CapturingURLProtocol.responseBody = Data(#"{"jsonrpc":"2.0","id":"1","error":{"code":403,"message":"scope refused"}}"#.utf8)
        let gateway = HostGateway(
            transport: HTTPHostTransport(hostURL: host, credentials: StubCredentialProvider(credential: credential()), session: session()),
            hostURL: host
        )
        do {
            _ = try await gateway.list()
            XCTFail("an error result must throw")
        } catch {
            XCTAssertEqual(error as? GatewayError, .rpc(code: 403, message: "scope refused"))
        }
    }

    func testHostSummaryDecodingKeepsUnknownSizesUnknown() throws {
        let identity = SyntheticField.identity(for: .forge)
        let row: [String: Any] = [
            "rappid": identity.description,
            "displayName": "Emberline",
            "species": "forge",
            "localOnly": false,
            "verified": true,
            "stats": ["frameHeight": 21, "uniqueFrames": 21],
            "traitsMilli": ["autonomy": 900],
            "dimensions": [["name": "sonic", "status": "active", "mediaTypes": ["audio/midi"]]],
            "unmeasuredDimensions": ["device"],
            "assets": [
                ["dimension": "sonic", "path": "assets/dna-prompt.mid", "sha256": "aa", "bytes": 212, "resident": true, "verified": true],
                ["dimension": "device", "path": "habitat/link.json", "sha256": "bb", "bytes": 99, "resident": false, "verified": false],
            ],
        ]
        let companion = try GatewayDecoding.companion(from: row, hostURL: host)
        XCTAssertEqual(companion.identity, identity)
        XCTAssertEqual(companion.path, .forge)
        XCTAssertFalse(companion.pathInferred)
        XCTAssertEqual(companion.stage, .third)
        XCTAssertEqual(companion.origin, .pairedHost(host))
        XCTAssertFalse(companion.stats.weightComplete, "a dimension the host called unmeasured stays unmeasured")
        XCTAssertNil(companion.stats.totalWeightBytes)
        XCTAssertEqual(companion.stats.residentWeightBytes, 212)
    }

    func testProposalDecodesExactNestedPredictedStatsAndRefusesMissingShape() throws {
        let identity = SyntheticField.identity(for: .current)
        let row: [String: Any] = [
            "id": "proposal-1",
            "rappid": identity.description,
            "dimension": "sonic",
            "title": "Grow sound",
            "summary": "Append a sonic dimension.",
            "predictedStats": ["frameHeight": 7],
            "predictedStage": "hatchling",
            "evidence": ["verified"],
            "assets": [],
            "authoritative": false,
        ]
        let proposal = try GatewayDecoding.proposal(
            from: row,
            rappid: identity,
            hostURL: host
        )
        XCTAssertEqual(proposal.predictedFrameHeight, 7)

        var flat = row
        flat.removeValue(forKey: "predictedStats")
        flat["predictedFrameHeight"] = 7
        XCTAssertThrowsError(try GatewayDecoding.proposal(
            from: flat,
            rappid: identity,
            hostURL: host
        ))
    }

    func testGrowIssuesHostApprovalAndRequiresExactNestedAppendReceipt() async throws {
        CapturingURLProtocol.reset()
        let identity = SyntheticField.identity(for: .current)
        let frameHash = String(repeating: "a", count: 64)
        CapturingURLProtocol.responseBodies = [
            Data(#"{"jsonrpc":"2.0","id":"1","result":{"approvalId":"approval-1","expiresAt":"2026-08-23T21:00:00.000Z"}}"#.utf8),
            Data("""
            {"jsonrpc":"2.0","id":"2","result":{"rappid":"\(identity.description)","appended":{"seq":4,"frame_hash":"\(frameHash)"}}}
            """.utf8),
        ]
        let gateway = HostGateway(
            transport: HTTPHostTransport(
                hostURL: host,
                credentials: StubCredentialProvider(credential: credential()),
                session: session()
            ),
            hostURL: host
        )
        let receipt = try await gateway.grow(
            AppendRequest(rappid: identity, proposalID: "proposal-1")
        )
        XCTAssertEqual(receipt.frameSeq, 4)
        XCTAssertEqual(receipt.frameHash, frameHash)
        XCTAssertEqual(CapturingURLProtocol.bodies.count, 2)
        let approvalBody = String(
            decoding: CapturingURLProtocol.bodies[0],
            as: UTF8.self
        )
        let growBody = String(
            decoding: CapturingURLProtocol.bodies[1],
            as: UTF8.self
        )
        XCTAssertTrue(approvalBody.contains("rappid.approval.issue"))
        XCTAssertTrue(growBody.contains(#""approvalId":"approval-1""#))
    }

    func testGrowFailsClosedOnLegacyFlatReceipt() async {
        CapturingURLProtocol.reset()
        let identity = SyntheticField.identity(for: .current)
        CapturingURLProtocol.responseBodies = [
            Data(#"{"jsonrpc":"2.0","id":"1","result":{"approvalId":"approval-1","expiresAt":"2026-08-23T21:00:00.000Z"}}"#.utf8),
            Data(#"{"jsonrpc":"2.0","id":"2","result":{"seq":0,"frame_hash":"bad"}}"#.utf8),
        ]
        let gateway = HostGateway(
            transport: HTTPHostTransport(
                hostURL: host,
                credentials: StubCredentialProvider(credential: credential()),
                session: session()
            ),
            hostURL: host
        )
        do {
            _ = try await gateway.grow(
                AppendRequest(rappid: identity, proposalID: "proposal-1")
            )
            XCTFail("legacy flat grow receipt must be refused")
        } catch {
            guard case let GatewayError.malformedResponse(detail) = error else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertTrue(detail.contains("appended.seq/frame_hash"))
        }
    }

    func testUnknownSpeciesIsRenderedButFlagged() throws {
        let identity = SyntheticField.identity(for: .current)
        let companion = try GatewayDecoding.companion(
            from: ["rappid": identity.description, "species": "cinder-lattice", "stats": ["frameHeight": 3]],
            hostURL: host
        )
        XCTAssertTrue(companion.pathInferred, "an unrecognised species must be visible, not silently relabelled")
        XCTAssertEqual(companion.hostSpecies, "cinder-lattice")
    }

    func testSyntheticGatewayServesVerifiableAssets() async throws {
        let gateway = SyntheticGateway(latency: .zero)
        let roster = try await gateway.list()
        XCTAssertEqual(roster.count, 3)
        XCTAssertTrue(roster.allSatisfy { $0.origin == .syntheticFixture })

        let companion = try XCTUnwrap(roster.first { $0.path == .canopy })
        let payload = try await gateway.asset(rappid: companion.identity, asset: "assets/dna-prompt.mid")
        XCTAssertTrue(payload.verifies, "a served asset must hash to what it claims")
        XCTAssertEqual(payload.mediaType, "audio/midi")
        XCTAssertEqual(payload.bytes, SyntheticField.signature(for: .canopy).midiBytes)

        let proposal = try await gateway.autocomplete(rappid: companion.identity, dimension: "sonic")
        XCTAssertFalse(proposal.isAuthoritative)
        XCTAssertFalse(proposal.isAppendable)
    }
}
