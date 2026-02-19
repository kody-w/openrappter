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

                                if message.id != messages.last?.id {
                                    Divider().padding(.leading, 36)
                                }
                            }

                            // Streaming indicator
                            if isStreaming && !streamingText.isEmpty {
                                StreamingIndicator(text: streamingText)
                                    .id("streaming")
                            }

                            // Anchor for scrolling
                            Color.clear
                                .frame(height: 1)
                                .id("bottom")
                        }
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
        VStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.title2)
                .foregroundStyle(.tertiary)
            Text("No messages yet")
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
        HStack {
            VStack { Divider() }
            Text(date.formatted(date: .abbreviated, time: .omitted))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize()
            VStack { Divider() }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - Scroll to Bottom

    private var scrollToBottomButton: some View {
        Button {
            showScrollToBottom = false
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "arrow.down")
                    .font(.caption2)
                Text("Latest")
                    .font(.caption2)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(.ultraThinMaterial, in: Capsule())
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
