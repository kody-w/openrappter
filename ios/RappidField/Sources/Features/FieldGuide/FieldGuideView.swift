import SwiftUI

struct FieldGuideView: View {
    @Environment(AppModel.self) private var model
    @Environment(WakeCallPlayer.self) private var player
    @Environment(GameEngine.self) private var engine

    var body: some View {
        NavigationStack {
            ZStack {
                FieldBackground(path: model.selectedCompanion?.path ?? model.chosenPath)
                content
            }
            .navigationTitle("Field Guide")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.loadState {
        case .idle, .loading:
            ProgressView("Reading the field…")
                .tint(FieldTheme.mint)
                .foregroundStyle(FieldTheme.secondaryText)
        case let .failed(message):
            ContentUnavailableView {
                Label("The field did not answer", systemImage: "antenna.radiowaves.left.and.right.slash")
            } description: {
                Text(message)
            } actions: {
                Button("Try again") { Task { await model.refresh() } }
                    .buttonStyle(QuietButtonStyle())
                    .padding(.horizontal, 40)
            }
        case .loaded:
            guide
        }
    }

    private var guide: some View {
        ScrollView {
            VStack(spacing: 16) {
                roster
                if let companion = model.selectedCompanion {
                    EncounterCard(companion: companion)
                    TrainingCard(companion: companion)
                    CreatureCardView(companion: companion, isOwned: companion.path == model.chosenPath)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 24)
        }
        .refreshable { await model.refresh() }
    }

    private var roster: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(model.roster) { companion in
                    let selected = model.selectedCompanion?.id == companion.id
                    Button {
                        engine.dispatch(.selectCompanion(companion.path))
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(companion.displayName)
                                .font(.system(size: 14, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                            Text("\(companion.moltName) · \(companion.path.displayName)")
                                .font(.system(size: 11, design: .rounded))
                                .foregroundStyle(FieldTheme.secondaryText)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(FieldTheme.surface.opacity(selected ? 1 : 0.6))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(selected ? FieldTheme.accent(companion.path) : FieldTheme.hairline, lineWidth: selected ? 1.6 : 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(companion.displayName), \(companion.moltName) on the \(companion.path.displayName) path")
                    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

struct CreatureCardView: View {
    let companion: Companion
    var isOwned: Bool

    private var stats: CreatureStats { companion.stats }
    private var accent: Color { FieldTheme.accent(companion.path) }

    private var signature: SonicSignature {
        SonicSignature(rappid: companion.identity, birthTraitsMilli: companion.birthTraitsMilli)
    }

    var body: some View {
        VStack(spacing: 16) {
            header
            OriginBanner(origin: companion.origin)

            FieldCard(accent: accent) {
                VStack(alignment: .leading, spacing: 14) {
                    SectionHeader(title: "Sonic identity", subtitle: "Derived from this RAPPID and its birth traits. Same everywhere, offline.")
                    SonicIdentityView(signature: signature, path: companion.path, companionName: companion.displayName)
                }
            }

            weightCard
            heightCard
            dimensionsCard
            traitsCard
            identityCard
        }
    }

    private var header: some View {
        FieldCard(accent: accent) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(companion.displayName)
                            .font(.system(size: 28, weight: .heavy, design: .rounded))
                            .foregroundStyle(FieldTheme.gradient(companion.path))
                        Text("\(companion.moltName) · \(companion.path.displayName) path")
                            .font(.system(size: 13, weight: .medium, design: .rounded))
                            .foregroundStyle(FieldTheme.secondaryText)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 6) {
                        if isOwned { FieldTag(text: "Yours", color: accent, filled: true) }
                        FieldTag(text: companion.localOnly ? "Local only" : "Linked", color: companion.localOnly ? FieldTheme.violet : FieldTheme.mint)
                    }
                }
                Text(companion.moltSummary)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)

                if companion.pathInferred, let species = companion.hostSpecies {
                    Text("Your host reported the species \"\(species)\", which this build has no field rendering for. It is drawn on the Adaptive field so nothing is hidden from you.")
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(FieldTheme.ember)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 6) {
                    ForEach(Array(companion.path.moltLine.enumerated()), id: \.element.stage) { index, molt in
                        Text(molt.name)
                            .font(.system(size: 12, weight: molt.stage == companion.stage ? .heavy : .regular, design: .rounded))
                            .foregroundStyle(molt.stage == companion.stage ? accent : FieldTheme.tertiaryText)
                        if index < companion.path.moltLine.count - 1 {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(FieldTheme.tertiaryText)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Molt line. Current stage: \(companion.moltName).")
            }
        }
    }

    private var weightCard: some View {
        FieldCard(accent: stats.weightComplete ? FieldTheme.mint : FieldTheme.ember) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: "Weight",
                    subtitle: "Unique verified bytes. A duplicate address counts once, and an unknown size is never estimated."
                )
                if let total = stats.totalWeightBytes {
                    Text(Formatting.exactBytes(total))
                        .font(.system(size: 30, weight: .heavy, design: .monospaced))
                        .foregroundStyle(.white)
                        .accessibilityLabel("Exact weight: \(total) bytes")
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Incomplete")
                            .font(.system(size: 30, weight: .heavy, design: .rounded))
                            .foregroundStyle(FieldTheme.ember)
                        Text("At least \(Formatting.exactBytes(stats.residentWeightBytes + stats.linkedWeightBytes)) verified, plus \(stats.unmeasuredDimensions.joined(separator: ", ")) which this habitat has never measured.")
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(FieldTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Weight incomplete. At least \(stats.residentWeightBytes + stats.linkedWeightBytes) bytes verified. Unmeasured dimensions: \(stats.unmeasuredDimensions.joined(separator: ", ")).")
                }

                VStack(spacing: 8) {
                    StatLine(label: "Resident", value: Formatting.exactBytes(stats.residentWeightBytes), note: "Bytes physically here.")
                    StatLine(label: "Linked", value: Formatting.exactBytes(stats.linkedWeightBytes), note: "Known bytes referenced but not hydrated here.")
                    StatLine(label: "Unique addresses", value: "\(stats.weight.uniqueAddresses)", note: "Counted once each, across every dimension.")
                }

                DisclosureGroup {
                    VStack(spacing: 8) {
                        ForEach(companion.assets) { asset in
                            StatLine(
                                label: "\(asset.dimension)/\(asset.path)",
                                value: asset.bytes.map { "\($0) B" } ?? "unknown",
                                note: "\(asset.address.space) · \(String(asset.address.hash.prefix(12)))… · \(asset.resident ? "resident" : "linked")\(asset.verified ? " · verified" : " · unverified")",
                                valueColor: asset.bytes == nil ? FieldTheme.ember : .white
                            )
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    Text("Every address it carries")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(accent)
                }
                .tint(accent)
            }
        }
    }

    private var heightCard: some View {
        FieldCard(accent: FieldTheme.violet) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Height", subtitle: "Frame height is the fact. Display height is a versioned presentation curve over it.")
                StatLine(label: "Frame height", value: "\(stats.frameHeight)", note: "Contiguous accepted append-only body-frame depth.")
                StatLine(label: "Unique frames", value: "\(stats.uniqueFrames)")
                StatLine(
                    label: "Display height",
                    value: Formatting.millimetres(stats.displayHeightMillimetres),
                    note: "Curve \(stats.displayHeightVersion). Not identity, not a physical fact.",
                    valueColor: FieldTheme.violet
                )
                StatLine(label: "Stage", value: "\(companion.moltName) (\(companion.stage.canonicalLifecycle))", note: "Derived from frame height. Never from bytes.")
            }
        }
    }

    private var dimensionsCard: some View {
        FieldCard(accent: accent) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Dimensions", subtitle: "Distinct verified dimension families this organism carries.")
                ForEach(companion.dimensions) { dimension in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(dimension.name)
                                .font(.system(size: 14, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                            if !dimension.mediaTypes.isEmpty {
                                Text(dimension.mediaTypes.joined(separator: " · "))
                                    .font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(FieldTheme.tertiaryText)
                            }
                        }
                        Spacer()
                        FieldTag(
                            text: dimension.status.label,
                            color: dimension.status == .active ? FieldTheme.mint : (dimension.status == .linked ? FieldTheme.violet : FieldTheme.ember)
                        )
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private var traitsCard: some View {
        FieldCard(accent: accent) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Traits", subtitle: "Exact thousandths. The birth snapshot below is what the motif was conditioned on and never moves.")
                ForEach(companion.traitsSorted, id: \.key) { trait in
                    TraitBar(label: trait.key, milli: trait.milli, color: accent)
                }
                DisclosureGroup {
                    VStack(spacing: 8) {
                        ForEach(companion.birthTraitsMilli.keys.sorted(), id: \.self) { key in
                            StatLine(label: key.capitalized, value: "\(companion.birthTraitsMilli[key] ?? 0)/1000")
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    Text("Birth trait snapshot")
                        .font(.system(size: 13, weight: .semibold, design: .rounded))
                        .foregroundStyle(accent)
                }
                .tint(accent)
            }
        }
    }

    private var identityCard: some View {
        FieldCard(accent: FieldTheme.hairline) {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Identity", subtitle: "Minted once. Molting, weight, height and traits are all projections of this line.")
                Text(companion.identity.description)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                StatLine(label: "Verified", value: companion.verified ? "yes" : "no")
                StatLine(label: "Link status", value: companion.linkStatusLabel)
            }
        }
    }
}
