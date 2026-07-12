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

    /// Called when the gateway reports a GitHub/Copilot auth failure. The host
    /// should kick off the device-code flow inline (no manual button click).
    public var onAuthRequired: (() -> Void)?

    /// Guard so we only auto-trigger reauth once per failing burst, not on every
    /// retry until the device-code flow completes.
    private var isAutoReauthing: Bool = false

    /// Timestamp of the last completed reauth attempt. If a Copilot 401 arrives
    /// shortly after, the new token also lacks Copilot access (account doesn't
    /// have it enabled / OAuth app not authorized) — auto-retry would loop, so
    /// we surface a diagnostic instead.
    private var lastAuthCompletedAt: Date?
    private static let postAuthDiagnosticWindow: TimeInterval = 120 // seconds

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

    public func clearConfiguration() {
        rpcClient = nil
    }

    var isRpcClientConfigured: Bool {
        rpcClient != nil
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
            streamingText = ""

            if isCopilotAuthError(errorMsg), let trigger = onAuthRequired {
                chatState = .idle

                // If a Copilot 401 still arrives shortly after a successful
                // device-code flow, retrying the same flow won't change
                // anything — surface the gateway error so the user (or we)
                // can diagnose it instead of looping.
                if let last = lastAuthCompletedAt,
                   Date().timeIntervalSince(last) < Self.postAuthDiagnosticWindow {
                    lastAuthCompletedAt = nil
                    addSystemMessage(
                        "⚠️ Re-auth succeeded but Copilot still rejected the token. "
                        + "Try again in a moment, or use the menu bar → 🔑 Re-authenticate GitHub "
                        + "to switch accounts. (\(errorMsg))"
                    )
                    return
                }

                // First-time auth-required: kick off the device-code flow.
                if !isAutoReauthing {
                    isAutoReauthing = true
                    addSystemMessage("🔑 GitHub Copilot needs re-authentication — starting sign-in…")
                    trigger()
                }
                return
            }

            chatState = .error(errorMsg)
            let msg = ChatMessage(
                role: .error,
                content: "Agent error: \(errorMsg)",
                sessionKey: payload.sessionKey
            )
            messages.append(msg)

        case .aborted:
            streamingText = ""
            chatState = .idle
        }
    }

    /// Reset the auto-reauth latch once the host knows the device-code flow has
    /// resolved. If it succeeded, mark the timestamp so a follow-up Copilot 401
    /// surfaces a diagnostic instead of looping the device-code flow.
    public func authFlowFinished(succeeded: Bool = false) {
        isAutoReauthing = false
        if succeeded {
            lastAuthCompletedAt = Date()
        }
    }

    /// True for the gateway's Copilot 401/403 errors. Matches the exact phrase
    /// from `resolveCopilotApiToken` plus a generic fallback for related cases.
    private func isCopilotAuthError(_ text: String) -> Bool {
        let lowered = text.lowercased()
        if lowered.contains("copilot api access") { return true }
        if lowered.contains("copilot") && (lowered.contains("401") || lowered.contains("403")) {
            return true
        }
        return false
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

    /// Add a system message to the current chat (for auth prompts, status updates, etc.)
    public func addSystemMessage(_ content: String) {
        let msg = ChatMessage(
            role: .system,
            content: content,
            sessionKey: currentSessionKey ?? "system"
        )
        messages.append(msg)
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
