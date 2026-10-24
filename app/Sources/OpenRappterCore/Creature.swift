import SwiftUI

/// The five honest postures. A posture is a state; reactions are one-shot events that release.
public enum Posture: String, CaseIterable {
    case idle, listening, thinking, speaking, needsYou

    public var label: String {
        switch self {
        case .idle: return "resting"
        case .listening: return "listening"
        case .thinking: return "thinking"
        case .speaking: return "speaking"
        case .needsYou: return "needs you"
        }
    }

    public var tint: Color {
        switch self {
        case .idle: return .secondary
        case .listening: return .green
        case .thinking: return .yellow
        case .speaking: return .cyan
        case .needsYou: return .orange
        }
    }
}

@MainActor
public final class CreatureModel: ObservableObject {
    public init() {}
    @Published public var posture: Posture = .idle
    @Published public var line: String = "Hold ⌥ Space and talk to me."
    /// The need on the card, if the expanded view should show one.
    @Published public var need: Need?
    /// Mind is up but not signed in.
    @Published public var hungry: Bool = false
    /// A GitHub device code the person has to paste; shown big while a sign-in is in flight.
    @Published public var signInCode: String?
    /// The first-run card is up: the four powers and one button.
    @Published public var setup: Bool = false
    @Published public var powers: [Power: PowerState] = [:]
    public var onAnswer: ((Need, NeedOption) -> Void)?
    public var onLater: ((Need) -> Void)?
    public var onSignIn: (() -> Void)?
    public var onAllow: ((Power) -> Void)?
    public var onSetupLater: (() -> Void)?
}

/// The one primary button. Drawn by hand so it stays orange even though the notch window is never the key window.
public struct Primary: ButtonStyle {
    public var color: Color = .orange
    public init(color: Color = .orange) { self.color = color }
    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.black)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(configuration.isPressed ? 0.7 : 1)))
    }
}

/// First run: what I'm allowed to do, one row each, one button for the next thing to allow.
public struct SetupCard: View {
    @ObservedObject public var model: CreatureModel
    public init(model: CreatureModel) { self.model = model }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Let me set up").font(.headline).foregroundStyle(.white)
            Text(model.line).font(.callout).foregroundStyle(.white.opacity(0.85)).lineLimit(2)
            VStack(alignment: .leading, spacing: 3) {
                ForEach(Power.allCases) { p in
                    let st = model.powers[p] ?? .notAsked
                    HStack(spacing: 8) {
                        Image(systemName: st == .granted ? "checkmark.circle.fill" : (st == .denied ? "xmark.circle.fill" : "circle"))
                            .foregroundStyle(st == .granted ? Color.green : (st == .denied ? Color.red : Color.white.opacity(0.5)))
                        Image(systemName: p.symbol).foregroundStyle(.white.opacity(0.8)).frame(width: 16)
                        Text(p.title).foregroundStyle(.white)
                        Spacer()
                        Text(st.label).font(.caption).foregroundStyle(.white.opacity(0.6))
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(p.title), \(st.label)")
                }
            }.padding(.vertical, 2)
            HStack(spacing: 8) {
                if let next = Powers.next(model.powers) {
                    let st = model.powers[next] ?? .notAsked
                    Button(st == .denied || next == .typing || next == .screen ? "Allow: \(next.title) (opens Settings)" : "Allow: \(next.title)") { model.onAllow?(next) }
                        .buttonStyle(Primary())
                    Button("Later") { model.onSetupLater?() }.buttonStyle(.bordered)
                } else {
                    Button("Done") { model.onSetupLater?() }.buttonStyle(Primary(color: .green))
                }
            }.padding(.top, 2)
        }
    }
}

/// Placeholder silhouette until the 3D rappter (rappter-vui) is hosted in the expanded view.
public struct CreatureGlyph: View {
    @ObservedObject public var model: CreatureModel
    public var size: CGFloat = 18
    public init(model: CreatureModel, size: CGFloat = 18) { self.model = model; self.size = size }
    public var body: some View {
        Image(systemName: "lizard.fill")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(model.posture.tint)
            .symbolEffect(.pulse, isActive: model.posture == .thinking)
            .accessibilityLabel("rappter, \(model.posture.label)")
    }
}

public struct CompactLeading: View {
    @ObservedObject public var model: CreatureModel
    public init(model: CreatureModel) { self.model = model }
    public var body: some View { CreatureGlyph(model: model).padding(.leading, 4) }
}

public struct CompactTrailing: View {
    @ObservedObject public var model: CreatureModel
    public init(model: CreatureModel) { self.model = model }
    public var body: some View {
        Circle().fill(model.posture.tint).frame(width: 8, height: 8).padding(.trailing, 6)
    }
}

public struct Expanded: View {
    @ObservedObject public var model: CreatureModel
    public init(model: CreatureModel) { self.model = model }
    public var body: some View {
        HStack(alignment: .top, spacing: 14) {
            CreatureGlyph(model: model, size: 44).frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 6) {
                if model.setup {
                    SetupCard(model: model)
                } else if let need = model.need, model.posture == .needsYou {
                    Text(need.title).font(.headline).foregroundStyle(.white).lineLimit(2)
                    if let ctx = need.ctx, !ctx.isEmpty {
                        Text(ctx).font(.callout).foregroundStyle(.white.opacity(0.8)).lineLimit(3)
                    }
                    HStack(spacing: 8) {
                        ForEach(Array(need.opts.prefix(3).enumerated()), id: \.offset) { _, opt in
                            Button(opt.label) { model.onAnswer?(need, opt) }
                                .buttonStyle(.borderedProminent)
                                .tint(opt.rec == true ? Color.orange : Color(white: 0.35))
                        }
                        Button("Later") { model.onLater?(need) }.buttonStyle(.bordered)
                    }.padding(.top, 2)
                } else if model.hungry && model.posture == .needsYou {
                    Text("rappter").font(.headline).foregroundStyle(.white)
                    Text(model.line).font(.callout).foregroundStyle(.white.opacity(0.85)).lineLimit(3)
                    if let code = model.signInCode {
                        Text(code).font(.system(size: 26, weight: .bold, design: .monospaced)).foregroundStyle(.orange)
                            .accessibilityLabel("Your code is \(code.map { String($0) }.joined(separator: " "))")
                        Button("Open GitHub again") { model.onSignIn?() }.buttonStyle(.bordered)
                    } else {
                        Button("Sign me in") { model.onSignIn?() }.buttonStyle(Primary())
                    }
                } else {
                    Text("rappter").font(.headline).foregroundStyle(.white)
                    Text(model.line).font(.callout).foregroundStyle(.white.opacity(0.85)).lineLimit(4)
                    Text(model.posture.label).font(.caption).foregroundStyle(model.posture.tint)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(width: 440)
    }
}
