import XCTest
@testable import RappidField

/// A proposal is a reading. Only an operator-approved, host-verified append
/// changes an organism, and every refusal on the way there is explicit.
final class GrowthAuthorityTests: XCTestCase {
    private func proposal(for path: StarterPath = .current, origin: DataOrigin? = nil) -> GrowthProposal {
        var companion = SyntheticField.companion(for: path)
        if let origin { companion.origin = origin }
        return ProposalEngine.proposal(for: companion)
    }

    func testProposalsAreNeverAuthoritative() {
        XCTAssertFalse(GrowthProposal.isAuthoritative)
        for path in StarterPath.allCases {
            let reading = proposal(for: path)
            XCTAssertFalse(reading.isAuthoritative, "\(path) proposal claimed authority")
            XCTAssertFalse(reading.provider.learnedTransformer)
            XCTAssertEqual(reading.provider.kind, "deterministic-rules-and-scoring")
            XCTAssertFalse(reading.evidence.isEmpty, "a reading must show its work")
        }
    }

    func testProposalDoesNotMutateTheCompanion() {
        let before = SyntheticField.companion(for: .forge)
        let reading = ProposalEngine.proposal(for: before)
        let after = SyntheticField.companion(for: .forge)

        XCTAssertEqual(before, after)
        XCTAssertEqual(after.frameHeight, before.frameHeight)
        XCTAssertGreaterThan(reading.predictedFrameHeight, after.frameHeight, "the prediction is ahead of the fact")
        XCTAssertEqual(after.stats.frameHeight, before.stats.frameHeight)
    }

    func testProposalIsDeterministicForTheSameState() {
        let companion = SyntheticField.companion(for: .canopy)
        let first = ProposalEngine.proposal(for: companion)
        let second = ProposalEngine.proposal(for: companion)
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.id, second.id)
    }

    func testObserveLeashGeneratesNothingToRead() {
        let companion = SyntheticField.companion(for: .canopy)
        XCTAssertNil(ProposalEngine.propose(for: companion, leash: .observe))
        XCTAssertNotNil(ProposalEngine.propose(for: companion, leash: .propose))
        XCTAssertNotNil(ProposalEngine.propose(for: companion, leash: .runApproved))
        XCTAssertFalse(GrowthLeashPolicy.mayPropose(leash: .observe))
    }

    func testThereIsNoHiddenAutonomousAppend() {
        XCTAssertFalse(GrowthLeashPolicy.autonomousAppendEverAllowed)
        XCTAssertFalse(SelfSteerLeash.observe.allowsAppendAfterApproval)
        XCTAssertFalse(SelfSteerLeash.propose.allowsAppendAfterApproval)
        XCTAssertTrue(SelfSteerLeash.runApproved.allowsAppendAfterApproval)
    }

    func testSyntheticFixturesCanNeverBeAppendedTo() {
        let reading = proposal(origin: .syntheticFixture)
        XCTAssertFalse(reading.isAppendable)
        let approval = GrowthApproval(proposal: reading, confirmationText: "confirmed")

        XCTAssertThrowsError(try GrowthLeashPolicy.authorise(
            proposal: reading,
            approval: approval,
            leash: .runApproved,
            paired: true
        )) { error in
            XCTAssertEqual(error as? AppendRefusal, .syntheticFixture)
        }
    }

    func testAppendRequiresPairingLeashAndAMatchingApproval() throws {
        let host = URL(string: "https://host.local")!
        let reading = proposal(origin: .pairedHost(host))
        XCTAssertTrue(reading.isAppendable)

        XCTAssertThrowsError(try GrowthLeashPolicy.authorise(proposal: reading, approval: nil, leash: .runApproved, paired: false)) {
            XCTAssertEqual($0 as? AppendRefusal, .notPaired)
        }
        XCTAssertThrowsError(try GrowthLeashPolicy.authorise(proposal: reading, approval: nil, leash: .propose, paired: true)) {
            XCTAssertEqual($0 as? AppendRefusal, .leashDoesNotAllowAppend(.propose))
        }
        XCTAssertThrowsError(try GrowthLeashPolicy.authorise(proposal: reading, approval: nil, leash: .runApproved, paired: true)) {
            XCTAssertEqual($0 as? AppendRefusal, .approvalMissing)
        }

        let other = proposal(for: .forge, origin: .pairedHost(host))
        let mismatched = GrowthApproval(proposal: other, confirmationText: "confirmed")
        XCTAssertThrowsError(try GrowthLeashPolicy.authorise(proposal: reading, approval: mismatched, leash: .runApproved, paired: true)) {
            XCTAssertEqual($0 as? AppendRefusal, .approvalDoesNotMatchProposal)
        }

        let approval = GrowthApproval(proposal: reading, confirmationText: "confirmed")
        let request = try GrowthLeashPolicy.authorise(proposal: reading, approval: approval, leash: .runApproved, paired: true)
        XCTAssertEqual(request.proposalID, reading.id)
        XCTAssertEqual(request.rappid, reading.rappid)
    }

    func testSyntheticGatewayRefusesToGrow() async {
        let gateway = SyntheticGateway(latency: .zero)
        let companion = SyntheticField.companion(for: .current)
        do {
            _ = try await gateway.grow(AppendRequest(rappid: companion.identity, proposalID: "anything"))
            XCTFail("a fixture must never report a successful append")
        } catch {
            XCTAssertEqual(error as? GatewayError, .refusedForSyntheticFixture)
        }
    }

    func testHostClaimingAuthorityOverAProposalIsRefused() {
        let identity = SyntheticField.identity(for: .current)
        let row: [String: Any] = [
            "id": "p-1",
            "dimension": "memory",
            "authoritative": true,
        ]
        XCTAssertThrowsError(try GatewayDecoding.proposal(from: row, rappid: identity, hostURL: URL(string: "https://host.local")!))
    }
}
