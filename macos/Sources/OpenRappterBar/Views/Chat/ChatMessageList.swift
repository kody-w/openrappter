import SwiftUI

// MARK: - Chat Message List

public struct ChatMessageList: View {
    let messages: [ChatMessage]
    let streamingText: String
    let isStreaming: Bool

    @State private var showScrollToBottom = false

    public init(messages: [ChatMessage], streamingText: String = "", isStreaming: Bool = false) {
        self.messages = messages
        self.streamingText = streamingText
        self.isStreaming = isStreaming
    }

    public var body: some View {
        if messages.isEmpty && streamingText.isEmpty {
            emptyState
        } else {
            ZStack(alignment: .bottom) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                                // Date separator
                                if shouldShowDateSeparator(at: index) {
                                    dateSeparator(for: message.timestamp)
                                }

                                ChatMessageView(message: message)
                                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                            }

                            // Streaming indicator
                            if isStreaming {
                                StreamingIndicator(text: streamingText)
                                    .id("streaming")
                                    .transition(.opacity)
                            }

                            // Anchor for scrolling
                            Color.clear
                                .frame(height: 8)
                                .id("bottom")
                        }
                        .padding(.vertical, 8)
                    }
                    .onChange(of: messages.count) {
                        scrollToBottom(proxy: proxy)
                    }
                    .onChange(of: streamingText) {
                        if isStreaming {
                            scrollToBottom(proxy: proxy)
                        }
                    }
                }

                // Scroll-to-bottom button
                if showScrollToBottom && messages.count > 5 {
                    scrollToBottomButton
                        .padding(.bottom, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        VStack(spacing: 12) {
            Text("🦖")
                .font(.system(size: 36))

            Text("What's on your mind?")
                .font(.callout)
                .foregroundStyle(.secondary)

            Text("Try the quick actions above or type a message")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Date Separator

    private func shouldShowDateSeparator(at index: Int) -> Bool {
        guard index > 0 else { return false }
        let current = messages[index].timestamp
        let previous = messages[index - 1].timestamp
        return !Calendar.current.isDate(current, inSameDayAs: previous)
    }

    private func dateSeparator(for date: Date) -> some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 0.5)
            Text(date.formatted(date: .abbreviated, time: .omitted))
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.tertiary)
                .fixedSize()
            Rectangle()
                .fill(Color.primary.opacity(0.08))
                .frame(height: 0.5)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 10)
    }

    // MARK: - Scroll to Bottom

    private var scrollToBottomButton: some View {
        Button {
            showScrollToBottom = false
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .background(.ultraThinMaterial, in: Circle())
                .shadow(color: .black.opacity(0.1), radius: 2, y: 1)
        }
        .buttonStyle(.borderless)
    }

    private func scrollToBottom(proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) {
            if isStreaming {
                proxy.scrollTo("streaming", anchor: .bottom)
            } else {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
        showScrollToBottom = false
    }
}
