import Foundation

/// Turns the host's habitat wire shape into this app's models.
///
/// The wire shape is the host's; the field vocabulary is this app's. Nothing
/// here renames anything on the way back out, and nothing invents a number the
/// host did not state — an absent size stays absent so weight stays honest.
enum GatewayDecoding {
    /// The host calls the organism a species; the field calls it a path.
    static func path(forSpecies species: String?) -> StarterPath? {
        guard let species = species?.lowercased() else { return nil }
        return StarterPath.allCases.first { species.contains($0.rawValue) }
    }

    static func companion(from row: [String: Any], hostURL: URL) throws -> Companion {
        guard let rappidText = row["rappid"] as? String else {
            throw GatewayError.malformedResponse("summary without a rappid")
        }
        let identity: RappidIdentity
        do {
            identity = try RappidIdentity(rappidText)
        } catch {
            throw GatewayError.malformedResponse("summary rappid is not a RAPPID: \(rappidText)")
        }

        let species = row["species"] as? String
        let resolved = path(forSpecies: species)
        let stats = row["stats"] as? [String: Any] ?? [:]
        let frameHeight = stats["frameHeight"] as? Int ?? 0

        let dimensions: [DimensionRecord] = (row["dimensions"] as? [[String: Any]] ?? []).map { entry in
            DimensionRecord(
                name: entry["name"] as? String ?? "unnamed",
                status: DimensionStatus(rawValue: entry["status"] as? String ?? "") ?? .missing,
                mediaTypes: entry["mediaTypes"] as? [String] ?? []
            )
        }

        // An unmeasured dimension arrives without a byte count, and is carried
        // as `nil` rather than zero: zero would silently complete the weight.
        let unmeasured = Set(row["unmeasuredDimensions"] as? [String] ?? [])
        let assets: [CarriedAsset] = (row["assets"] as? [[String: Any]] ?? []).map { entry in
            let dimension = entry["dimension"] as? String ?? "unknown"
            return CarriedAsset(
                dimension: dimension,
                path: entry["path"] as? String ?? "",
                address: ContentAddress(
                    space: entry["space"] as? String ?? "rapp/1:egg",
                    hash: entry["sha256"] as? String ?? ""
                ),
                bytes: unmeasured.contains(dimension) ? nil : entry["bytes"] as? Int,
                mediaType: entry["mediaType"] as? String ?? "application/octet-stream",
                resident: entry["resident"] as? Bool ?? true,
                verified: entry["verified"] as? Bool ?? false
            )
        }

        let traits = milliTraits(row["traitsMilli"] as? [String: Int], fallback: row["traits"] as? [String: Double])

        return Companion(
            identity: identity,
            path: resolved ?? .current,
            displayName: row["displayName"] as? String ?? identity.name,
            stage: MoltStage.derived(fromFrameHeight: frameHeight),
            traitsMilli: traits,
            birthTraitsMilli: row["birthTraitsMilli"] as? [String: Int] ?? traits,
            dimensions: dimensions,
            assets: assets,
            frameHeight: frameHeight,
            uniqueFrames: stats["uniqueFrames"] as? Int ?? frameHeight,
            origin: .pairedHost(hostURL),
            localOnly: row["localOnly"] as? Bool ?? true,
            verified: row["verified"] as? Bool ?? false,
            hostSpecies: species,
            pathInferred: resolved == nil
        )
    }

    private static func milliTraits(_ milli: [String: Int]?, fallback: [String: Double]?) -> [String: Int] {
        if let milli { return milli }
        guard let fallback else { return [:] }
        return fallback.mapValues { roundHalfUp($0 * 1000) }
    }

    static func assetPayload(from row: [String: Any]) throws -> AssetPayload {
        guard let base64 = row["base64"] as? String, let data = Data(base64Encoded: base64) else {
            throw GatewayError.malformedResponse("asset payload was not base64")
        }
        guard let sha256 = row["sha256"] as? String, let bytes = row["bytes"] as? Int else {
            throw GatewayError.malformedResponse("asset payload had no content address")
        }
        return AssetPayload(
            path: row["path"] as? String ?? "",
            mediaType: row["mediaType"] as? String ?? "application/octet-stream",
            bytes: bytes,
            sha256: sha256,
            data: data
        )
    }

    static func proposal(from row: [String: Any], rappid: RappidIdentity, hostURL: URL) throws -> GrowthProposal {
        guard let id = row["id"] as? String ?? row["proposalId"] as? String else {
            throw GatewayError.malformedResponse("proposal without an id")
        }
        // A host that claims authority over a proposal is refused: a proposal
        // is a reading in every runtime, and this client will not render one
        // as fact.
        if let authoritative = row["authoritative"] as? Bool, authoritative {
            throw GatewayError.malformedResponse("host marked a proposal authoritative")
        }
        let predictedFrameHeight = row["predictedFrameHeight"] as? Int ?? 0
        return GrowthProposal(
            id: id,
            rappid: rappid,
            dimension: row["dimension"] as? String ?? "unknown",
            title: row["title"] as? String ?? "Proposed append",
            summary: row["summary"] as? String ?? "",
            provider: ProviderClaim(
                name: (row["provider"] as? [String: Any])?["name"] as? String ?? "host",
                kind: (row["provider"] as? [String: Any])?["kind"] as? String ?? "unstated",
                learnedTransformer: (row["provider"] as? [String: Any])?["learnedTransformer"] as? Bool ?? false,
                claim: (row["provider"] as? [String: Any])?["claim"] as? String ?? "Stated by the host."
            ),
            predictedFrameHeight: predictedFrameHeight,
            predictedStatDelta: row["predictedStatDelta"] as? [String: Int] ?? [:],
            predictedStage: MoltStage.derived(fromFrameHeight: predictedFrameHeight),
            predictedDisplayHeightMillimetres: DisplayHeightCurve.v1_2.millimetres(frameHeight: predictedFrameHeight),
            evidence: row["evidence"] as? [String] ?? [],
            proposedAssets: [],
            origin: .pairedHost(hostURL)
        )
    }
}
