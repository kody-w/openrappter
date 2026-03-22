import AppKit
import SwiftUI

// MARK: - Chat Container View

/// Main chat view used in both the floating panel and the full window.
/// In compact (panel) mode, shows a single-column layout.
/// In full (window) mode, shows a sidebar with sessions + main chat area.
@MainActor
public struct ChatContainerView: View {
    @Bindable var viewModel: AppViewModel
    @State private var showCronPopover = false
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
            quickActions
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
                    min: 180,
                    ideal: 220,
                    max: 300
                )
        } detail: {
            VStack(spacing: 0) {
                windowHeader
                Divider()
                quickActions
                    .padding(.vertical, 2)
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

                chatInput
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
        }
    }

    // MARK: - Panel Header

    private var panelHeader: some View {
        HStack(spacing: 6) {
            // Dino + status
            HStack(spacing: 6) {
                Text("🦖")
                    .font(.system(size: 16))
                Text(viewModel.connectionState == .connected ? "OpenRappter" : "Connecting...")
                    .font(.system(size: 13, weight: .semibold))
                Circle()
                    .fill(viewModel.statusColor)
                    .frame(width: 6, height: 6)
            }

            Spacer()

            if viewModel.connectionState == .disconnected {
                Button("Connect") {
                    viewModel.connectToGateway()
                }
                .controlSize(.mini)
                .buttonStyle(.bordered)
            }

            // Toolbar buttons
            Group {
                Button { viewModel.chatViewModel.newSession() } label: {
                    Image(systemName: "square.and.pencil")
                }
                .help("New Chat")

                Button { openWebUI() } label: {
                    Image(systemName: "globe")
                }
                .help("Open Dashboard")

                Button { showCronPopover.toggle() } label: {
                    Image(systemName: "clock")
                }
                .help("Cron Jobs")
                .popover(isPresented: $showCronPopover, arrowEdge: .bottom) {
                    CronSettingsView(viewModel: viewModel.cronViewModel)
                        .frame(width: 380, height: 400)
                }

                if let onOpenFullWindow {
                    Button { onOpenFullWindow() } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                    }
                    .help("Open in window")
                }
            }
            .font(.system(size: 12))
            .buttonStyle(.borderless)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - Window Header

    private var windowHeader: some View {
        HStack(spacing: 8) {
            Text("🦖")
                .font(.system(size: 18))

            VStack(alignment: .leading, spacing: 1) {
                Text(currentSessionTitle)
                    .font(.system(size: 14, weight: .semibold))
                HStack(spacing: 4) {
                    Circle()
                        .fill(viewModel.statusColor)
                        .frame(width: 6, height: 6)
                    Text(viewModel.connectionState == .connected ? "Connected" : "Offline")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            Button { viewModel.chatViewModel.newSession() } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help("New Chat")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Chat Input

    private var chatInput: some View {
        ChatInputView(viewModel: viewModel)
            .padding(12)
    }

    // MARK: - Quick Actions

    private var quickActions: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                quickActionPill(icon: "sun.horizon.fill", label: "Brief", color: .orange) {
                    viewModel.chatViewModel.chatInput = "Run my morning briefing — weather, calendar, priorities"; viewModel.chatViewModel.sendMessage()
                }
                quickActionPill(icon: "brain", label: "Memory", color: .green) {
                    viewModel.chatViewModel.chatInput = "List all my memories"; viewModel.chatViewModel.sendMessage()
                }
                quickActionPill(icon: "brain.head.profile", label: "Dream", color: .purple) {
                    viewModel.chatViewModel.chatInput = "Run Dream mode — consolidate and clean up my memory"; viewModel.chatViewModel.sendMessage()
                }
                quickActionPill(icon: "chart.bar.fill", label: "Status", color: .blue) {
                    viewModel.chatViewModel.chatInput = "Show me the current status — what agents are loaded, how many memories, any cron jobs running"; viewModel.chatViewModel.sendMessage()
                }
                quickActionPill(icon: "newspaper.fill", label: "News", color: .red) {
                    viewModel.chatViewModel.chatInput = "Get the top 5 Hacker News stories right now"; viewModel.chatViewModel.sendMessage()
                }
                quickActionPill(icon: "arrow.triangle.2.circlepath", label: "Update", color: .cyan) {
                    viewModel.chatViewModel.chatInput = "Check if there are any updates available for openrappter"; viewModel.chatViewModel.sendMessage()
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
        }
    }

    private func quickActionPill(icon: String, label: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(color)
                Text(label)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.primary.opacity(0.7))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.1))
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Sessions Sidebar

    private var sessionsSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Sidebar header
            HStack {
                Text("Chats")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    viewModel.chatViewModel.newSession()
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("New Chat")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            Divider()

            if viewModel.sessionsViewModel.sessions.isEmpty {
                VStack(spacing: 10) {
                    Text("🦖")
                        .font(.system(size: 28))
                    Text("No chats yet")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(viewModel.sessionsViewModel.sessions) { session in
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
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 4)
                }
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

    /// Open the openrappter web UI (gateway's built-in dashboard).
    private func openWebUI() {
        if let url = URL(string: "http://\(AppConstants.defaultHost):\(AppConstants.defaultPort)") {
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - Sidebar Session Row

struct SidebarSessionRow: View {
    let session: Session
    let isActive: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "bubble.left.fill")
                .font(.system(size: 10))
                .foregroundStyle(isActive ? Color.accentColor : Color.secondary.opacity(0.5))

            VStack(alignment: .leading, spacing: 2) {
                Text(sessionDisplayName)
                    .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                    .lineLimit(1)

                HStack(spacing: 4) {
                    Text("\(session.messageCount) msgs")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                    Text("·")
                        .font(.system(size: 10))
                        .foregroundStyle(.quaternary)
                    Text(session.updatedAt, style: .relative)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isActive ? Color.accentColor.opacity(0.12) : Color.clear)
        )
    }

    private var sessionDisplayName: String {
        if let title = session.title, !title.isEmpty {
            return title
        }
        // Generate a friendlier name from the session key
        let key = session.sessionKey
        if key.hasPrefix("interactive_") || key.hasPrefix("session_") || key.hasPrefix("cron_") {
            let prefix = key.hasPrefix("cron_") ? "Cron" : "Chat"
            let dateStr = session.createdAt.formatted(date: .abbreviated, time: .shortened)
            return "\(prefix) · \(dateStr)"
        }
        if key.hasPrefix("web-") {
            return "Web · \(session.createdAt.formatted(date: .abbreviated, time: .shortened))"
        }
        return "Chat · \(session.createdAt.formatted(date: .abbreviated, time: .shortened))"
    }
}
