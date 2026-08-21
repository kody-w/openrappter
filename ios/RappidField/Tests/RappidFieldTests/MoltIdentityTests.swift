import XCTest
@testable import RappidField

/// A molt is a change of projection. The organism underneath is the same one.
final class MoltIdentityTests: XCTestCase {
    func testMoltingNeverChangesTheRappid() {
        for path in StarterPath.allCases {
            let companion = SyntheticField.companion(for: path)
            let original = companion.identity

            for stage in MoltStage.allCases {
                let molted = companion.molted(to: stage)
                XCTAssertEqual(molted.identity, original, "\(path) molt to \(stage) must not re-mint")
                XCTAssertEqual(molted.identity.hex, original.hex)
                XCTAssertEqual(molted.identity.description, original.description)
                XCTAssertEqual(molted.id, companion.id)
                XCTAssertEqual(molted.birthTraitsMilli, companion.birthTraitsMilli)
                XCTAssertEqual(molted.assets, companion.assets)
            }
        }
    }

    func testMoltingNeverChangesTheSonicIdentity() {
        let companion = SyntheticField.companion(for: .forge)
        let seedling = SonicSignature(rappid: companion.molted(to: .first).identity, birthTraitsMilli: companion.birthTraitsMilli)
        let winged = SonicSignature(rappid: companion.molted(to: .third).identity, birthTraitsMilli: companion.birthTraitsMilli)
        XCTAssertEqual(seedling.midiSha256, winged.midiSha256, "the same organism keeps the same motif through every stage")
        XCTAssertEqual(seedling.prompt, winged.prompt)
    }

    func testOnlyTheNameAndTheDerivedStageMove() {
        let companion = SyntheticField.companion(for: .canopy)
        let first = companion.molted(to: .first)
        let third = companion.molted(to: .third)

        XCTAssertEqual(first.moltName, "Seedling")
        XCTAssertEqual(third.moltName, "Raptor")
        XCTAssertNotEqual(first.moltName, third.moltName)
        XCTAssertEqual(first.stats.frameHeight, third.stats.frameHeight, "molting is not growth")
        XCTAssertEqual(first.stats.totalWeightBytes, third.stats.totalWeightBytes, "molting adds no bytes")
    }

    func testStageIsDerivedFromAcceptedFrameDepthNotFromBytes() {
        XCTAssertEqual(MoltStage.derived(fromFrameHeight: 0), .first)
        XCTAssertEqual(MoltStage.derived(fromFrameHeight: 5), .first)
        XCTAssertEqual(MoltStage.derived(fromFrameHeight: 6), .second)
        XCTAssertEqual(MoltStage.derived(fromFrameHeight: 17), .second)
        XCTAssertEqual(MoltStage.derived(fromFrameHeight: 18), .third)
        XCTAssertEqual(MoltStage.derived(fromFrameHeight: 4_000), .third)

        // A heavy organism with a shallow body is still at its first stage.
        var heavy = SyntheticField.companion(for: .canopy)
        heavy.frameHeight = 1
        heavy.assets = heavy.assets + [
            CarriedAsset(
                dimension: "memory",
                path: "huge.bin",
                address: ContentAddress(space: "rapp/1:egg", hash: String(repeating: "a", count: 64)),
                bytes: 900_000_000,
                mediaType: "application/octet-stream",
                resident: true,
                verified: true
            ),
        ]
        XCTAssertEqual(heavy.derivedStage, .first)
    }

    func testCanonicalLifecycleVocabularyIsPreservedUnderneath() {
        XCTAssertEqual(MoltStage.first.canonicalLifecycle, "baby")
        XCTAssertEqual(MoltStage.second.canonicalLifecycle, "hatchling")
        XCTAssertEqual(MoltStage.third.canonicalLifecycle, "raptor")
    }

    func testIdentityParsingRoundTripsAndRejectsRubbish() throws {
        let text = SyntheticField.identity(for: .current).description
        let parsed = try RappidIdentity(text)
        XCTAssertEqual(parsed.description, text)
        XCTAssertEqual(parsed.owner, "field")
        XCTAssertEqual(parsed.name, "current-companion")
        XCTAssertEqual(parsed.hex.count, 64)

        XCTAssertThrowsError(try RappidIdentity("not-a-rappid"))
        XCTAssertThrowsError(try RappidIdentity("rappid:@field/name:short"))
        XCTAssertThrowsError(try RappidIdentity("rappid:@field/name:" + String(repeating: "A", count: 64)))
    }
}
