import AppKit
import SwiftUI

// MARK: - Floating Panel

/// A borderless floating panel that behaves like a menu bar popup.
/// Becomes key for keyboard input, dismisses on click-away or Escape.
final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        orderOut(nil)
        // Notify the window manager to clean up
        NotificationCenter.default.post(name: .panelDidClose, object: self)
    }
}

extension Notification.Name {
    static let panelDidClose = Notification.Name("com.openrappter.bar.panelDidClose")
}

// MARK: - Chat Window Manager

/// Manages the floating chat panel and the full chat window.
/// The panel anchors below the status item; the full window is a regular resizable window.
@MainActor
public final class ChatWindowManager {
    private var chatPanel: FloatingPanel?
    private var fullWindow: NSWindow?
    private var globalClickMonitor: Any?
    private var panelCloseObserver: Any?

    private let viewModel: AppViewModel
    private let settingsViewModel: SettingsViewModel
    private let onboardingViewModel = OnboardingViewModel()

    public init(viewModel: AppViewModel, settingsViewModel: SettingsViewModel) {
        self.viewModel = viewModel
        self.settingsViewModel = settingsViewModel
    }

    /// Re-auth handler: starts device code flow, shows code in chat, restarts gateway
    private func handleReauth() {
        let auth = settingsViewModel.accountViewModel.authService

        // Post the code into the chat so the user can see it
        auth.login()

        // Watch for the code to appear and post it into chat
        Task {
            // Wait for device code to be populated
            for _ in 0..<30 {
                try? await Task.sleep(for: .seconds(0.5))
                if !auth.userCode.isEmpty { break }
            }

            if !auth.userCode.isEmpty {
                viewModel.chatViewModel.addSystemMessage(
                    "🔑 Go to \(auth.verificationURL) and enter code: **\(auth.userCode)**"
                )
            }

            // Wait for auth to complete
            while auth.authState == .authenticating {
                try? await Task.sleep(for: .seconds(1))
            }

            if auth.authState == .authenticated {
                viewModel.chatViewModel.addSystemMessage("✅ Authenticated! Restarting gateway…")
                settingsViewModel.accountViewModel.restartGatewayAfterAuth()
            } else if let error = auth.error {
                viewModel.chatViewModel.addSystemMessage("❌ Auth failed: \(error)")
            }
        }
    }

    /// Call this before releasing the window manager to clean up monitors.
    public func tearDown() {
        removeGlobalMonitor()
        if let observer = panelCloseObserver {
            NotificationCenter.default.removeObserver(observer)
            panelCloseObserver = nil
        }
    }

    // MARK: - Panel

    /// Toggle the floating chat panel, positioning it below the given status bar button.
    public func togglePanel(relativeTo button: NSStatusBarButton?) {
        if let panel = chatPanel, panel.isVisible {
            hidePanel()
        } else {
            showPanel(relativeTo: button)
        }
    }

    public func showPanel(relativeTo button: NSStatusBarButton?) {
        let panel = getOrCreatePanel()
        positionPanel(panel, relativeTo: button)
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        installGlobalMonitor()
    }

    public func hidePanel() {
        chatPanel?.orderOut(nil)
        removeGlobalMonitor()
    }

    public var isPanelVisible: Bool {
        chatPanel?.isVisible ?? false
    }

    // MARK: - Full Window

    /// Open a full-sized chat window with session sidebar.
    public func openFullWindow() {
        hidePanel()

        let window = getOrCreateFullWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - Private — Panel Creation

    private func getOrCreatePanel() -> FloatingPanel {
        if let existing = chatPanel { return existing }

        let panel = FloatingPanel(
            contentRect: NSRect(
                x: 0, y: 0,
                width: AppConstants.panelWidth,
                height: AppConstants.panelMinHeight
            ),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .utilityWindow
        panel.backgroundColor = .windowBackgroundColor

        // Minimum size
        panel.minSize = NSSize(width: 320, height: 360)
        panel.maxSize = NSSize(width: 600, height: AppConstants.panelMaxHeight)

        // SwiftUI content — show onboarding wizard if not set up
        let contentView: AnyView
        if onboardingViewModel.needsOnboarding && !onboardingViewModel.isComplete {
            contentView = AnyView(
                OnboardingView(viewModel: onboardingViewModel) { [weak self] in
                    // Onboarding complete — swap to chat
                    guard let self, let panel = self.chatPanel else { return }
                    let chatView = ChatContainerView(
                        viewModel: self.viewModel,
                        isCompact: true,
                        onOpenFullWindow: { [weak self] in self?.openFullWindow() },
                        onReauth: { [weak self] in self?.handleReauth() }
                    )
                    panel.contentView = NSHostingView(rootView: chatView)
                    // Reconnect to gateway since daemon was just started
                    self.viewModel.connectToGateway(
                        host: self.settingsViewModel.settingsStore.host,
                        port: self.settingsViewModel.settingsStore.port
                    )
                }
            )
        } else {
            contentView = AnyView(
                ChatContainerView(
                    viewModel: viewModel,
                    isCompact: true,
                    onOpenFullWindow: { [weak self] in
                        self?.openFullWindow()
                    },
                    onReauth: { [weak self] in
                        self?.handleReauth()
                    }
                )
            )
        }
        panel.contentView = NSHostingView(rootView: contentView)

        // Observe panel close via Escape
        panelCloseObserver = NotificationCenter.default.addObserver(
            forName: .panelDidClose, object: panel, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.removeGlobalMonitor()
            }
        }

        chatPanel = panel
        return panel
    }

    // MARK: - Private — Full Window Creation

    private func getOrCreateFullWindow() -> NSWindow {
        if let existing = fullWindow, existing.isVisible { return existing }

        let window = NSWindow(
            contentRect: NSRect(
                x: 0, y: 0,
                width: AppConstants.fullWindowWidth,
                height: AppConstants.fullWindowHeight
            ),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: true
        )

        window.title = "\(AppConstants.appName) Chat"
        window.center()
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 480, height: 360)

        let contentView = ChatContainerView(
            viewModel: viewModel,
            isCompact: false,
            onReauth: { [weak self] in self?.handleReauth() }
        )
        window.contentView = NSHostingView(rootView: contentView)

        fullWindow = window
        return window
    }

    // MARK: - Private — Positioning

    private func positionPanel(_ panel: NSPanel, relativeTo button: NSStatusBarButton?) {
        guard let button = button,
              let buttonWindow = button.window else {
            panel.center()
            return
        }

        let buttonRect = button.convert(button.bounds, to: nil)
        let screenRect = buttonWindow.convertToScreen(buttonRect)

        let panelWidth = panel.frame.width
        let panelHeight = panel.frame.height

        // Center horizontally below the status item, with a small gap
        let x = screenRect.midX - panelWidth / 2
        let y = screenRect.minY - panelHeight - 4

        // Ensure panel stays on screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let clampedX = max(screenFrame.minX + 8, min(x, screenFrame.maxX - panelWidth - 8))
            let clampedY = max(screenFrame.minY + 8, y)
            panel.setFrameOrigin(NSPoint(x: clampedX, y: clampedY))
        } else {
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
    }

    // MARK: - Private — Click-Away Dismiss

    private func installGlobalMonitor() {
        removeGlobalMonitor()
        globalClickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                self.hidePanel()
            }
        }
    }

    private func removeGlobalMonitor() {
        if let monitor = globalClickMonitor {
            NSEvent.removeMonitor(monitor)
            globalClickMonitor = nil
        }
    }
}
