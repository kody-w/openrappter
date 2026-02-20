import AppKit
import SwiftUI

// MARK: - Chat Container View

/// Main chat view used in both the floating panel and the full window.
/// In compact (panel) mode, shows a single-column layout.
/// In full (window) mode, shows a sidebar with sessions + main chat area.
public struct ChatContainerView: View {
    @Bindable var viewModel: AppViewModel
    let isCompact: Bool
    var onOpenFullWindow: (() -> Void)?

    public init(viewModel: AppViewModel, isCompact: Bool = true, onOpenFullWindow: (() -> Void)? = nil) {
        self.viewModel = viewModel
        self.isCompact = isCompact
        self.onOpenFullWindow = onOpenFullWindow
    }

    public var body: some View {
        if isCompact {
            compactLayout
        } else {
            fullLayout
        }
    }

    // MARK: - Compact Layout (Panel)

    private var compactLayout: some View {
        VStack(spacing: 0) {
            panelHeader
            Divider()

            ChatMessageList(
                messages: viewModel.chatViewModel.messages,
                streamingText: viewModel.chatViewModel.streamingText,
                isStreaming: {
                    if case .streaming = viewModel.chatViewModel.chatState { return true }
                    return false
                }()
            )
            .frame(minHeight: 200, maxHeight: .infinity)

            Divider()
            chatInput
        }
    }

    // MARK: - Full Layout (Window)

    private var fullLayout: some View {
        NavigationSplitView {
            sessionsSidebar
                .navigationSplitViewColumnWidth(
                    min: 160,
                    ideal: AppConstants.fullWindowSidebarWidth,
                    max: 280
                )
        } detail: {
            VStack(spacing: 0) {
                windowHeader
                Divider()

                ChatMessageList(
                    messages: viewModel.chatViewModel.messages,
                    streamingText: viewModel.chatViewModel.streamingText,
                    isStreaming: {
                        if case .streaming = viewModel.chatViewModel.chatState { return true }
                        return false
                    }()
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                Divider()
                chatInput
            }
        }
    }

    // MARK: - Panel Header

    private var panelHeader: some View {
        HStack(spacing: 8) {
            StatusBadge(state: viewModel.connectionState)

            Spacer()

            if viewModel.connectionState == .disconnected {
                Button("Connect") {
                    viewModel.connectToGateway()
                }
                .controlSize(.mini)
                .buttonStyle(.bordered)
            }

            Button {
                openWebUI()
            } label: {
                Image(systemName: "globe")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .help("Open Web UI")

            if let onOpenFullWindow {
                Button {
                    onOpenFullWindow()
                } label: {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
                .help("Open in window")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - Window Header

    private var windowHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: viewModel.statusIcon)
                .foregroundStyle(viewModel.statusColor)
            Text(currentSessionTitle)
                .font(.headline)
            Spacer()
            StatusBadge(state: viewModel.connectionState)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Chat Input

    private var chatInput: some View {
        ChatInputView(viewModel: viewModel)
            .padding(12)
    }

    // MARK: - Sessions Sidebar

    private var sessionsSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Sessions")
                    .font(.headline)
                Spacer()
                Button {
                    viewModel.chatViewModel.newSession()
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            Divider()

            if viewModel.sessionsViewModel.sessions.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.title3)
                        .foregroundStyle(.tertiary)
                    Text("No sessions")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(viewModel.sessionsViewModel.sessions) { session in
                    SidebarSessionRow(
                        session: session,
                        isActive: session.sessionKey == viewModel.currentSessionKey
                    )
                    .contentShape(Rectangle())
                    .onTapGesture {
                        viewModel.chatViewModel.switchToSession(sessionKey: session.sessionKey)
                    }
                    .contextMenu {
                        Button("Delete", role: .destructive) {
                            viewModel.sessionsViewModel.deleteSession(session)
                        }
                    }
                }
                .listStyle(.sidebar)
            }
        }
    }

    // MARK: - Helpers

    private var currentSessionTitle: String {
        if let key = viewModel.currentSessionKey,
           let session = viewModel.sessionsViewModel.sessions.first(where: { $0.sessionKey == key }) {
            return session.displayTitle
        }
        return "New Chat"
    }

    /// Try the Vite dev server first (port 3000), fall back to gateway's built-in web UI.
    private func openWebUI() {
        Task {
            let candidates = [
                "http://localhost:3000",
                "http://\(AppConstants.defaultHost):\(AppConstants.defaultPort)",
            ]
            for urlString in candidates {
                if let url = URL(string: urlString) {
                    var request = URLRequest(url: url)
                    request.timeoutInterval = 1
                    if let (_, response) = try? await URLSession.shared.data(for: request),
                       let http = response as? HTTPURLResponse, http.statusCode == 200 {
                        NSWorkspace.shared.open(url)
                        return
                    }
                }
            }
            // Last resort: open the gateway URL anyway
            if let url = URL(string: "http://\(AppConstants.defaultHost):\(AppConstants.defaultPort)") {
                NSWorkspace.shared.open(url)
            }
        }
    }
}

// MARK: - Sidebar Session Row

struct SidebarSessionRow: View {
    let session: Session
    let isActive: Bool

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(isActive ? Color.green : Color.clear)
                .frame(width: 6, height: 6)

            VStack(alignment: .leading, spacing: 2) {
                Text(session.displayTitle)
                    .font(.callout)
                    .lineLimit(1)
                Text("\(session.messageCount) messages")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
        .background(isActive ? Color.accentColor.opacity(0.08) : Color.clear)
    }
}
