import SwiftUI

/// The five honest postures. A posture is a state; reactions are one-shot events that release.
enum Posture: String, CaseIterable {
    case idle, listening, thinking, speaking, needsYou

    var label: String {
        switch self {
        case .idle: return "resting"
        case .listening: return "listening"
        case .thinking: return "thinking"
        case .speaking: return "speaking"
        case .needsYou: return "needs you"
        }
    }

    var tint: Color {
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
final class CreatureModel: ObservableObject {
    @Published var posture: Posture = .idle
    @Published var line: String = "Hold ⌥ Space and talk to me."
}

/// Placeholder silhouette until the 3D rappter (rappter-vui) is hosted in the expanded view.
struct CreatureGlyph: View {
    @ObservedObject var model: CreatureModel
    var size: CGFloat = 18
    var body: some View {
        Image(systemName: "lizard.fill")
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(model.posture.tint)
            .symbolEffect(.pulse, isActive: model.posture == .thinking)
            .accessibilityLabel("rappter, \(model.posture.label)")
    }
}

struct CompactLeading: View {
    @ObservedObject var model: CreatureModel
    var body: some View { CreatureGlyph(model: model).padding(.leading, 4) }
}

struct CompactTrailing: View {
    @ObservedObject var model: CreatureModel
    var body: some View {
        Circle().fill(model.posture.tint).frame(width: 8, height: 8).padding(.trailing, 6)
    }
}

struct Expanded: View {
    @ObservedObject var model: CreatureModel
    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            CreatureGlyph(model: model, size: 44).frame(width: 64, height: 64)
            VStack(alignment: .leading, spacing: 6) {
                Text("rappter").font(.headline).foregroundStyle(.white)
                Text(model.line).font(.callout).foregroundStyle(.white.opacity(0.85)).lineLimit(3)
                Text(model.posture.label).font(.caption).foregroundStyle(model.posture.tint)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .frame(width: 380)
    }
}
