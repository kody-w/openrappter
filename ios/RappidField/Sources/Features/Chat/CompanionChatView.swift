import SwiftUI

struct CompanionChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(FieldNavigator.self) private var navigator
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Shared with the navigator so the debug autopilot drives the same
    /// conversation the operator sees.
    private var chat: ChatViewModel { navigator.chat }

    private var companion: Companion? { model.ownedCompanion ?? model.selectedCompanion }

    var body: some View {
        NavigationStack {
            ZStack {
                FieldBackground(path: companion?.path ?? model.chosenPath)
                if let companion {
                    conversation(companion: companion)
                } else {
                    ContentUnavailableView(
                        "No companion yet",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Choose a path or pair a host first.")
                    )
                }
            }
            .navigationTitle("CMR/1")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
        }
    }

    private func conversation(companion: Companion) -> some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        preamble(companion: companion)

                        ForEach(chat.messages) { message in
                            MessageBubble(message: message, path: companion.path)
                                .id(message.id)
                        }

                        if chat.isReceiving {
                            PresenceBubble(path: companion.path, reduceMotion: reduceMotion, name: companion.displayName)
                                .id("presence")
                        }

                        if let failure = chat.failure {
                            FieldCard(accent: FieldTheme.ember) {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(failure)
                                        .font(.system(size: 13, design: .rounded))
                                        .foregroundStyle(FieldTheme.ember)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Button("Dismiss") { chat.dismissFailure() }
                                        .buttonStyle(QuietButtonStyle(tint: FieldTheme.ember))
                                }
                            }
                            .id("failure")
                        }
                    }
                    .padding(.horizontal, 18)
                    .padding(.vertical, 14)
                }
                .onChange(of: chat.messages.count) { _, _ in
                    guard let last = chat.messages.last else { return }
                    if reduceMotion {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    } else {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            composer(companion: companion)
        }
    }

    private func preamble(companion: Companion) -> some View {
        FieldCard(accent: FieldTheme.violet) {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(
                    title: "Committed messages",
                    subtitle: "\(companion.displayName) buffers its reply privately and reveals it whole. You will never watch it think out loud."
                )
                HStack(spacing: 8) {
                    ForEach(["Who are you?", "What do you weigh?", "How do you grow?"], id: \.self) { prompt in
                        Button(prompt) { chat.ask(prompt, companion: companion) }
                            .font(.system(size: 12, weight: .semibold, design: .rounded))
                            .foregroundStyle(FieldTheme.accent(companion.path))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(FieldTheme.accent(companion.path).opacity(0.14)))
                            .disabled(chat.isReceiving)
                    }
                }
            }
        }
    }

    private func composer(companion: Companion) -> some View {
        HStack(spacing: 10) {
            TextField("Say something to \(companion.displayName)", text: Binding(
                get: { chat.input },
                set: { chat.input = $0 }
            ), axis: .vertical)
            .lineLimit(1...4)
            .textFieldStyle(.plain)
            .font(.system(size: 15, design: .rounded))
            .foregroundStyle(.white)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 14).fill(.white.opacity(0.07)))
            .accessibilityLabel("Message to \(companion.displayName)")

            if chat.isReceiving {
                Button {
                    chat.cancel()
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(FieldTheme.ink)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(FieldTheme.ember))
                }
                .accessibilityLabel("Cancel the reply")
                .accessibilityHint("Discards the buffered draft. Nothing partial is shown.")
            } else {
                Button {
                    chat.send(companion: companion)
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(FieldTheme.ink)
                        .frame(width: 44, height: 44)
                        .background(Circle().fill(FieldTheme.accent(companion.path)))
                }
                .disabled(chat.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .opacity(chat.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.4 : 1)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial)
    }
}

struct MessageBubble: View {
    let message: ChatViewModel.Message
    let path: StarterPath

    var body: some View {
        HStack {
            if message.role == .operatorSide { Spacer(minLength: 40) }
            Text(message.text)
                .font(.system(size: 14, design: .rounded))
                .foregroundStyle(message.role == .operatorSide ? FieldTheme.ink : .white)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(message.role == .operatorSide ? FieldTheme.accent(path) : FieldTheme.surface)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(message.role == .operatorSide ? .clear : FieldTheme.hairline, lineWidth: 1)
                )
                .fixedSize(horizontal: false, vertical: true)
            if message.role == .companion { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.role == .operatorSide ? "You said" : "Companion said"): \(message.text)")
    }
}

/// Presence, not progress.
///
/// The bubble says the companion is there and working. It never implies how
/// much has arrived, because that would be the same leak as showing the text.
struct PresenceBubble: View {
    let path: StarterPath
    let reduceMotion: Bool
    let name: String

    var body: some View {
        HStack(spacing: 10) {
            if reduceMotion {
                Image(systemName: "waveform")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(FieldTheme.accent(path))
                Text("\(name) is composing a reply")
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 24.0, paused: false)) { context in
                    let phase = context.date.timeIntervalSinceReferenceDate
                    HStack(spacing: 5) {
                        ForEach(0..<3, id: \.self) { index in
                            Circle()
                                .fill(FieldTheme.accent(path))
                                .frame(width: 7, height: 7)
                                .opacity(0.35 + 0.65 * (0.5 + 0.5 * sin(phase * 3 + Double(index) * 0.9)))
                        }
                    }
                }
                Text("\(name) is composing a reply")
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
            }
            Spacer(minLength: 20)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(FieldTheme.surface.opacity(0.8))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(name) is composing a reply. It will appear all at once.")
    }
}
