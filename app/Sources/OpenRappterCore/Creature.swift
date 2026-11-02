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
    /// The quiet stream: FYI notes that never pop the notch; seen only when Kody hovers over it.
    @Published public var stream: [Need] = []
    public var onAnswer: ((Need, NeedOption) -> Void)?
    public var onLater: ((Need) -> Void)?
    public var onSignIn: (() -> Void)?
    /// Object to a twin or trust decision from the stream (one tap; the twin learns from it).
    public var onObject: ((Need) -> Void)?
    @Published public var objected: Set<String> = []
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
                if let need = model.need, model.posture == .needsYou {
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
                    Button("Sign me in") { model.onSignIn?() }.buttonStyle(.borderedProminent).tint(.orange)
                } else {
                    Text("rappter").font(.headline).foregroundStyle(.white)
                    Text(model.line).font(.callout).foregroundStyle(.white.opacity(0.85)).lineLimit(4)
                    Text(model.posture.label).font(.caption).foregroundStyle(model.posture.tint)
                    if !model.stream.isEmpty {
                        Divider().overlay(Color.white.opacity(0.15)).padding(.vertical, 2)
                        ForEach(model.stream.prefix(6), id: \.id) { n in
                            HStack(alignment: .firstTextBaseline, spacing: 6) {
                                Text(StreamTime.ago(n.created)).font(.caption2).foregroundStyle(.white.opacity(0.45)).frame(width: 34, alignment: .leading)
                                Text(n.title).font(.caption).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
                                if n.source == "twin" {
                                    Spacer(minLength: 4)
                                    if model.objected.contains(n.id) {
                                        Text("objected").font(.caption2).foregroundStyle(.orange)
                                    } else {
                                        Button("Object") { model.objected.insert(n.id); model.onObject?(n) }
                                            .buttonStyle(.borderless).font(.caption2).foregroundStyle(.orange)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(width: 440)
    }
}

public enum StreamTime {
    public static func ago(_ t: Double?) -> String {
        guard let t else { return "" }
        let s = max(0, Int(Date().timeIntervalSince1970 - t))
        return s < 60 ? "now" : s < 3600 ? "\(s / 60)m" : s < 86400 ? "\(s / 3600)h" : "\(s / 86400)d"
    }
}
