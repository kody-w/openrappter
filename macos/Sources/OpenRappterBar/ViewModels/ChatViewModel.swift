import Foundation
import SwiftUI

// MARK: - Chat ViewModel

@Observable
@MainActor
public final class ChatViewModel {
    // Messages
    public var messages: [ChatMessage] = []
    public var streamingText: String = ""
    public var chatState: ChatState = .idle
    public var chatInput: String = ""
    public var currentSessionKey: String?

    // Services
    private var rpcClient: RpcClient?
    private var sessionStore: SessionStore?

    // MARK: - Computed

    public var canSend: Bool {
        !chatInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var hasMessages: Bool {
        !messages.isEmpty || !streamingText.isEmpty
    }

    // MARK: - Init

    public init() {}

    // MARK: - Configuration

    public func configure(rpcClient: RpcClient, sessionStore: SessionStore) {
        self.rpcClient = rpcClient
        self.sessionStore = sessionStore
    }

    // MARK: - Actions

    public func sendMessage() {
        let text = chatInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let rpc = rpcClient else { return }

        chatInput = ""
        chatState = .sending
        streamingText = ""

        // Add user message
        let userMsg = ChatMessage(
            role: .user,
            content: text,
            sessionKey: currentSessionKey ?? ""
        )
        messages.append(userMsg)

        Task {
            // Persist user message
            await sessionStore?.addMessage(userMsg)

            do {
                let accepted = try await rpc.sendChat(message: text, sessionKey: currentSessionKey)
                currentSessionKey = accepted.sessionKey

                // Update the user message with correct sessionKey if it changed
                if userMsg.sessionKey.isEmpty {
                    let updated = ChatMessage(
                        id: userMsg.id,
                        role: .user,
                        content: text,
                        timestamp: userMsg.timestamp,
                        sessionKey: accepted.sessionKey
                    )
                    if let idx = messages.firstIndex(where: { $0.id == userMsg.id }) {
                        messages[idx] = updated
                    }
                    await sessionStore?.addMessage(updated)
                }

                // Ensure session exists
                await sessionStore?.ensureSession(sessionKey: accepted.sessionKey)
                chatState = .streaming
            } catch {
                chatState = .error(error.localizedDescription)
                let errMsg = ChatMessage(
                    role: .error,
                    content: "Send failed: \(error.localizedDescription)",
                    sessionKey: currentSessionKey ?? ""
                )
                messages.append(errMsg)
            }
        }
    }

    public func abortChat() {
        guard let sessionKey = currentSessionKey, let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.abortChat(sessionKey: sessionKey)
                chatState = .idle
                streamingText = ""
            } catch {
                // Silently ignore abort failures
            }
        }
    }

    // MARK: - Event Handling

    public func handleChatEvent(_ payload: ChatEventPayload) {
        switch payload.state {
        case .delta:
            streamingText = payload.messageText ?? streamingText
            chatState = .streaming

        case .final_:
            let finalText = payload.messageText ?? streamingText
            if !finalText.isEmpty {
                let msg = ChatMessage(
                    role: .assistant,
                    content: finalText,
                    sessionKey: payload.sessionKey
                )
                messages.append(msg)
                Task { await sessionStore?.addMessage(msg) }
            }
            streamingText = ""
            chatState = .idle

        case .error:
            let errorMsg = payload.errorMessage ?? "Unknown error"
            chatState = .error(errorMsg)
            let msg = ChatMessage(
                role: .error,
                content: "Agent error: \(errorMsg)",
                sessionKey: payload.sessionKey
            )
            messages.append(msg)
            streamingText = ""
        }
    }

    // MARK: - Session Switching

    public func switchToSession(sessionKey: String) {
        currentSessionKey = sessionKey
        streamingText = ""
        chatState = .idle

        Task {
            // Load messages from local cache
            let cached = await sessionStore?.getMessages(sessionKey: sessionKey) ?? []
            messages = cached

            // Try to load from gateway
            if let rpc = rpcClient {
                do {
                    let gatewayMessages = try await rpc.getSessionMessages(sessionKey: sessionKey)
                    let parsed = gatewayMessages.compactMap { parseGatewayMessage($0, sessionKey: sessionKey) }
                    if !parsed.isEmpty {
                        messages = parsed
                    }
                } catch {
                    // Fall back to cached messages
                }
            }
        }
    }

    public func clearMessages() {
        messages = []
        streamingText = ""
        chatState = .idle
        if let sessionKey = currentSessionKey {
            Task { await sessionStore?.clearMessages(sessionKey: sessionKey) }
        }
    }

    public func newSession() {
        currentSessionKey = nil
        messages = []
        streamingText = ""
        chatState = .idle
    }

    // MARK: - Private

    private func parseGatewayMessage(_ data: [String: Any], sessionKey: String) -> ChatMessage? {
        guard let role = data["role"] as? String else { return nil }
        let messageRole: MessageRole = role == "user" ? .user : .assistant

        var content = ""
        if let contentArray = data["content"] as? [[String: Any]] {
            for item in contentArray {
                if let text = item["text"] as? String {
                    content += text
                }
            }
        } else if let text = data["content"] as? String {
            content = text
        }

        guard !content.isEmpty else { return nil }

        let timestamp: Date
        if let ts = data["timestamp"] as? Double {
            timestamp = Date(timeIntervalSince1970: ts / 1000)
        } else {
            timestamp = Date()
        }

        return ChatMessage(
            role: messageRole,
            content: content,
            timestamp: timestamp,
            sessionKey: sessionKey
        )
    }
}
