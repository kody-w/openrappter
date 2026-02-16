import SwiftUI

public struct ChatInputView: View {
    @Bindable var viewModel: AppViewModel

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Input field + send button
            HStack(spacing: 8) {
                TextField("Send a message...", text: $viewModel.chatInput)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit {
                        if viewModel.canSend {
                            viewModel.sendMessage()
                        }
                    }

                Button {
                    viewModel.sendMessage()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.borderless)
                .disabled(!viewModel.canSend)
            }

            // Streaming display
            if case .streaming = viewModel.chatState, !viewModel.streamingText.isEmpty {
                streamingDisplay
            }

            // Error display
            if case .error(let message) = viewModel.chatState {
                errorDisplay(message: message)
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

    private var streamingDisplay: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                ProgressView()
                    .controlSize(.mini)
                Text("Assistant")
                    .font(.caption)
                    .fontWeight(.medium)
                    .foregroundStyle(.green)
            }

            Text(viewModel.streamingText)
                .font(.caption)
                .lineLimit(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(.fill.tertiary)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }

    private func errorDisplay(message: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .font(.caption)
            Text(message)
                .font(.caption)
                .foregroundStyle(.red)
                .lineLimit(2)
        }
    }
}
