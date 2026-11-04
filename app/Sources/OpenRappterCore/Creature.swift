import SwiftUI
import Combine

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
    @Published public var canDismissLine = false
    @Published public var acceptsInput = true
    @Published public var inputFocusRequest = 0
    @Published public var draft = ""
    /// The quiet stream: FYI notes that never pop the notch; seen only when Kody hovers over it.
    @Published public var stream: [Need] = []
    public var onAnswer: ((Need, NeedOption) -> Void)?
    public var onLater: ((Need) -> Void)?
    public var onSignIn: (() -> Void)?
    public var onSubmit: ((String) -> Void)?
    public var onDismissLine: (() -> Void)?
    public var onDraftChanged: ((Bool) -> Void)?
    /// Object to a twin or trust decision from the stream (one tap; the twin learns from it).
    public var onObject: ((Need) -> Void)?
    @Published public var objected: Set<String> = []
    private var streamSubscription: AnyCancellable?

    public func apply(_ view: CreaturePresentation) {
        posture = view.posture; line = view.line
        need = view.need; hungry = view.hungry
        canDismissLine = view.canDismissLine
        acceptsInput = view.acceptsInput
    }

    public func followStream(_ queue: NeedsQueue) {
        streamSubscription = queue.$stream.sink { [weak self] in self?.stream = $0 }
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
    @FocusState private var typing: Bool
    public init(model: CreatureModel) { self.model = model }
    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 14) {
                CreatureGlyph(model: model, size: 44).frame(width: 64, height: 64)
                ScrollView {
                    content.frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 240)
                .scrollIndicators(.visible)
                .id(model.need?.id ?? (model.posture == .idle || model.posture == .speaking ? "answer" : model.posture.rawValue))
            }
            if model.canDismissLine {
                Button("Got it") { model.onDismissLine?() }.buttonStyle(.bordered)
            }
            HStack {
                TextField("Type a question, or go to sleep", text: $model.draft)
                    .textFieldStyle(.roundedBorder)
                    .focused($typing)
                    .onSubmit(submit)
                Button("Send", action: submit)
                    .disabled(!canSubmit)
            }
        }
        .padding(16)
        .frame(width: 440)
        .onAppear { if model.inputFocusRequest > 0 { typing = true } }
        .onChange(of: model.inputFocusRequest) { typing = true }
        .onChange(of: model.draft) {
            model.onDraftChanged?(!model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private func submit() {
        guard canSubmit else { return }
        let text = model.draft
        model.draft = ""
        model.onSubmit?(text)
    }

    private var canSubmit: Bool {
        !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
            (model.acceptsInput || CreatureStateMachine.isSleepCommand(model.draft))
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let need = model.need, model.posture == .needsYou {
                Text(need.title).font(.headline).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
                if let ctx = need.ctx, !ctx.isEmpty {
                    Text(ctx).font(.callout).foregroundStyle(.white.opacity(0.8)).fixedSize(horizontal: false, vertical: true)
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(need.opts.enumerated()), id: \.offset) { _, opt in
                        Button(opt.label) { model.onAnswer?(need, opt) }
                            .buttonStyle(.borderedProminent)
                            .tint(opt.rec == true ? Color.orange : Color(white: 0.35))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button("Later") { model.onLater?(need) }.buttonStyle(.bordered)
                }.padding(.top, 2)
            } else if model.hungry && model.posture == .needsYou {
                Text("rappter").font(.headline).foregroundStyle(.white)
                Text(model.line).font(.callout).foregroundStyle(.white.opacity(0.85)).fixedSize(horizontal: false, vertical: true)
                Button("Sign me in") { model.onSignIn?() }.buttonStyle(.borderedProminent).tint(.orange)
            } else {
                Text("rappter").font(.headline).foregroundStyle(.white)
                Text(model.line).font(.callout).foregroundStyle(.white.opacity(0.85)).fixedSize(horizontal: false, vertical: true)
                Text(model.posture.label).font(.caption).foregroundStyle(model.posture.tint)
                if !model.stream.isEmpty {
                    Divider().overlay(Color.white.opacity(0.15)).padding(.vertical, 2)
                    ForEach(model.stream.prefix(6), id: \.id) { n in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(StreamTime.ago(n.created)).font(.caption2).foregroundStyle(.white.opacity(0.45)).frame(width: 34, alignment: .leading)
                            Text(n.title).font(.caption).foregroundStyle(.white.opacity(0.7)).fixedSize(horizontal: false, vertical: true)
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
    }
}

public enum StreamTime {
    public static func ago(_ t: Double?) -> String {
        guard let t else { return "" }
        let s = max(0, Int(Date().timeIntervalSince1970 - t))
        return s < 60 ? "now" : s < 3600 ? "\(s / 60)m" : s < 86400 ? "\(s / 3600)h" : "\(s / 86400)d"
    }
}
