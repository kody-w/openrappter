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
                viewModel.chatViewModel.newSession()
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .help("New Chat")

            Button {
                openWebUI()
            } label: {
                Image(systemName: "globe")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .help("Open Web UI")

            Button {
                showCronPopover.toggle()
            } label: {
                Image(systemName: "clock.arrow.2.circlepath")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .help("Cron Jobs & Logs")
            .popover(isPresented: $showCronPopover, arrowEdge: .bottom) {
                CronSettingsView(viewModel: viewModel.cronViewModel)
                    .frame(width: 380, height: 400)
            }

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

    // MARK: - Quick Actions

    private var quickActions: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                quickActionButton(icon: "brain.head.profile", label: "Dream", color: .purple) {
                    viewModel.chatViewModel.chatInput = "Run Dream mode — consolidate and clean up my memory"; viewModel.chatViewModel.sendMessage()
                }
                quickActionButton(icon: "sun.horizon.fill", label: "Brief", color: .orange) {
                    viewModel.chatViewModel.chatInput = "Run my morning briefing — weather, calendar, priorities"; viewModel.chatViewModel.sendMessage()
                }
                quickActionButton(icon: "list.bullet.clipboard", label: "Status", color: .blue) {
                    viewModel.chatViewModel.chatInput = "Show me the current status — what agents are loaded, how many memories, any cron jobs running"; viewModel.chatViewModel.sendMessage()
                }
                quickActionButton(icon: "brain", label: "Memory", color: .green) {
                    viewModel.chatViewModel.chatInput = "List all my memories"; viewModel.chatViewModel.sendMessage()
                }
                quickActionButton(icon: "arrow.triangle.2.circlepath", label: "Update", color: .cyan) {
                    viewModel.chatViewModel.chatInput = "Check if there are any updates available for openrappter"; viewModel.chatViewModel.sendMessage()
                }
                quickActionButton(icon: "newspaper", label: "HN", color: .red) {
                    viewModel.chatViewModel.chatInput = "Get the top 5 Hacker News stories right now"; viewModel.chatViewModel.sendMessage()
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    private func quickActionButton(icon: String, label: String, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.system(size: 14))
                    .foregroundStyle(color)
                Text(label)
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .frame(width: 48, height: 40)
            .background(.regularMaterial)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary, lineWidth: 0.5))
        }
        .buttonStyle(.plain)
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
