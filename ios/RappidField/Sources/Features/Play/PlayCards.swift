import SwiftUI

/// A local discovery encounter, played by tapping the same commands an agent
/// sends. "Local" is local to the companion: the signal comes out of its own
/// motif, and no location is read, requested, or inferred.
struct EncounterCard: View {
    let companion: Companion
    @Environment(GameEngine.self) private var engine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var accent: Color { FieldTheme.accent(companion.path) }
    private var encounter: EncounterState? { engine.state.encounter }

    var body: some View {
        FieldCard(accent: accent) {
            VStack(alignment: .leading, spacing: 13) {
                SectionHeader(
                    title: "Discovery",
                    subtitle: encounter == nil
                        ? "Signals rise out of \(companion.displayName)'s own motif. Nothing about where you are is read."
                        : nil
                )

                if let encounter {
                    open(encounter)
                } else {
                    HStack {
                        FieldTag(text: "Attunement \(engine.state.attunement)/100", color: accent)
                        FieldTag(text: "\(engine.state.encountersResolved) resolved", color: FieldTheme.violet)
                        Spacer()
                    }
                    Button("Listen for a signal") { engine.dispatch(.beginEncounter) }
                        .buttonStyle(PrimaryButtonStyle(tint: accent))
                        .accessibilityHint("Opens a discovery encounter.")
                }

                if let outcome = engine.state.lastOutcome {
                    Text(outcome)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(FieldTheme.tertiaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    @ViewBuilder
    private func open(_ encounter: EncounterState) -> some View {
        HStack(spacing: 8) {
            FieldTag(text: encounter.kind, color: accent, filled: true)
            FieldTag(text: "strength \(encounter.strength)", color: FieldTheme.ember)
            Spacer()
            Text(encounter.isOpen ? "\(encounter.stepsRemaining) steps left" : encounter.phase.rawValue)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(FieldTheme.secondaryText)
        }

        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text("Attunement")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                Spacer()
                Text("\(encounter.attunement)/100")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(encounter.attunement >= EncounterState.attuneThreshold ? accent : FieldTheme.tertiaryText)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule()
                        .fill(accent)
                        .frame(width: geometry.size.width * CGFloat(encounter.attunement) / 100)
                    Capsule()
                        .stroke(FieldTheme.hairline, lineWidth: 1)
                        .frame(width: geometry.size.width * CGFloat(EncounterState.attuneThreshold) / 100)
                }
            }
            .frame(height: 7)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: encounter.attunement)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Attunement \(encounter.attunement) of 100, threshold \(EncounterState.attuneThreshold)")

        Text("\(encounter.revealedNotes) of \(EncounterState.notesToReveal) notes heard")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(FieldTheme.tertiaryText)

        if encounter.isOpen {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                ForEach(EncounterMove.allCases, id: \.self) { move in
                    Button(move.rawValue.capitalized) { engine.dispatch(.encounterMove(move)) }
                        .buttonStyle(QuietButtonStyle(tint: move == .withdraw ? FieldTheme.secondaryText : accent))
                        .accessibilityHint(move.explanation)
                }
            }
        } else {
            Button("Leave the signal") { engine.dispatch(.leaveEncounter) }
                .buttonStyle(PrimaryButtonStyle(tint: accent))
        }
    }
}

/// A call-and-response drill over the companion's own motif.
struct TrainingCard: View {
    let companion: Companion
    @Environment(GameEngine.self) private var engine

    private var accent: Color { FieldTheme.secondaryAccent(companion.path) }
    private var training: TrainingState? { engine.state.training }

    var body: some View {
        FieldCard(accent: accent) {
            VStack(alignment: .leading, spacing: 13) {
                SectionHeader(
                    title: "Training",
                    subtitle: training == nil
                        ? "Answer the shape of a fragment of the motif. Rising is extended, falling is inverted, level is echoed."
                        : nil
                )

                if let training {
                    drill(training)
                } else {
                    HStack {
                        FieldTag(text: "\(engine.state.drillsCompleted) drills", color: accent)
                        Spacer()
                    }
                    Button("Start a drill") { engine.dispatch(.beginTraining) }
                        .buttonStyle(PrimaryButtonStyle(tint: accent))
                }
            }
        }
    }

    @ViewBuilder
    private func drill(_ training: TrainingState) -> some View {
        HStack {
            Text(training.isOpen
                 ? "Round \(training.round + 1) of \(TrainingState.totalRounds)"
                 : "Complete")
                .font(.system(size: 13, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Spacer()
            Text("\(training.correct) right")
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(FieldTheme.secondaryText)
        }

        if training.isOpen {
            FragmentShape(prompt: training.prompt, tint: accent)
                .frame(height: 46)
                .accessibilityLabel("Fragment intervals \(training.intervals.map(String.init).joined(separator: ", "))")

            HStack(spacing: 8) {
                ForEach(TrainingAnswer.allCases, id: \.self) { answer in
                    Button(answer.rawValue.capitalized) { engine.dispatch(.trainingAnswer(answer)) }
                        .buttonStyle(QuietButtonStyle(tint: accent))
                        .accessibilityHint(answer.explanation)
                }
            }
        } else {
            Button("Put the drill away") { engine.dispatch(.endTraining) }
                .buttonStyle(PrimaryButtonStyle(tint: accent))
        }
    }
}

/// The current fragment, drawn as the shape you are being asked to name.
struct FragmentShape: View {
    let prompt: [Int]
    let tint: Color

    var body: some View {
        Canvas { context, size in
            guard prompt.count > 1 else { return }
            let low = prompt.min() ?? 0
            let high = prompt.max() ?? (low + 1)
            let span = max(high - low, 1)
            var path = Path()
            for (index, pitch) in prompt.enumerated() {
                let x = size.width * Double(index) / Double(prompt.count - 1)
                let y = size.height - 6 - (size.height - 12) * Double(pitch - low) / Double(span)
                if index == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
                let dot = CGRect(x: x - 3.5, y: y - 3.5, width: 7, height: 7)
                context.fill(Path(ellipseIn: dot), with: .color(tint))
            }
            context.stroke(path, with: .color(tint.opacity(0.6)), lineWidth: 1.5)
        }
    }
}
