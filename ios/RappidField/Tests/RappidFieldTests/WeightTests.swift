import XCTest
@testable import RappidField

/// Weight is an exact fact or an explicit refusal. It is never an estimate.
final class WeightTests: XCTestCase {
    private func asset(
        dimension: String,
        path: String,
        hash: String,
        bytes: Int?,
        resident: Bool = true
    ) -> CarriedAsset {
        CarriedAsset(
            dimension: dimension,
            path: path,
            address: ContentAddress(space: "rapp/1:egg", hash: hash),
            bytes: bytes,
            mediaType: "application/octet-stream",
            resident: resident,
            verified: true
        )
    }

    func testExactWeightIsTheSumOfUniqueVerifiedBytes() {
        let ledger = WeightLedger(assets: [
            asset(dimension: "sonic", path: "a", hash: "aa", bytes: 100),
            asset(dimension: "memory", path: "b", hash: "bb", bytes: 250),
            asset(dimension: "skill", path: "c", hash: "cc", bytes: 7, resident: false),
        ])
        XCTAssertTrue(ledger.isComplete)
        XCTAssertEqual(ledger.totalBytes, 357)
        XCTAssertEqual(ledger.residentBytes, 350)
        XCTAssertEqual(ledger.linkedBytes, 7)
        XCTAssertEqual(ledger.uniqueAddresses, 3)
    }

    func testDuplicateAddressCannotMakeAnOrganismHeavier() {
        let single = WeightLedger(assets: [asset(dimension: "sonic", path: "a", hash: "aa", bytes: 512)])
        let duplicated = WeightLedger(assets: [
            asset(dimension: "sonic", path: "a", hash: "aa", bytes: 512),
            asset(dimension: "visual", path: "mirror", hash: "aa", bytes: 512),
            asset(dimension: "memory", path: "again", hash: "aa", bytes: 512),
        ])
        XCTAssertEqual(single.totalBytes, 512)
        XCTAssertEqual(duplicated.totalBytes, 512)
        XCTAssertEqual(duplicated.uniqueAddresses, 1)
    }

    func testUnknownSizeMakesWeightIncompleteAndIsNeverEstimated() {
        let ledger = WeightLedger(assets: [
            asset(dimension: "sonic", path: "a", hash: "aa", bytes: 1_000),
            asset(dimension: "device", path: "manifest", hash: "dd", bytes: nil, resident: false),
        ])
        XCTAssertFalse(ledger.isComplete)
        XCTAssertNil(ledger.totalBytes, "an incomplete weight has no total, not a guessed one")
        XCTAssertEqual(ledger.unmeasured, ["device"])
        XCTAssertEqual(ledger.residentBytes, 1_000, "what is known stays stated")
        XCTAssertEqual(ledger.linkedBytes, 0, "an unknown size contributes nothing, not zero-as-a-value")
    }

    func testFixtureWeightsAreExactWhereMeasuredAndIncompleteWhereNot() {
        let canopy = SyntheticField.companion(for: .canopy).stats
        XCTAssertTrue(canopy.weightComplete)
        XCTAssertNotNil(canopy.totalWeightBytes)

        // The Canopy fixture carries the same MIDI address twice on purpose.
        XCTAssertEqual(SyntheticField.companion(for: .canopy).assets.count, 4)
        XCTAssertEqual(canopy.weight.uniqueAddresses, 3)

        let forge = SyntheticField.companion(for: .forge).stats
        XCTAssertFalse(forge.weightComplete)
        XCTAssertNil(forge.totalWeightBytes)
        XCTAssertEqual(forge.unmeasuredDimensions, ["device"])
    }

    func testFixtureSonicBytesAreTheBytesActuallyRendered() {
        for path in StarterPath.allCases {
            let signature = SyntheticField.signature(for: path)
            let midi = SyntheticField.midiData(for: signature)
            let carried = SyntheticField.assets(for: path).first { $0.path == "assets/dna-prompt.mid" }
            XCTAssertEqual(carried?.bytes, midi.count, "\(path) declared byte count must be the real one")
            XCTAssertEqual(carried?.address.hash, Digest.sha256Hex(midi))
            XCTAssertEqual(carried?.bytes, signature.midiBytes)
        }
    }

    func testDisplayHeightIsAVersionedCurveAndNotIdentity() {
        let curve = DisplayHeightCurve.v1_2
        XCTAssertEqual(curve.version, "display-height/1.2")
        XCTAssertEqual(curve.millimetres(frameHeight: 0), 120)
        XCTAssertEqual(curve.millimetres(frameHeight: 9), 342)
        XCTAssertTrue(curve.millimetres(frameHeight: 21) > curve.millimetres(frameHeight: 9))

        // Monotonic, and the same integer everywhere.
        var previous = -1
        for height in 0...200 {
            let value = curve.millimetres(frameHeight: height)
            XCTAssertGreaterThanOrEqual(value, previous)
            previous = value
        }

        let companion = SyntheticField.companion(for: .canopy)
        XCTAssertEqual(companion.stats.displayHeightVersion, "display-height/1.2")
        XCTAssertEqual(companion.stats.displayHeightMillimetres, curve.millimetres(frameHeight: companion.frameHeight))
        XCTAssertEqual(companion.identity, SyntheticField.identity(for: .canopy), "the curve says nothing about identity")
    }

    func testExactBytesAreNeverAbbreviated() {
        XCTAssertEqual(Formatting.exactBytes(1_048_576), "1,048,576 B")
        XCTAssertEqual(Formatting.exactBytes(7), "7 B")
    }
}
