import Foundation

/// What produced a proposal, stated in the proposal itself.
struct ProviderClaim: Equatable, Codable {
    let name: String
    let kind: String
    let learnedTransformer: Bool
    let claim: String

    static let localDeterministic = ProviderClaim(
        name: "rappid-field/local-candidates",
        kind: "deterministic-rules-and-scoring",
        learnedTransformer: false,
        claim: "Deterministic candidate generation and scoring on device. Not a trained model, and not an authority."
    )
}

/// A reading of what could come next. Never organism state.
///
/// `isAuthoritative` is a constant on the type rather than a field a producer
/// could set, because there is no code path in this app that is allowed to
/// hand back an authoritative prediction.
struct GrowthProposal: Identifiable, Equatable {
    let id: String
    let rappid: RappidIdentity
    let dimension: String
    let title: String
    let summary: String
    let provider: ProviderClaim
    let predictedFrameHeight: Int
    let predictedStatDelta: [String: Int]
    let predictedStage: MoltStage
    let predictedDisplayHeightMillimetres: Int
    let evidence: [String]
    let proposedAssets: [CarriedAsset]
    let origin: DataOrigin

    /// Prediction never mutates canonical state.
    static let isAuthoritative = false
    var isAuthoritative: Bool { Self.isAuthoritative }

    /// Whether an append could even be attempted. Synthetic fixtures never can.
    var isAppendable: Bool { origin.allowsAppend }
}

/// An explicit, operator-made approval of one exact proposal.
///
/// It is minted only by the confirmation sheet. Nothing generates one for you.
struct GrowthApproval: Equatable {
    let proposalID: String
    let rappid: RappidIdentity
    let approvedAt: Date
    let confirmationText: String

    init(proposal: GrowthProposal, approvedAt: Date = Date(), confirmationText: String) {
        self.proposalID = proposal.id
        self.rappid = proposal.rappid
        self.approvedAt = approvedAt
        self.confirmationText = confirmationText
    }
}

enum AppendRefusal: LocalizedError, Equatable {
    case syntheticFixture
    case notPaired
    case leashDoesNotAllowAppend(SelfSteerLeash)
    case approvalMissing
    case approvalDoesNotMatchProposal

    var errorDescription: String? {
        switch self {
        case .syntheticFixture:
            return "This companion is a deterministic local sample. Appending a body frame to a fixture would be theatre, so it is refused."
        case .notPaired:
            return "No host is paired. A body frame can only be appended by the host that verifies it."
        case let .leashDoesNotAllowAppend(leash):
            return "The leash is set to \(leash.label). Move it to Run Approved before appending."
        case .approvalMissing:
            return "Nothing was approved. Read the proposal and confirm it first."
        case .approvalDoesNotMatchProposal:
            return "The approval does not match this proposal. Approvals are for one exact proposal."
        }
    }
}

struct AppendRequest: Equatable {
    let rappid: RappidIdentity
    let proposalID: String
}

/// The append-only growth boundary, kept as a pure function so the rule can be
/// tested without a view, a host, or a network.
enum GrowthLeashPolicy {
    /// There is no hidden autonomous mutation: this is a constant, not a flag.
    static let autonomousAppendEverAllowed = false

    static func authorise(
        proposal: GrowthProposal,
        approval: GrowthApproval?,
        leash: SelfSteerLeash,
        paired: Bool
    ) throws -> AppendRequest {
        guard proposal.origin.allowsAppend else { throw AppendRefusal.syntheticFixture }
        guard paired else { throw AppendRefusal.notPaired }
        guard leash.allowsAppendAfterApproval else { throw AppendRefusal.leashDoesNotAllowAppend(leash) }
        guard let approval else { throw AppendRefusal.approvalMissing }
        guard approval.proposalID == proposal.id, approval.rappid == proposal.rappid else {
            throw AppendRefusal.approvalDoesNotMatchProposal
        }
        return AppendRequest(rappid: proposal.rappid, proposalID: proposal.id)
    }

    /// Whether the leash is even allowed to produce a proposal to read.
    static func mayPropose(leash: SelfSteerLeash) -> Bool {
        leash != .observe
    }
}

struct AppendReceipt: Equatable {
    let rappid: RappidIdentity
    let proposalID: String
    let frameSeq: Int
    let frameHash: String
    let acceptedAt: Date
}
