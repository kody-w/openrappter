import SwiftUI

// MARK: - Chat Message View

public struct ChatMessageView: View {
    let message: ChatMessage

    public init(message: ChatMessage) {
        self.message = message
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: roleIcon)
                .font(.caption)
                .foregroundStyle(roleColor)
                .frame(width: 16, alignment: .center)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Text(roleLabel)
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(roleColor)
                    Spacer()
                    Text(message.timestamp, style: .time)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                // Render markdown for assistant messages, plain text for others
                if message.role == .assistant,
                   let attributed = try? AttributedString(
                       markdown: message.content,
                       options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                   ) {
                    Text(attributed)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text(message.content)
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(messageBackground)
    }

    private var roleIcon: String {
        switch message.role {
        case .user: return "person.fill"
        case .assistant: return "cpu"
        case .system: return "info.circle"
        case .error: return "exclamationmark.triangle.fill"
        }
    }

    private var roleColor: Color {
        switch message.role {
        case .user: return .blue
        case .assistant: return .green
        case .system: return .secondary
        case .error: return .red
        }
    }

    private var roleLabel: String {
        switch message.role {
        case .user: return "You"
        case .assistant: return "Assistant"
        case .system: return "System"
        case .error: return "Error"
        }
    }

    private var messageBackground: Color {
        switch message.role {
        case .user: return Color.primary.opacity(0.04)
        case .assistant: return Color.primary.opacity(0.02)
        case .system: return Color.clear
        case .error: return Color.red.opacity(0.05)
        }
    }
}
