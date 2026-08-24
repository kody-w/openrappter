import SwiftUI

/// A companion's whole visual identity: its own 16 notes, drawn.
///
/// There is no 3D model, no sprite and no character art in this app. The rings
/// are the motif's pitches and onsets, the roll is the same notes in time, and
/// the trace is a render of what you hear when you press Play.
struct SonicIdentityView: View {
    let signature: SonicSignature
    let path: StarterPath
    var companionName: String

    @Environment(WakeCallPlayer.self) private var player
    @Environment(FieldHaptics.self) private var haptics
    @Environment(AppModel.self) private var model
    @Environment(GameEngine.self) private var engine
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var startedAt: Date?

    private var isPlaying: Bool { player.isPlaying(signature.rappid) }

    private var animates: Bool {
        isPlaying && !reduceMotion && model.privacy.motifMotionEnabled
    }

    private var accessibilityDescription: String {
        """
        Sonic identity for \(companionName). Sixteen notes, \(signature.parameters.mode) mode, \
        root pitch \(signature.parameters.rootPitch), \(signature.parameters.bpm) beats per minute. \
        The motif renders to \(signature.midiBytes) bytes on this device.
        """
    }

    var body: some View {
        VStack(spacing: 14) {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !animates)) { context in
                let progress = progress(at: context.date)
                VStack(spacing: 12) {
                    MotifRingCanvas(signature: signature, path: path, progress: progress, live: animates)
                        .frame(height: 208)
                    MotifRollCanvas(signature: signature, path: path, progress: progress, live: animates)
                        .frame(height: 92)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(accessibilityDescription)

            controls

            if let failure = player.failureMessage {
                Text(failure)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FieldTheme.ember)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Playback problem. \(failure)")
            }

            Text(motifSummary)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(FieldTheme.tertiaryText)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onChange(of: player.state) { _, state in
            if case .playing = state { startedAt = Date() } else { startedAt = nil }
        }
    }

    private var motifSummary: String {
        "motif \(signature.parameters.mode) · root \(signature.parameters.rootPitch) · \(signature.parameters.bpm) bpm · dna-prompt.mid \(signature.midiBytes) B · sha256 \(String(signature.midiSha256.prefix(12)))…"
    }

    private func progress(at date: Date) -> Double {
        guard animates, let startedAt else { return isPlaying ? 0 : 1 }
        let seconds = date.timeIntervalSince(startedAt)
        let total = max(Double(signature.durationMilliseconds) / 1000.0 + 0.8, 0.5)
        return min(1, max(0, seconds / total))
    }

    @ViewBuilder
    private var controls: some View {
        HStack(spacing: 10) {
            if isPlaying {
                Button {
                    engine.dispatch(.stopSonicIdentity)
                } label: {
                    Label("Stop", systemImage: "stop.fill")
                }
                .buttonStyle(QuietButtonStyle(tint: FieldTheme.accent(path)))
                .accessibilityLabel("Stop the wake call for \(companionName)")
            } else {
                Button {
                    engine.dispatch(.playSonicIdentity)
                    if model.privacy.hapticsEnabled {
                        haptics.pulse(for: signature)
                    }
                } label: {
                    Label("Play wake call", systemImage: "play.fill")
                }
                .buttonStyle(PrimaryButtonStyle(tint: FieldTheme.accent(path)))
                .accessibilityLabel("Play the wake call for \(companionName)")
                .accessibilityHint("Nothing plays until you press this.")
            }
        }
    }
}

/// The identity ring: pitch as radius, onset as angle, velocity as weight.
struct MotifRingCanvas: View {
    let signature: SonicSignature
    let path: StarterPath
    let progress: Double
    let live: Bool

