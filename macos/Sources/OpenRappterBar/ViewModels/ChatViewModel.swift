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

    /// Which brain answers the next turn, restored from the last launch.
    ///
    /// Persisted because the two brains know different things and their replies
    /// are the same shape: silently reverting to the local runtime on relaunch
    /// is how someone ends up believing the brainstem said something it never
    /// said.
    public var chatTarget: ChatTarget = .restored() {
        didSet { chatTarget.remember() }
    }

    // Services
    private var rpcClient: RpcClient?
    private var sessionStore: SessionStore?
    private var viewGeneration: UInt = 0
    private var turnGeneration: UInt = 0
    private var messageRevision: UInt = 0
    private var activeRunId: String?
    private var awaitingAcceptance = false
    private var earlyEvents: [ChatEventPayload] = []
    private var finishedRuns: Set<RunKey> = []
    private var finishedRunOrder: [RunKey] = []
    private var cachedRuns: Set<RunKey> = []
    private var cachedRunOrder: [RunKey] = []
    private var partialReplies: [RunKey: String] = [:]
    private var cacheTask: Task<Void, Never>?

    private struct RunKey: Hashable {
        let session: String
        let run: String
    }

    public var onSessionsChanged: (() -> Void)?
    public var onEventApplied: ((ChatEventPayload) -> Void)?

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
        switch chatState {
        case .sending, .streaming: return false
        case .idle, .error:
            return !chatInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
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
        invalidateView()
        partialReplies.removeAll()
        if case .sending = chatState {
            chatState = .error("Connection lost while sending. Reconnect to check the conversation before retrying.")
        } else if case .streaming = chatState {
            chatState = .error("Connection lost. Reconnect to recover the response.")
        }
    }

    var isRpcClientConfigured: Bool {
        rpcClient != nil
    }

    // MARK: - Actions

    @discardableResult
    public func sendMessage() -> Task<Void, Never> {
        let text = chatInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, let rpc = rpcClient else { return Task {} }
        if let activeRunId, let currentSessionKey {
            finishRun(session: currentSessionKey, run: activeRunId)
        }
        let sessionKey = currentSessionKey.flatMap { $0.isEmpty ? nil : $0 }
            ?? "session_\(UUID().uuidString)"
        if currentSessionKey != sessionKey { viewGeneration &+= 1 }
        invalidateTurn()
        let generation = turnGeneration
        let target = chatTarget
        let store = sessionStore
        currentSessionKey = sessionKey
        awaitingAcceptance = true

        chatInput = ""
        chatState = .sending
        streamingText = ""

        let userMsg = ChatMessage(
            role: .user,
            content: text,
            sessionKey: sessionKey
        )
        messages.append(userMsg)
        messageRevision &+= 1
        let saved = cacheMessage(userMsg, store: store)

        return Task {
            await saved.value

            do {
                let accepted = try await rpc.sendChat(
                    message: text,
                    sessionKey: sessionKey,
                    target: target
                )
                guard accepted.sessionKey == sessionKey else {
                    throw RpcClientError.decodingFailed("Gateway accepted a different conversation")
                }
                guard isCurrentTurn(generation, session: sessionKey) else { return }
                activeRunId = accepted.runId
                awaitingAcceptance = false
                chatState = .streaming
                let queued = earlyEvents
                earlyEvents.removeAll()
                for event in queued where event.runId == accepted.runId {
                    applyChatEvent(event)
                }
            } catch {
                let errMsg = ChatMessage(
                    role: .error,
                    content: "Send failed: \(error.localizedDescription)",
                    sessionKey: sessionKey
                )
                await cacheMessage(errMsg, store: store).value
                guard isCurrentTurn(generation, session: sessionKey) else { return }
                awaitingAcceptance = false
                earlyEvents.removeAll()
                chatState = .error(error.localizedDescription)
                messages.append(errMsg)
                messageRevision &+= 1
            }
        }
    }

    @discardableResult
    public func abortChat() -> Task<Void, Never> {
        guard let sessionKey = currentSessionKey, let rpc = rpcClient else { return Task {} }
        let generation = turnGeneration
        let runId = activeRunId
        return Task {
            do {
                try await rpc.abortChat(sessionKey: sessionKey, runId: runId)
                guard isCurrentTurn(generation, session: sessionKey),
                      activeRunId == nil || activeRunId == runId else { return }
                if let runId { finishRun(session: sessionKey, run: runId) }
                activeRunId = nil
                chatState = .idle
                streamingText = ""
            } catch {
                guard isCurrentTurn(generation, session: sessionKey),
                      activeRunId == nil || activeRunId == runId else { return }
                if let runId, finishedRuns.contains(RunKey(session: sessionKey, run: runId)) { return }
                chatState = .error("Could not stop the response: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - Event Handling

    public func handleChatEvent(_ payload: ChatEventPayload) {
        let key = RunKey(session: payload.sessionKey, run: payload.runId)
        guard !cachedRuns.contains(key) else { return }
        var event = payload
        if payload.state == .delta, let text = payload.messageText {
            if partialReplies.count >= 128, partialReplies[key] == nil,
               let oldest = partialReplies.keys.first {
                partialReplies.removeValue(forKey: oldest)
            }
            partialReplies[key] = text
        } else if payload.state != .delta {
            let text = payload.messageText ?? partialReplies[key]
            finishCachedRun(key)
            if payload.state == .final_, let text, !text.isEmpty {
                cacheMessage(ChatMessage(
                    id: "reply:\(payload.sessionKey):\(payload.runId)", role: .assistant,
                    content: text, sessionKey: payload.sessionKey
                ), store: sessionStore)
                event = ChatEventPayload(
                    runId: payload.runId, sessionKey: payload.sessionKey,
                    state: payload.state, messageText: text, errorMessage: payload.errorMessage
                )
            }
        }
        guard payload.sessionKey == currentSessionKey,
              !finishedRuns.contains(RunKey(session: payload.sessionKey, run: payload.runId)) else { return }
        if awaitingAcceptance {
            // The event callback can reach MainActor before the RPC continuation.
            if earlyEvents.count == 128 { earlyEvents.removeFirst() }
            earlyEvents.append(event)
            return
        }
        applyChatEvent(event)
    }

    private func applyChatEvent(_ payload: ChatEventPayload) {
        guard payload.sessionKey == currentSessionKey,
              !finishedRuns.contains(RunKey(session: payload.sessionKey, run: payload.runId)) else { return }
        guard activeRunId == nil || activeRunId == payload.runId else { return }
        activeRunId = payload.runId
        if payload.state != .delta {
            finishRun(session: payload.sessionKey, run: payload.runId)
            activeRunId = nil
        }
        messageRevision &+= 1
        defer { onEventApplied?(payload) }
        switch payload.state {
        case .delta:
            streamingText = payload.messageText ?? streamingText
            chatState = .streaming

        case .final_:
            let finalText = payload.messageText ?? streamingText
            if !finalText.isEmpty {
                let msg = ChatMessage(
                    id: "reply:\(payload.sessionKey):\(payload.runId)",
                    role: .assistant,
                    content: finalText,
                    sessionKey: payload.sessionKey
                )
                if !messages.contains(where: { $0.id == msg.id }) { messages.append(msg) }
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

    @discardableResult
    public func switchToSession(sessionKey: String) -> Task<Void, Never> {
        invalidateView()
        let generation = viewGeneration
        currentSessionKey = sessionKey
        messages = []
        streamingText = ""
        chatState = .idle
        let store = sessionStore
        let rpc = rpcClient
        let revision = messageRevision

        return Task {
            await flushPendingMessages()
            let cached = await store?.getMessages(sessionKey: sessionKey) ?? []
            guard isCurrentView(generation, session: sessionKey) else { return }
            let liveIds = Set(messages.map(\.id))
            messages = cached.filter { !liveIds.contains($0.id) } + messages

            if let rpc {
                do {
                    let gatewayMessages = try await rpc.getSessionMessages(sessionKey: sessionKey)
                    guard isCurrentView(generation, session: sessionKey),
                          revision == messageRevision else { return }
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
        if let activeRunId, let currentSessionKey {
            finishRun(session: currentSessionKey, run: activeRunId)
        }
        invalidateView()
        messages = []
        streamingText = ""
        chatState = .idle
        if let sessionKey = currentSessionKey {
            let store = sessionStore
            let previous = cacheTask
            cacheTask = Task {
                await previous?.value
                await store?.clearMessages(sessionKey: sessionKey)
                onSessionsChanged?()
            }
        }
    }

    public func newSession() {
        invalidateView()
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
        messageRevision &+= 1
    }

    // MARK: - Private

    private func invalidateView() {
        viewGeneration &+= 1
        invalidateTurn()
    }

    private func invalidateTurn() {
        turnGeneration &+= 1
        activeRunId = nil
        awaitingAcceptance = false
        earlyEvents.removeAll()
    }

    private func isCurrentView(_ generation: UInt, session: String) -> Bool {
        generation == viewGeneration && currentSessionKey == session
    }

    private func isCurrentTurn(_ generation: UInt, session: String) -> Bool {
        generation == turnGeneration && currentSessionKey == session
    }

    public func flushPendingMessages() async {
        await cacheTask?.value
    }

    @discardableResult
    private func cacheMessage(_ message: ChatMessage, store: SessionStore?) -> Task<Void, Never> {
        guard let store else { return Task {} }
        let previous = cacheTask
        let task = Task {
            await previous?.value
            await store.addMessage(message)
            onSessionsChanged?()
        }
        cacheTask = task
        return task
    }

    private func finishCachedRun(_ key: RunKey) {
        partialReplies.removeValue(forKey: key)
        guard cachedRuns.insert(key).inserted else { return }
        cachedRunOrder.append(key)
        if cachedRunOrder.count > 256 {
            cachedRuns.remove(cachedRunOrder.removeFirst())
        }
    }

    private func finishRun(session: String, run: String) {
        let key = RunKey(session: session, run: run)
        finishCachedRun(key)
        guard finishedRuns.insert(key).inserted else { return }
        finishedRunOrder.append(key)
        if finishedRunOrder.count > 256 {
            finishedRuns.remove(finishedRunOrder.removeFirst())
        }
    }

    private func parseGatewayMessage(_ data: [String: Any], sessionKey: String) -> ChatMessage? {
        guard let role = data["role"] as? String else { return nil }
        let messageRole = MessageRole(rawValue: role) ?? .assistant

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

        return ChatMessage(
            id: data["id"] as? String ?? UUID().uuidString,
            role: messageRole,
            content: content,
            timestamp: gatewayDate(data["timestamp"]) ?? Date(),
            sessionKey: sessionKey
        )
    }
}
