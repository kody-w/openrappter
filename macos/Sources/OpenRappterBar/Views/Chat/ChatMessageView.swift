import SwiftUI

// MARK: - Chat Message View

public struct ChatMessageView: View {
    let message: ChatMessage
    var onReauth: (() -> Void)?

    public init(message: ChatMessage, onReauth: (() -> Void)? = nil) {
        self.message = message
        self.onReauth = onReauth
    }

    public var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: 40)
                userBubble
            } else if message.role == .assistant {
                assistantBubble
                Spacer(minLength: 20)
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
                .clipShape(RoundedRectangle(cornerRadius: 16))

            Text(message.timestamp, style: .time)
                .font(.system(size: 9))
                .foregroundStyle(.tertiary)
                .padding(.trailing, 4)
        }
    }

    // MARK: - Assistant Bubble (left-aligned, rendered markdown)

    private var assistantBubble: some View {
        HStack(alignment: .top, spacing: 6) {
            // Dino avatar
            Text("🦖")
                .font(.system(size: 14))
                .frame(width: 24, height: 24)
                .background(Color.green.opacity(0.15))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 2) {
                MarkdownContentView(content: message.content)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Color.primary.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 16))

                Text(message.timestamp, style: .time)
                    .font(.system(size: 9))
                    .foregroundStyle(.tertiary)
                    .padding(.leading, 4)
            }
        }
    }

    // MARK: - Error

    private var errorBubble: some View {
        let isAuthError = message.content.contains("401") || message.content.contains("403")
            || message.content.contains("Copilot") || message.content.contains("token")

        return HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .frame(width: 24, height: 24)

            VStack(alignment: .leading, spacing: 8) {
                Text(message.content)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.red.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 12))

                if isAuthError, let onReauth {
                    Button(action: onReauth) {
                        Label("Re-authenticate GitHub", systemImage: "key.fill")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.blue)
                    .controlSize(.small)
                }
            }
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

// MARK: - Markdown Content View

/// Renders markdown content with proper heading, list, and code block support.
struct MarkdownContentView: View {
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(parseBlocks().enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let text):
                    Text(inlineMarkdown(text))
                        .font(headingFont(level))
                        .fontWeight(.semibold)
                        .padding(.top, level == 1 ? 4 : 2)

                case .listItem(let text, let indent):
                    HStack(alignment: .top, spacing: 4) {
                        Text("•")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .padding(.leading, CGFloat(indent) * 12)
                        Text(inlineMarkdown(text))
                            .font(.callout)
                            .textSelection(.enabled)
                    }

                case .codeBlock(let code):
                    Text(code)
                        .font(.system(size: 11, design: .monospaced))
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 6))

                case .paragraph(let text):
                    Text(inlineMarkdown(text))
                        .font(.callout)
                        .textSelection(.enabled)

                case .divider:
                    Divider()
                        .padding(.vertical, 2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Block Parser

    private enum Block {
        case heading(Int, String)
        case listItem(String, Int)
        case codeBlock(String)
        case paragraph(String)
        case divider
    }

    private func parseBlocks() -> [Block] {
        var blocks: [Block] = []
        let lines = content.components(separatedBy: "\n")
        var inCodeBlock = false
        var codeLines: [String] = []
        var paragraphLines: [String] = []

        func flushParagraph() {
            let text = paragraphLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                blocks.append(.paragraph(text))
            }
            paragraphLines = []
        }

        for line in lines {
            // Code block toggle
            if line.hasPrefix("```") {
                if inCodeBlock {
                    blocks.append(.codeBlock(codeLines.joined(separator: "\n")))
                    codeLines = []
                    inCodeBlock = false
                } else {
                    flushParagraph()
                    inCodeBlock = true
                }
                continue
            }

            if inCodeBlock {
                codeLines.append(line)
                continue
            }

            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Empty line — flush paragraph
            if trimmed.isEmpty {
                flushParagraph()
                continue
            }

            // Divider
            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph()
                blocks.append(.divider)
                continue
            }

            // Headings: ### Text, ## Text, # Text
            if trimmed.hasPrefix("#") {
                let hashes = trimmed.prefix(while: { $0 == "#" })
                let level = min(hashes.count, 3)
                let rest = trimmed.dropFirst(level).trimmingCharacters(in: .whitespaces)
                if !rest.isEmpty {
                    flushParagraph()
                    blocks.append(.heading(level, rest))
                    continue
                }
            }

            // List items: - text, * text, + text
            if (trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") || trimmed.hasPrefix("+ ")) {
                flushParagraph()
                let indent = line.prefix(while: { $0 == " " || $0 == "\t" }).count / 2
                let text = String(trimmed.dropFirst(2))
                blocks.append(.listItem(text, indent))
                continue
            }

            // Regular text
            paragraphLines.append(trimmed)
        }

        // Flush remaining
        if inCodeBlock && !codeLines.isEmpty {
            blocks.append(.codeBlock(codeLines.joined(separator: "\n")))
        }
        flushParagraph()

        return blocks
    }

    // MARK: - Inline Markdown

    private func inlineMarkdown(_ text: String) -> AttributedString {
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            return attributed
        }
        return AttributedString(text)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: return .system(size: 16, weight: .bold)
        case 2: return .system(size: 14, weight: .semibold)
        default: return .system(size: 13, weight: .semibold)
        }
    }
}