    var body: some View {
        Canvas { context, size in
            let centre = CGPoint(x: size.width / 2, y: size.height / 2)
            let maxRadius = min(size.width, size.height) / 2 - 14
            let accent = FieldTheme.accent(path)
            let secondary = FieldTheme.secondaryAccent(path)

            for step in stride(from: 0.3, through: 1.0, by: 0.175) {
                let radius = maxRadius * step
                let rect = CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2)
                context.stroke(Path(ellipseIn: rect), with: .color(.white.opacity(0.05)), lineWidth: 1)
            }

            var spine = Path()
            for (index, ring) in signature.rings.enumerated() {
                let point = position(ring, centre: centre, maxRadius: maxRadius)
                if index == 0 { spine.move(to: point) } else { spine.addLine(to: point) }
            }
            spine.closeSubpath()
            context.stroke(
                spine,
                with: .linearGradient(
                    Gradient(colors: [accent.opacity(0.8), secondary.opacity(0.5)]),
                    startPoint: .zero,
                    endPoint: CGPoint(x: size.width, y: size.height)
                ),
                lineWidth: 1.4
            )

            for (index, ring) in signature.rings.enumerated() {
                let point = position(ring, centre: centre, maxRadius: maxRadius)
                let reached = live ? Double(index) / Double(max(signature.rings.count - 1, 1)) <= progress : true
                let base = 3.0 + 5.0 * max(ring.weight, 0.05)
                let radius = reached && live ? base * 1.5 : base
                let colour = index < 8 ? accent : secondary
                let rect = CGRect(x: point.x - radius, y: point.y - radius, width: radius * 2, height: radius * 2)
                context.fill(
                    Path(ellipseIn: rect),
                    with: .color(colour.opacity(reached ? 0.95 : 0.35))
                )
                if reached && live {
                    let halo = rect.insetBy(dx: -radius * 1.4, dy: -radius * 1.4)
                    context.fill(Path(ellipseIn: halo), with: .color(colour.opacity(0.14)))
                }
            }

            if live {
                let angle = -Double.pi / 2 + progress * 2 * .pi
                var sweep = Path()
                sweep.move(to: centre)
                sweep.addLine(to: CGPoint(
                    x: centre.x + cos(angle) * maxRadius,
                    y: centre.y + sin(angle) * maxRadius
                ))
                context.stroke(sweep, with: .color(accent.opacity(0.4)), lineWidth: 1)
            }

            let coreRadius = 7.0 + (live ? 4.0 * sin(progress * .pi * 6) : 0)
            let core = CGRect(
                x: centre.x - coreRadius,
                y: centre.y - coreRadius,
                width: coreRadius * 2,
                height: coreRadius * 2
            )
            context.fill(Path(ellipseIn: core), with: .color(.white.opacity(0.85)))
        }
    }

    private func position(_ ring: SonicRing, centre: CGPoint, maxRadius: Double) -> CGPoint {
        let angle = -Double.pi / 2 + ring.phase
        return CGPoint(
            x: centre.x + cos(angle) * ring.radius * maxRadius,
            y: centre.y + sin(angle) * ring.radius * maxRadius
        )
    }
}

/// The same notes as a piano roll, over the rendered waveform trace.
struct MotifRollCanvas: View {
    let signature: SonicSignature
    let path: StarterPath
    let progress: Double
    let live: Bool

    var body: some View {
        Canvas { context, size in
            let accent = FieldTheme.accent(path)
            let secondary = FieldTheme.secondaryAccent(path)

            var trace = Path()
            let samples = signature.waveform
            for (index, sample) in samples.enumerated() {
                let x = size.width * Double(index) / Double(max(samples.count - 1, 1))
                let y = size.height / 2 - sample * (size.height / 2 - 6)
                if index == 0 { trace.move(to: CGPoint(x: x, y: y)) } else { trace.addLine(to: CGPoint(x: x, y: y)) }
            }
            context.stroke(trace, with: .color(.white.opacity(0.14)), lineWidth: 1)

            for cell in signature.roll {
                let x = cell.start * size.width
                let width = max(cell.width * size.width, 3)
                let height = 4.0 + 8.0 * cell.velocity
                let y = size.height - 8 - cell.pitch * (size.height - 22)
                let reached = live ? cell.start <= progress : true
                let rect = CGRect(x: x, y: y - height / 2, width: width, height: height)
                context.fill(
                    Path(roundedRect: rect, cornerRadius: height / 2),
                    with: .color((cell.isCall ? accent : secondary).opacity(reached ? 0.92 : 0.3))
                )
            }

            if live {
                var head = Path()
                let x = progress * size.width
                head.move(to: CGPoint(x: x, y: 0))
                head.addLine(to: CGPoint(x: x, y: size.height))
                context.stroke(head, with: .color(.white.opacity(0.5)), lineWidth: 1)
            }
        }
    }
}
