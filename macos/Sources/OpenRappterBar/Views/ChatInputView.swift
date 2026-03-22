import SwiftUI

@MainActor
public struct ChatInputView: View {
    @Bindable var viewModel: AppViewModel
    @FocusState private var isFocused: Bool

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Error display
            if case .error(let message) = viewModel.chatState {
                ErrorBanner(message: message) {
                    viewModel.chatViewModel.chatState = .idle
                }
            }

            // Input row
            HStack(alignment: .bottom, spacing: 8) {
                // Text input with placeholder
                ZStack(alignment: .topLeading) {
                    if viewModel.chatInput.isEmpty {
                        Text("Message OpenRappter...")
                            .font(.callout)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                    }

                    TextEditor(text: $viewModel.chatInput)
                        .font(.callout)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .focused($isFocused)
                        .onKeyPress(keys: [.return], phases: .down) { keyPress in
                            if keyPress.modifiers.contains(.shift) {
                                return .ignored
                            }
                            if viewModel.canSend {
                                viewModel.sendMessage()
                                return .handled
                            }
                            return .ignored
                        }
                }
                .frame(minHeight: 36, maxHeight: 100)
                .background(
                    RoundedRectangle(cornerRadius: 18)
                        .fill(Color.primary.opacity(0.04))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 18)
                        .stroke(isFocused ? Color.accentColor.opacity(0.5) : Color.primary.opacity(0.1), lineWidth: 1)
                )

                // Send / Abort button
                if case .streaming = viewModel.chatState {
                    Button {
                        viewModel.chatViewModel.abortChat()
                    } label: {
                        Image(systemName: "stop.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .background(Color.red)
                            .clipShape(Circle())
                    }
                    .buttonStyle(.borderless)
                    .help("Stop generation")
                } else if case .sending = viewModel.chatState {
                    ProgressView()
                        .controlSize(.small)
                        .frame(width: 30, height: 30)
                } else {
                    Button {
                        viewModel.sendMessage()
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 30, height: 30)
                            .background(viewModel.canSend ? Color.accentColor : Color.gray.opacity(0.4))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.borderless)
                    .disabled(!viewModel.canSend)
                    .help("Send (Return)")
                }
            }
        }
    }
}
