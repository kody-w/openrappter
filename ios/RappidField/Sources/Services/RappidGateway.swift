import Foundation

struct AssetPayload: Equatable {
    let path: String
    let mediaType: String
    let bytes: Int
    let sha256: String
    let data: Data

    /// The bytes are only trustworthy if they hash to what the manifest said.
    var verifies: Bool {
        data.count == bytes && Digest.sha256Hex(data) == sha256
    }
}

enum GatewayError: LocalizedError, Equatable {
    case notPaired
    case transport(String)
    case rpc(code: Int, message: String)
    case malformedResponse(String)
    case refusedForSyntheticFixture

    var errorDescription: String? {
        switch self {
        case .notPaired:
            return "No host is paired, so there is nothing to ask."
        case let .transport(detail):
            return "Could not reach the host: \(detail)"
        case let .rpc(code, message):
            return "Host refused (\(code)): \(message)"
        case let .malformedResponse(detail):
            return "The host replied with something this app cannot read: \(detail)"
        case .refusedForSyntheticFixture:
            return AppendRefusal.syntheticFixture.errorDescription
        }
    }
}

/// The scoped Habitat methods plus the host-side approval issuance seam.
protocol RappidGateway {
    func list() async throws -> [Companion]
    func asset(rappid: RappidIdentity, asset: String) async throws -> AssetPayload
    func autocomplete(rappid: RappidIdentity, dimension: String) async throws -> GrowthProposal
    func grow(_ request: AppendRequest) async throws -> AppendReceipt
}

enum GatewayMethod: String, CaseIterable {
    case list = "rappid.list"
    case asset = "rappid.asset"
    case autocomplete = "rappid.autocomplete"
    case approvalIssue = "rappid.approval.issue"
    case grow = "rappid.grow"
}

/// One JSON-RPC call, with string params only — which is all four habitat
/// methods take.
struct GatewayCall: Equatable {
    let id: String
    let method: GatewayMethod
    let params: [String: String]

    func encodedBody() throws -> Data {
        var object: [String: Any] = [
            "jsonrpc": "2.0",
            "id": id,
            "method": method.rawValue,
        ]
        if !params.isEmpty { object["params"] = params }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}

/// How a call reaches the host. Swappable so the same gateway code runs over
/// HTTPS/loopback HTTP or against a recording double in tests.
protocol HostTransport {
    func send(_ call: GatewayCall) async throws -> Data
}

/// Supplies the scoped device credential, or nothing when unpaired.
protocol CredentialProviding {
    func currentCredential() async -> DeviceCredential?
}

struct StoredCredentialProvider: CredentialProviding {
    let store: CredentialStoring

    func currentCredential() async -> DeviceCredential? {
        try? await store.load()
    }
}

/// JSON-RPC over HTTPS.
///
/// The scoped device credential is attached as a bearer header and never as a
/// query item or a body field, so it cannot end up in a host access log.
struct HTTPHostTransport: HostTransport {
    let hostURL: URL
    let credentials: CredentialProviding
    let session: URLSession

    init(hostURL: URL, credentials: CredentialProviding, session: URLSession = .shared) {
        self.hostURL = hostURL
        self.credentials = credentials
        self.session = session
    }

    func send(_ call: GatewayCall) async throws -> Data {
        guard let credential = await credentials.currentCredential() else { throw GatewayError.notPaired }
        var request = URLRequest(url: hostURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.httpBody = try call.encodedBody()

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayError.transport("no HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw GatewayError.rpc(code: http.statusCode, message: String(decoding: data, as: UTF8.self))
        }
        return data
    }
}

/// Decodes the four habitat methods into this app's models.
struct HostGateway: RappidGateway {
    let transport: HostTransport
    let hostURL: URL

    init(transport: HostTransport, hostURL: URL) {
        self.transport = transport
        self.hostURL = hostURL
    }

    private func result(_ method: GatewayMethod, _ params: [String: String]) async throws -> Any {
        let data = try await transport.send(GatewayCall(id: UUID().uuidString, method: method, params: params))
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GatewayError.malformedResponse("not a JSON-RPC object")
        }
        if let error = object["error"] as? [String: Any] {
            throw GatewayError.rpc(
                code: error["code"] as? Int ?? -1,
                message: error["message"] as? String ?? "unspecified"
            )
        }
        guard let payload = object["result"] else {
            throw GatewayError.malformedResponse("no result")
        }
        return payload
    }

    func list() async throws -> [Companion] {
        let payload = try await result(.list, [:])
        guard let rows = payload as? [[String: Any]] else {
            throw GatewayError.malformedResponse("rappid.list did not return a list")
        }
        return try rows.map { try GatewayDecoding.companion(from: $0, hostURL: hostURL) }
    }

    func asset(rappid: RappidIdentity, asset: String) async throws -> AssetPayload {
        let payload = try await result(.asset, ["rappid": rappid.description, "asset": asset])
        guard let row = payload as? [String: Any] else {
            throw GatewayError.malformedResponse("rappid.asset did not return an object")
        }
        return try GatewayDecoding.assetPayload(from: row)
    }

    func autocomplete(rappid: RappidIdentity, dimension: String) async throws -> GrowthProposal {
        let payload = try await result(.autocomplete, ["rappid": rappid.description, "dimension": dimension])
        guard let row = payload as? [String: Any] else {
            throw GatewayError.malformedResponse("rappid.autocomplete did not return an object")
        }
        return try GatewayDecoding.proposal(from: row, rappid: rappid, hostURL: hostURL)
    }

    func grow(_ request: AppendRequest) async throws -> AppendReceipt {
        let approvalPayload = try await result(.approvalIssue, [
            "operation": "grow",
            "rappid": request.rappid.description,
            "proposalId": request.proposalID,
        ])
        guard let approval = approvalPayload as? [String: Any],
              let approvalID = approval["approvalId"] as? String,
              !approvalID.isEmpty,
              approval["expiresAt"] as? String != nil else {
            throw GatewayError.malformedResponse(
                "rappid.approval.issue did not return approvalId/expiresAt"
            )
        }
        let payload = try await result(.grow, [
            "rappid": request.rappid.description,
            "proposalId": request.proposalID,
            "approvalId": approvalID,
        ])
        guard let row = payload as? [String: Any] else {
            throw GatewayError.malformedResponse("rappid.grow did not return an object")
        }
        guard let returnedRappid = row["rappid"] as? String,
              returnedRappid == request.rappid.description,
              let appended = row["appended"] as? [String: Any],
              let seq = appended["seq"] as? Int,
              seq >= 0,
              let frameHash = appended["frame_hash"] as? String,
              frameHash.range(
                of: #"^[0-9a-f]{64}$"#,
                options: .regularExpression
              ) != nil else {
            throw GatewayError.malformedResponse(
                "rappid.grow did not return exact rappid/appended.seq/frame_hash"
            )
        }
        return AppendReceipt(
            rappid: request.rappid,
            proposalID: request.proposalID,
            frameSeq: seq,
            frameHash: frameHash,
            acceptedAt: Date()
        )
    }
}
