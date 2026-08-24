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

/// The four habitat methods this prototype speaks.
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
/// HTTPS, over a WebSocket, or against a recording double in tests.
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
        var request = URLRequest(url: hostURL.appendingPathComponent("rpc"))
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

/// JSON-RPC over a single WebSocket, which is what a local host actually
/// serves. One task per connection, responses matched by call id.
actor WebSocketHostTransport: HostTransport {
    private let hostURL: URL
    private let credentials: CredentialProviding
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    init(hostURL: URL, credentials: CredentialProviding, session: URLSession = .shared) {
        self.hostURL = hostURL
        self.credentials = credentials
        self.session = session
    }

    private func connected(with credential: DeviceCredential) throws -> URLSessionWebSocketTask {
        if let task, task.closeCode == .invalid { return task }
        var components = URLComponents(url: hostURL, resolvingAgainstBaseURL: false)
        components?.scheme = hostURL.scheme == "https" ? "wss" : "ws"
        components?.path = "/ws"
        guard let url = components?.url else { throw GatewayError.transport("bad host URL") }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        let created = session.webSocketTask(with: request)
        created.resume()
        task = created
        return created
    }

    func send(_ call: GatewayCall) async throws -> Data {
        guard let credential = await credentials.currentCredential() else { throw GatewayError.notPaired }
        let socket = try connected(with: credential)
        do {
            try await socket.send(.data(try call.encodedBody()))
            // The habitat methods are request/response; a local host answers
            // the call it was given before it moves on.
            switch try await socket.receive() {
            case let .data(data):
                return data
            case let .string(text):
                return Data(text.utf8)
            @unknown default:
                throw GatewayError.malformedResponse("unknown WebSocket frame")
            }
        } catch let error as GatewayError {
            throw error
        } catch {
            throw GatewayError.transport(error.localizedDescription)
        }
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
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
        let payload = try await result(.grow, [
            "rappid": request.rappid.description,
            "proposalId": request.proposalID,
        ])
        guard let row = payload as? [String: Any] else {
            throw GatewayError.malformedResponse("rappid.grow did not return an object")
        }
        return AppendReceipt(
            rappid: request.rappid,
            proposalID: request.proposalID,
            frameSeq: row["seq"] as? Int ?? 0,
            frameHash: row["frame_hash"] as? String ?? row["frameHash"] as? String ?? "",
            acceptedAt: Date()
        )
    }
}
