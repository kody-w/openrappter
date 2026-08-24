import SwiftUI

struct OnboardingView: View {
    @Environment(AppModel.self) private var model
    @Environment(WakeCallPlayer.self) private var player
    @Environment(FieldNavigator.self) private var navigator
    @Environment(GameEngine.self) private var engine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Onboarding position lives in the navigator so a finger and the debug
    /// autopilot move through exactly the same state.
    private var step: OnboardingStage { navigator.onboardingStage }
    private var selection: StarterPath? { navigator.onboardingSelection }

    var body: some View {
        ZStack {
            FieldBackground(path: selection)
            content
        }
    }

    @ViewBuilder
    private var content: some View {
        switch step {
        case .welcome:
            welcome
        case .paths:
            paths
        case .confirm:
            if let selection {
                confirm(path: selection)
            } else {
                paths
            }
        case .complete:
            welcome
        }
    }

    private func advance(to next: OnboardingStage) {
        if reduceMotion {
            navigator.onboardingStage = next
        } else {
            withAnimation(.easeInOut(duration: 0.28)) { navigator.onboardingStage = next }
        }
    }

    // MARK: Welcome

    private var welcome: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 10) {
                    FieldTag(text: "Prototype", color: FieldTheme.violet)
                    Text("RAPPID Field")
                        .font(.system(size: 42, weight: .heavy, design: .rounded))
                        .foregroundStyle(
                            LinearGradient(colors: [.white, FieldTheme.mint], startPoint: .topLeading, endPoint: .bottomTrailing)
                        )
                    Text("A sound-first companion field for Quantum RAPPIDs.")
                        .font(.system(size: 17, weight: .medium, design: .rounded))
                        .foregroundStyle(FieldTheme.secondaryText)
                }
                .padding(.top, 40)

                VStack(spacing: 12) {
                    welcomePoint(
                        icon: "waveform",
                        title: "Sound before pictures",
                        body: "Every companion is a sixteen-note motif derived from its own identity. What you see on screen is that motif drawn. There are no character models here."
                    )
                    welcomePoint(
                        icon: "location.slash",
                        title: "No map, no location",
                        body: "This app has no location code and no location permission. Nothing about where you are is collected, requested, or inferred."
                    )
                    welcomePoint(
                        icon: "key.horizontal",
                        title: "Your host keeps the keys",
                        body: "Copilot and GitHub stay signed in on your own machine. If you pair, this phone receives one narrow credential that your host can revoke."
                    )
                    welcomePoint(
                        icon: "checkmark.seal",
                        title: "Nothing grows behind your back",
                        body: "Your companion can read what might come next. It never appends anything to itself without you reading the proposal and confirming it."
                    )
                }

                Button("Choose a path") { advance(to: .paths) }
                    .buttonStyle(PrimaryButtonStyle())
                    .accessibilityHint("Opens the three starter paths.")

                Text("No account, no age, no email. Nothing is collected to get started.")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FieldTheme.tertiaryText)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(22)
        }
    }

    private func welcomePoint(icon: String, title: String, body text: String) -> some View {
        FieldCard(accent: FieldTheme.violet) {
            HStack(alignment: .top, spacing: 13) {
                Image(systemName: icon)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(FieldTheme.mint)
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                    Text(text)
                        .font(.system(size: 13, design: .rounded))
                        .foregroundStyle(FieldTheme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Paths

    private var paths: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Three starter paths")
                            .font(.system(size: 30, weight: .heavy, design: .rounded))
                            .foregroundStyle(.white)
                        Text("A path sets how hard the field pushes back and what your companion leans toward. It is not an element and it does not beat another path. Nothing is locked, and you are never asked your age.")
                            .font(.system(size: 14, design: .rounded))
                            .foregroundStyle(FieldTheme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.top, 34)

                    ForEach(StarterPath.allCases) { path in
                        PathCard(path: path, selected: selection == path) {
                            // The same command an agent sends; the reducer
                            // records the selection and opens the detail.
                            engine.dispatch(.selectStarter(path))
                        }
                    }
                }
                .padding(22)
            }

            VStack(spacing: 10) {
                Button("Back") { advance(to: .welcome) }
                    .buttonStyle(QuietButtonStyle(tint: FieldTheme.secondaryText))
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 18)
        }
    }

    // MARK: Confirm

    private func confirm(path: StarterPath) -> some View {
        let signature = SyntheticField.signature(for: path)
        return VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            FieldTag(text: path.challenge.label, color: FieldTheme.accent(path), filled: true)
                            FieldTag(text: path.challenge.effort, color: FieldTheme.accent(path))
                        }
                        Text(path.displayName)
                            .font(.system(size: 38, weight: .heavy, design: .rounded))
                            .foregroundStyle(FieldTheme.gradient(path))
                        Text(path.tagline)
                            .font(.system(size: 16, weight: .medium, design: .rounded))
                            .foregroundStyle(FieldTheme.secondaryText)
                    }
                    .padding(.top, 32)

                    FieldCard(accent: FieldTheme.accent(path)) {
                        VStack(alignment: .leading, spacing: 14) {
                            SectionHeader(title: "Listen first", subtitle: "This is the companion's identity motif, drawn and playable. It never plays on its own.")
                            SonicIdentityView(
                                signature: signature,
                                path: path,
                                companionName: SyntheticField.displayName(for: path)
                            )
                        }
                    }

                    explanation(path: path)
                    moltLine(path: path)

                    FieldCard(accent: FieldTheme.violet) {
                        VStack(alignment: .leading, spacing: 8) {
                            SectionHeader(title: "The same, on every path")
                            bullet("No location, no map, no account, no age, no analytics.")
                            bullet("Your companion's identity is minted once. Molting renames the projection, never the organism.")
                            bullet("Growth is a proposal until you approve it. There is no hidden autonomous mode.")
                            bullet("Without a paired host, everything you see is a deterministic local sample, labelled as one.")
                        }
                    }
                }
                .padding(22)
            }

            VStack(spacing: 10) {
                Button("Begin with \(path.displayName)") {
                    engine.dispatch(.confirmStarter)
                }
                .buttonStyle(PrimaryButtonStyle(tint: FieldTheme.accent(path)))
                .accessibilityHint("Sets \(path.displayName) as your starter path and opens the field guide.")

                Button("Look at the other paths") {
                    player.stop()
                    advance(to: .paths)
                }
                .buttonStyle(QuietButtonStyle(tint: FieldTheme.secondaryText))
            }
            .padding(.horizontal, 22)
            .padding(.bottom, 18)
        }
    }

    private func explanation(path: StarterPath) -> some View {
        VStack(spacing: 14) {
            detailCard(
                icon: "figure.walk.motion",
                title: "What it asks of you",
                body: path.challengeSummary,
                accent: FieldTheme.accent(path)
            )
            detailCard(
                icon: "hand.raised",
                title: "What it does with your data",
                body: path.privacySummary,
                accent: FieldTheme.mint
            )
            detailCard(
                icon: "sparkles",
                title: "What you get for it",
                body: path.payoffSummary,
                accent: FieldTheme.violet
            )
            detailCard(
                icon: "exclamationmark.triangle",
                title: "The trade",
                body: path.riskSummary,
                accent: FieldTheme.ember
            )
            if let recommendation = path.recommendation {
                detailCard(
                    icon: "leaf",
                    title: "Recommendation",
                    body: recommendation,
                    accent: FieldTheme.accent(path)
                )
            }
        }
    }

    private func detailCard(icon: String, title: String, body text: String, accent: Color) -> some View {
        FieldCard(accent: accent) {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(accent)
                    Text(title)
                        .font(.system(size: 15, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                }
                Text(text)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func moltLine(path: StarterPath) -> some View {
        FieldCard(accent: FieldTheme.accent(path)) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: "Molt line",
                    subtitle: "Three presentations of one organism. The RAPPID never changes."
                )
                ForEach(path.moltLine, id: \.stage) { molt in
                    HStack(alignment: .top, spacing: 12) {
                        Text("\(molt.stage.rawValue + 1)")
                            .font(.system(size: 12, weight: .heavy, design: .monospaced))
                            .foregroundStyle(FieldTheme.ink)
                            .frame(width: 22, height: 22)
                            .background(Circle().fill(FieldTheme.accent(path)))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(molt.name)
                                .font(.system(size: 15, weight: .bold, design: .rounded))
                                .foregroundStyle(.white)
                            Text(MoltDescription.summary(for: molt.stage, path: path))
                                .font(.system(size: 12, design: .rounded))
                                .foregroundStyle(FieldTheme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(FieldTheme.mint)
                .frame(width: 5, height: 5)
                .padding(.top, 6)
            Text(text)
                .font(.system(size: 13, design: .rounded))
                .foregroundStyle(FieldTheme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct PathCard: View {
    let path: StarterPath
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .center) {
                    Text(path.displayName)
                        .font(.system(size: 24, weight: .heavy, design: .rounded))
                        .foregroundStyle(FieldTheme.gradient(path))
                    Spacer()
                    FieldTag(text: "\(path.challenge.label) · \(path.challenge.effort)", color: FieldTheme.accent(path), filled: selected)
                }
                Text(path.tagline)
                    .font(.system(size: 14, weight: .medium, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 6) {
                    ForEach(path.traitEmphasis) { trait in
                        FieldTag(text: trait.label, color: FieldTheme.secondaryAccent(path))
                    }
                }

                HStack(spacing: 6) {
                    ForEach(Array(path.moltLine.enumerated()), id: \.element.stage) { index, molt in
                        Text(molt.name)
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(index == 0 ? .white : FieldTheme.tertiaryText)
                        if index < path.moltLine.count - 1 {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 8, weight: .bold))
                                .foregroundStyle(FieldTheme.tertiaryText)
                        }
                    }
                }

                if let recommendation = path.recommendation {
                    Text(recommendation)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(FieldTheme.accent(path))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: FieldTheme.cardCorner, style: .continuous)
                    .fill(FieldTheme.surface.opacity(selected ? 1 : 0.85))
            )
            .overlay(
                RoundedRectangle(cornerRadius: FieldTheme.cardCorner, style: .continuous)
                    .strokeBorder(
                        selected ? FieldTheme.accent(path) : FieldTheme.hairline,
                        lineWidth: selected ? 2 : 1
                    )
            )
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(path.displayName) path, \(path.challenge.label), \(path.challenge.effort). \(path.tagline)")
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
