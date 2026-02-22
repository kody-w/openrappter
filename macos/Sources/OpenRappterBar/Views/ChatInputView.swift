import SwiftUI

@MainActor
public struct ChatInputView: View {
    @Bindable var viewModel: AppViewModel

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Multi-line input + send/abort buttons
            HStack(alignment: .bottom, spacing: 8) {
                TextEditor(text: $viewModel.chatInput)
                    .font(.body)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(.background)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                    )
                    .frame(minHeight: 36, maxHeight: 120)
                    .onKeyPress(keys: [.return], phases: .down) { keyPress in
                        // Shift+Return inserts newline, plain Return sends
                        if keyPress.modifiers.contains(.shift) {
                            return .ignored
                        }
                        if viewModel.canSend {
                            viewModel.sendMessage()
                            return .handled
                        }
                        return .ignored
                    }

                VStack(spacing: 4) {
                    if case .streaming = viewModel.chatState {
                        // Abort button during streaming
                        Button {
                            viewModel.chatViewModel.abortChat()
                        } label: {
                            Image(systemName: "stop.circle.fill")
                                .font(.title2)
                                .foregroundStyle(.red)
                        }
                        .buttonStyle(.borderless)
                        .help("Stop generation")
                    } else {
                        // Send button
                        Button {
                            viewModel.sendMessage()
                        } label: {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.title2)
                        }
                        .buttonStyle(.borderless)
                        .disabled(!viewModel.canSend)
                        .help("Send (Return)")
                    }
                }
            }

            // Error display
            if case .error(let message) = viewModel.chatState {
                ErrorBanner(message: message) {
                    viewModel.chatViewModel.chatState = .idle
                }
            }

            // Sending indicator
            if case .sending = viewModel.chatState {
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Sending...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}
