import XCTest
@testable import RappidField

final class StarterPathTests: XCTestCase {
    func testThreeOriginalStarterPathsWithDistinctChallengeTiers() {
        XCTAssertEqual(StarterPath.allCases.map(\.displayName), ["Canopy", "Current", "Forge"])
        XCTAssertEqual(StarterPath.canopy.challenge, .guided)
        XCTAssertEqual(StarterPath.current.challenge, .adaptive)
        XCTAssertEqual(StarterPath.forge.challenge, .frontier)
        XCTAssertEqual(StarterPath.canopy.challenge.effort, "Easy")
        XCTAssertEqual(StarterPath.current.challenge.effort, "Medium")
        XCTAssertEqual(StarterPath.forge.challenge.effort, "Hard")
        XCTAssertEqual(Set(StarterPath.allCases.map(\.challenge)).count, 3)
    }

    func testMoltLinesAreTheDocumentedOriginalNames() {
        XCTAssertEqual(StarterPath.canopy.moltLine.map(\.name), ["Seedling", "Strider", "Raptor"])
        XCTAssertEqual(StarterPath.current.moltLine.map(\.name), ["Ripple", "Voyager", "Resonant"])
        XCTAssertEqual(StarterPath.forge.moltLine.map(\.name), ["Spark", "Talon", "Aetherwing"])

        for path in StarterPath.allCases {
            XCTAssertEqual(path.moltLine.map(\.stage), MoltStage.allCases)
            XCTAssertEqual(path.moltName(for: .first), path.moltLine[0].name)
            XCTAssertEqual(path.moltName(for: .third), path.moltLine[2].name)
        }
    }

    func testTraitEmphasisMatchesTheAdvertisedPosture() {
        XCTAssertEqual(Set(StarterPath.canopy.traitEmphasis.map(\.key)), ["safety", "continuity"])
        XCTAssertEqual(Set(StarterPath.forge.traitEmphasis.map(\.key)), ["autonomy", "curiosity"])

        let canopy = StarterPath.canopy.birthTraitsMilli
        let current = StarterPath.current.birthTraitsMilli
        let forge = StarterPath.forge.birthTraitsMilli

        // Canopy leans safety and steady memory.
        XCTAssertGreaterThan(canopy["safety"]!, current["safety"]!)
        XCTAssertGreaterThan(canopy["continuity"]!, forge["continuity"]!)
        // Forge leans autonomy and reach.
        XCTAssertGreaterThan(forge["autonomy"]!, current["autonomy"]!)
        XCTAssertGreaterThan(forge["curiosity"]!, canopy["curiosity"]!)
        // Current sits between the two on every shared trait.
        for key in canopy.keys {
            let low = min(canopy[key]!, forge[key]!)
            let high = max(canopy[key]!, forge[key]!)
            XCTAssertTrue((low...high).contains(current[key]!), "current \(key) should be balanced")
        }

        for path in StarterPath.allCases {
            for (key, value) in path.birthTraitsMilli {
                XCTAssertTrue((0...1000).contains(value), "\(path) \(key) must be exact thousandths")
            }
        }
    }

    func testDefaultLeashNeverStartsAtRunApproved() {
        for path in StarterPath.allCases {
            XCTAssertNotEqual(path.defaultLeash, .runApproved, "\(path) must not start able to append")
        }
        XCTAssertEqual(StarterPath.canopy.defaultLeash, .observe)
    }

    func testNoAgeGateAndNoAgeCollection() {
        XCTAssertFalse(StarterPath.collectsOperatorAge)
        XCTAssertFalse(StarterPath.gatesPathsByAge)
        // Every path is reachable; nothing filters the list.
        XCTAssertEqual(StarterPath.allCases.count, 3)
        XCTAssertNotNil(StarterPath.canopy.recommendation, "the guided path may be recommended")
        XCTAssertNil(StarterPath.current.recommendation)
        XCTAssertNil(StarterPath.forge.recommendation)

        for field in PersistedState.allCases {
            XCTAssertFalse(field.rawValue.lowercased().contains("age"), "nothing about age is persisted")
        }
    }

    func testEveryPathExplainsChallengePrivacyAndPayoff() {
        for path in StarterPath.allCases {
            XCTAssertFalse(path.challengeSummary.isEmpty)
            XCTAssertFalse(path.privacySummary.isEmpty)
            XCTAssertFalse(path.payoffSummary.isEmpty)
            XCTAssertFalse(path.riskSummary.isEmpty)
            XCTAssertTrue(
                path.privacySummary.lowercased().contains("device"),
                "\(path) privacy copy should state what leaves the device"
            )
        }
        XCTAssertTrue(StarterPath.forge.riskSummary.lowercased().contains("high"))
    }

    /// The IP boundary, asserted rather than asserted-in-a-README.
    func testVocabularyStaysOriginal() {
        let banned = [
            "pokemon", "poke ball", "pokeball", "pokestop", "pok\u{00E9}",
            "pikachu", "charmander", "squirtle", "bulbasaur", "eevee",
            "gotta catch", "gym leader", "fire type", "water type", "grass type",
            "dragon", "evolution chain", "evolves into",
        ]

        var copy: [String] = []
        for path in StarterPath.allCases {
            copy.append(path.displayName)
            copy.append(path.tagline)
            copy.append(path.challengeSummary)
            copy.append(path.privacySummary)
            copy.append(path.payoffSummary)
            copy.append(path.riskSummary)
            copy.append(path.recommendation ?? "")
            copy.append(contentsOf: path.moltLine.map(\.name))
            copy.append(contentsOf: MoltStage.allCases.map { MoltDescription.summary(for: $0, path: path) })
            copy.append(contentsOf: path.traitEmphasis.flatMap { [$0.label, $0.note] })
            copy.append(SyntheticField.displayName(for: path))
        }
        copy.append(AuthPolicy.explanation)
        copy.append(LocationPolicy.plainStatement)
        copy.append(LocationPolicy.futureIntent)

        for line in copy {
            let lowered = line.lowercased()
            for term in banned {
                XCTAssertFalse(lowered.contains(term), "\"\(term)\" must not appear in field copy: \(line)")
            }
        }

        // Molting is a stage word here, never the franchise's growth verb.
        XCTAssertTrue(StarterPath.forge.moltLine.map(\.name).contains("Aetherwing"))
        XCTAssertFalse(
            MoltDescription.summary(for: .third, path: .forge).lowercased().contains("dragon"),
            "the winged stage is never described as a dragon"
        )
    }
}
