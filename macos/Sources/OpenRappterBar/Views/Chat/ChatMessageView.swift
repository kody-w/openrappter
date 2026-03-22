import SwiftUI

// MARK: - Chat Message View

public struct ChatMessageView: View {
    let message: ChatMessage

    public init(message: ChatMessage) {
        self.message = message
    }

    public var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: 40)
                userBubble
            } else if message.role == .assistant {
                assistantBubble
                Spacer(minLength: 40)
            } else if message.role == .error {
                errorBubble
            } else {
                systemMessage
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 3)
    }

    // MARK: - User Bubble (right-aligned, blue)

    private var userBubble: some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(message.content)
                .font(.callout)
                .foregroundStyle(.white)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    LinearGradient(
                        colors: [Color.blue, Color.blue.opacity(0.85)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .clipShape(BubbleShape(isUser: true))

            Text(message.timestamp, style: .time)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .padding(.trailing, 4)
        }
    }

    // MARK: - Assistant Bubble (left-aligned, material)

    private var assistantBubble: some View {
        HStack(alignment: .top, spacing: 6) {
            // Dino avatar
            Text("🦖")
                .font(.system(size: 14))
                .frame(width: 24, height: 24)
                .background(Color.green.opacity(0.15))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 2) {
                // Render markdown
                if let attributed = try? AttributedString(
                    markdown: message.content,
                    options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                ) {
                    Text(attributed)
                        .font(.callout)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.primary.opacity(0.06))
                        .clipShape(BubbleShape(isUser: false))
                } else {
                    Text(message.content)
                        .font(.callout)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.primary.opacity(0.06))
                        .clipShape(BubbleShape(isUser: false))
                }

                Text(message.timestamp, style: .time)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 4)
            }
        }
    }

    // MARK: - Error

    private var errorBubble: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .frame(width: 24, height: 24)

            Text(message.content)
                .font(.callout)
                .foregroundStyle(.red)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.red.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - System Message

    private var systemMessage: some View {
        Text(message.content)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
    }
}

// MARK: - Bubble Shape

struct BubbleShape: Shape {
    let isUser: Bool

    func path(in rect: CGRect) -> Path {
        let radius: CGFloat = 14
        let tailSize: CGFloat = 4

        var path = Path()

        if isUser {
            // User bubble: rounded with small tail on bottom-right
            path.addRoundedRect(
                in: CGRect(x: rect.minX, y: rect.minY, width: rect.width - tailSize, height: rect.height),
                cornerSize: CGSize(width: radius, height: radius)
            )
            // Tail
            path.move(to: CGPoint(x: rect.maxX - tailSize, y: rect.maxY - 8))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - 2))
            path.addLine(to: CGPoint(x: rect.maxX - tailSize - 6, y: rect.maxY))
        } else {
            // Assistant bubble: rounded with small tail on bottom-left
            path.addRoundedRect(
                in: CGRect(x: rect.minX + tailSize, y: rect.minY, width: rect.width - tailSize, height: rect.height),
                cornerSize: CGSize(width: radius, height: radius)
            )
            // Tail
            path.move(to: CGPoint(x: rect.minX + tailSize, y: rect.maxY - 8))
            path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - 2))
            path.addLine(to: CGPoint(x: rect.minX + tailSize + 6, y: rect.maxY))
        }

        return path
    }
}
