import SwiftUI

struct GrowthView: View {
    @Environment(AppModel.self) private var model
    @Environment(FieldNavigator.self) private var navigator
    @Environment(GameEngine.self) private var engine

    @State private var appending = false

    private var companion: Companion? { model.selectedCompanion }

    var body: some View {
        NavigationStack {
            ZStack {
                FieldBackground(path: companion?.path ?? model.chosenPath)
                if let companion {
                    content(companion: companion)
                } else {
                    ContentUnavailableView(
                        "No companion loaded",
                        systemImage: "circle.dashed",
                        description: Text("Open the Field Guide first, or pair a host.")
                    )
                }
            }
            .navigationTitle("Growth")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
        }
    }

    private func content(companion: Companion) -> some View {
        @Bindable var navigator = navigator
        let proposal = navigator.proposal
        return ScrollView {
            VStack(spacing: 16) {
                leashCard
                if let proposal {
                    proposalCard(proposal, companion: companion)
                    appendCard(proposal, companion: companion)
                } else {
                    observeCard(companion: companion)
                }
                if let receipt = navigator.appendReceipt {
                    receiptCard(receipt)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 24)
        }
        .onAppear { engine.syncProposal() }
        .onChange(of: model.leash) { _, _ in engine.syncProposal() }
        .onChange(of: model.selectedCompanionID) { _, _ in engine.syncProposal() }
        .onChange(of: model.roster.count) { _, _ in engine.syncProposal() }
        .onChange(of: engine.state.attunement) { _, _ in engine.syncProposal() }
        .sheet(isPresented: $navigator.confirmationVisible) {
            if let proposal {
                AppendConfirmationSheet(
                    proposal: proposal,
                    companion: companion,
                    acknowledged: navigator.confirmationAcknowledged,
                    appending: appending,
                    onAcknowledge: {
                        engine.dispatch(.acknowledgeConfirmation(proposal.id))
                    },
                    onRevoke: { engine.dispatch(.openConfirmation) },
                    onCancel: { engine.dispatch(.cancelAppend) },
                    onConfirm: { await confirmAppend() }
                )
                .presentationDetents([.large])
            }
        }
    }

    private var leashCard: some View {
        @Bindable var bindable = model
        return FieldCard(accent: FieldTheme.violet) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: "Self-steer leash",
                    subtitle: "There is no hidden full-autonomy mode. Nothing appends itself at any setting."
                )
                Picker("Leash", selection: Binding(
                    get: { model.leash },
                    set: { engine.dispatch(.setLeash($0)) }
                )) {
                    ForEach(SelfSteerLeash.allCases) { leash in
                        Text(leash.label).tag(leash)
                    }
                }
                .pickerStyle(.segmented)
                .accessibilityLabel("Self-steer leash")

                Text(model.leash.explanation)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func observeCard(companion: Companion) -> some View {
        FieldCard(accent: FieldTheme.mint) {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Observing only", subtitle: "The leash is set to Observe, so no proposal was generated.")
                StatLine(label: "Frame height", value: "\(companion.stats.frameHeight)")
                StatLine(label: "Dimensions carried", value: "\(companion.dimensions.count)")
                StatLine(
                    label: "Weight",
                    value: companion.stats.totalWeightBytes.map(Formatting.exactBytes) ?? "incomplete",
                    valueColor: companion.stats.weightComplete ? .white : FieldTheme.ember
                )
                Text("Move the leash to Propose if you want to read what this reading would suggest next.")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FieldTheme.tertiaryText)
            }
        }
    }

    private func proposalCard(_ proposal: GrowthProposal, companion: Companion) -> some View {
        FieldCard(accent: FieldTheme.ember) {
            VStack(alignment: .leading, spacing: 13) {
                HStack {
                    FieldTag(text: "Proposal · not authoritative", color: FieldTheme.ember, filled: true)
                    Spacer()
                }
                Text(proposal.title)
                    .font(.system(size: 20, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                Text(proposal.summary)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)

                Divider().overlay(FieldTheme.hairline)

                Text("What it predicts — none of this is true yet")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(FieldTheme.ember)
                StatLine(label: "Proposed dimension", value: proposal.dimension)
                StatLine(
                    label: "Frame height",
                    value: "\(companion.stats.frameHeight) → \(proposal.predictedFrameHeight)",
                    note: "Only a host append can move this."
                )
                StatLine(
                    label: "Display height",
                    value: "\(companion.stats.displayHeightMillimetres) → \(proposal.predictedDisplayHeightMillimetres) mm",
                    note: "Curve \(companion.curve.version)."
                )
                ForEach(proposal.predictedStatDelta.keys.sorted(), id: \.self) { key in
                    StatLine(label: "Δ \(key)", value: "+\(proposal.predictedStatDelta[key] ?? 0)")
                }
                StatLine(
                    label: "Stage if accepted",
                    value: companion.path.moltName(for: proposal.predictedStage),
                    note: "Stage is derived, and it would still be the same RAPPID."
                )

                Divider().overlay(FieldTheme.hairline)

                Text("Evidence read")
                    .font(.system(size: 12, weight: .bold, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                ForEach(proposal.evidence, id: \.self) { line in
                    HStack(alignment: .top, spacing: 7) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .bold))
                            .foregroundStyle(FieldTheme.tertiaryText)
                            .padding(.top, 4)
                        Text(line)
                            .font(.system(size: 12, design: .rounded))
                            .foregroundStyle(FieldTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Text("Provider: \(proposal.provider.name) · \(proposal.provider.kind) · learned transformer: \(proposal.provider.learnedTransformer ? "yes" : "no")")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(FieldTheme.tertiaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Growth proposal, not authoritative. \(proposal.title).")
    }

    private func appendCard(_ proposal: GrowthProposal, companion: Companion) -> some View {
        FieldCard(accent: proposal.isAppendable ? FieldTheme.mint : FieldTheme.hairline) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Append", subtitle: "Appending is the only thing that makes a proposal real, and it is always yours to do.")

                if !proposal.isAppendable {
                    disabledNotice(AppendRefusal.syntheticFixture.errorDescription ?? "")
                } else if !model.pairing.isPaired {
                    disabledNotice(AppendRefusal.notPaired.errorDescription ?? "")
                } else if !model.leash.allowsAppendAfterApproval {
                    disabledNotice(AppendRefusal.leashDoesNotAllowAppend(model.leash).errorDescription ?? "")
                }

                Button("Review and append…") {
                    engine.dispatch(.openConfirmation)
                }
                .buttonStyle(PrimaryButtonStyle(tint: FieldTheme.accent(companion.path)))
                .disabled(!canAttemptAppend(proposal))
                .opacity(canAttemptAppend(proposal) ? 1 : 0.45)
                .accessibilityHint(canAttemptAppend(proposal)
                    ? "Opens a confirmation sheet. Nothing is appended until you confirm there."
                    : "Disabled. Read the reason above.")

                if let refusal = navigator.appendRefusal {
                    Text(refusal)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(FieldTheme.ember)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func disabledNotice(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "hand.raised.slash")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(FieldTheme.ember)
            Text(text)
                .font(.system(size: 12, design: .rounded))
                .foregroundStyle(FieldTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(FieldTheme.ember.opacity(0.10)))
        .accessibilityElement(children: .combine)
    }

    private func receiptCard(_ receipt: AppendReceipt) -> some View {
        FieldCard(accent: FieldTheme.mint) {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Appended", subtitle: "The host accepted and verified a body frame.")
                StatLine(label: "Frame sequence", value: "\(receipt.frameSeq)")
                StatLine(label: "Frame hash", value: String(receipt.frameHash.prefix(20)) + "…")
                StatLine(label: "Proposal", value: receipt.proposalID)
            }
        }
    }

    private func canAttemptAppend(_ proposal: GrowthProposal) -> Bool {
        proposal.isAppendable && model.pairing.isPaired && model.leash.allowsAppendAfterApproval
    }

    private func confirmAppend() async {
        appending = true
        defer { appending = false }
        // The reducer owns the one append path; a refusal is surfaced in
        // `navigator.appendRefusal` and rendered on the card above.
        _ = try? await engine.apply(.approveAppend)
    }
}

/// The confirmation sheet. An append cannot happen without passing through it.
struct AppendConfirmationSheet: View {
    let proposal: GrowthProposal
    let companion: Companion
    let acknowledged: Bool
    var appending: Bool
    var onAcknowledge: () -> Void
    var onRevoke: () -> Void
    var onCancel: () -> Void
    var onConfirm: () async -> Void

    var body: some View {
        NavigationStack {
            ZStack {
                FieldBackground(path: companion.path)
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        FieldCard(accent: FieldTheme.ember) {
                            VStack(alignment: .leading, spacing: 10) {
                                Text("You are about to append a body frame")
                                    .font(.system(size: 19, weight: .heavy, design: .rounded))
                                    .foregroundStyle(.white)
                                Text("This is append-only. \(companion.displayName) will carry this frame permanently, and its RAPPID will not change.")
                                    .font(.system(size: 13, design: .rounded))
                                    .foregroundStyle(FieldTheme.secondaryText)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }

                        FieldCard(accent: FieldTheme.hairline) {
                            VStack(alignment: .leading, spacing: 9) {
                                StatLine(label: "Companion", value: companion.displayName)
                                StatLine(label: "RAPPID", value: companion.identity.shortHex + "…")
                                StatLine(label: "Dimension", value: proposal.dimension)
                                StatLine(label: "Proposal", value: proposal.id)
                                StatLine(label: "Frame height after", value: "\(proposal.predictedFrameHeight)")
                                StatLine(label: "Authoritative", value: proposal.isAuthoritative ? "yes" : "no", valueColor: FieldTheme.ember)
                            }
                        }

                        Toggle(isOn: Binding(
                            get: { acknowledged },
                            set: { newValue in
                                if newValue { onAcknowledge() } else { onRevoke() }
                            }
                        )) {
                            Text("I have read this proposal and I am approving this exact append.")
                                .font(.system(size: 13, design: .rounded))
                                .foregroundStyle(.white)
                        }
                        .tint(FieldTheme.accent(companion.path))

                        Button {
                            Task { await onConfirm() }
                        } label: {
                            if appending {
                                ProgressView().tint(FieldTheme.ink)
                            } else {
                                Text("Append this frame")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle(tint: FieldTheme.accent(companion.path)))
                        .disabled(!acknowledged || appending)
                        .opacity(acknowledged ? 1 : 0.45)

                        Button("Cancel", action: onCancel)
                            .buttonStyle(QuietButtonStyle(tint: FieldTheme.secondaryText))
                    }
                    .padding(20)
                }
            }
            .navigationTitle("Confirm append")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}
