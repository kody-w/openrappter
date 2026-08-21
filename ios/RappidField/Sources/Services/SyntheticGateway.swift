import Foundation

/// The gateway used when no host is paired.
///
/// It answers the same four methods with deterministic fixtures so the whole
/// app is explorable offline. It refuses `rappid.grow` outright, because a
/// fixture has no append-only body to append to and pretending otherwise would
/// be the one lie this app cannot afford.
struct SyntheticGateway: RappidGateway {
    var latency: Duration = .milliseconds(220)

    func list() async throws -> [Companion] {
        try await Task.sleep(for: latency)
        return SyntheticField.roster
    }

    func asset(rappid: RappidIdentity, asset: String) async throws -> AssetPayload {
        try await Task.sleep(for: latency)
        guard let companion = SyntheticField.roster.first(where: { $0.identity == rappid }) else {
            throw GatewayError.rpc(code: 404, message: "no such fixture: \(rappid.description)")
        }
        let signature = SyntheticField.signature(for: companion.path)
        switch asset {
        case "assets/dna-prompt.mid":
            let data = SyntheticField.midiData(for: signature)
            return AssetPayload(path: asset, mediaType: "audio/midi", bytes: data.count, sha256: Digest.sha256Hex(data), data: data)
        case "assets/wake-call.pcm":
            let data = SyntheticField.wakeCallData(for: signature)
            return AssetPayload(path: asset, mediaType: "audio/x-pcm-f32le", bytes: data.count, sha256: Digest.sha256Hex(data), data: data)
        default:
            throw GatewayError.rpc(code: 404, message: "fixture carries no asset at \(asset)")
        }
    }

    func autocomplete(rappid: RappidIdentity, dimension: String) async throws -> GrowthProposal {
        try await Task.sleep(for: latency)
        guard let companion = SyntheticField.roster.first(where: { $0.identity == rappid }) else {
            throw GatewayError.rpc(code: 404, message: "no such fixture: \(rappid.description)")
        }
        return ProposalEngine.proposal(for: companion)
    }

    func grow(_ request: AppendRequest) async throws -> AppendReceipt {
        throw GatewayError.refusedForSyntheticFixture
    }
}
