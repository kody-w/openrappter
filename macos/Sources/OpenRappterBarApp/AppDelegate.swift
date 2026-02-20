import AppKit
import SwiftUI
import OpenRappterBarLib

// MARK: - App Delegate

/// Manages the NSStatusItem (menu bar icon) and the ChatWindowManager.
/// Left-click → floating chat panel. Right-click → context menu.
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var windowManager: ChatWindowManager!

    public let viewModel = AppViewModel()
    public let settingsViewModel = SettingsViewModel()
    private let deepLinkHandler = DeepLinkHandler()

    // MARK: - Lifecycle

    public func applicationDidFinishLaunching(_ notification: Notification) {
        setupStatusItem()
        windowManager = ChatWindowManager(viewModel: viewModel, settingsViewModel: settingsViewModel)
        observeViewModel()

        // Auto-connect if configured
        if settingsViewModel.settingsStore.autoConnect {
            viewModel.connectToGateway(
                host: settingsViewModel.settingsStore.host,
                port: settingsViewModel.settingsStore.port
            )
        }

        // Auto-start gateway if configured
        if settingsViewModel.settingsStore.autoStartGateway {
            viewModel.startGateway()
        }

        // Configure settings ViewModel when RPC becomes available
        viewModel.onRpcClientReady = { [weak self] rpc in
            self?.settingsViewModel.configure(rpcClient: rpc)
        }

        // Configure account auth with gateway restart capability
        settingsViewModel.configureAccount(
            processManager: viewModel.processManager,
            onGatewayRestarted: { [weak self] in
                guard let self else { return }
                self.viewModel.connectToGateway(
                    host: self.settingsViewModel.settingsStore.host,
                    port: self.settingsViewModel.settingsStore.port
                )
            }
        )
    }

    // MARK: - Status Item Setup

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            button.image = NSImage(
                systemSymbolName: statusIconName(for: .disconnected),
                accessibilityDescription: AppConstants.appName
            )
            button.target = self
            button.action = #selector(statusItemClicked(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
    }

    // MARK: - Click Handling

    @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }

        if event.type == .rightMouseUp {
            showContextMenu()
        } else {
            windowManager.togglePanel(relativeTo: statusItem.button)
        }
    }

    // MARK: - Context Menu (Right-Click)

    private func showContextMenu() {
        let menu = NSMenu()

        // Status
        let statusTitle = viewModel.connectionState == .connected ? "Connected" : "Disconnected"
        let statusItem = NSMenuItem(title: statusTitle, action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        menu.addItem(statusItem)
        menu.addItem(NSMenuItem.separator())

        // Connection
        if viewModel.connectionState == .disconnected {
            menu.addItem(NSMenuItem(title: "Connect", action: #selector(menuConnect), keyEquivalent: ""))
        } else if viewModel.connectionState == .connected {
            menu.addItem(NSMenuItem(title: "Disconnect", action: #selector(menuDisconnect), keyEquivalent: ""))
        }

        // Gateway
        if viewModel.processState == .stopped {
            menu.addItem(NSMenuItem(title: "Start Gateway", action: #selector(menuStartGateway), keyEquivalent: ""))
        } else if viewModel.processState == .running {
            menu.addItem(NSMenuItem(title: "Stop Gateway", action: #selector(menuStopGateway), keyEquivalent: ""))
        }

        menu.addItem(NSMenuItem.separator())

        // New Session
        menu.addItem(NSMenuItem(title: "New Session", action: #selector(menuNewSession), keyEquivalent: "n"))

        // Open Full Window
        menu.addItem(NSMenuItem(title: "Open Chat Window", action: #selector(menuOpenFullWindow), keyEquivalent: "o"))

        menu.addItem(NSMenuItem.separator())

        // Settings
        let settingsMenuItem = NSMenuItem(title: "Settings...", action: #selector(menuOpenSettings), keyEquivalent: ",")
        menu.addItem(settingsMenuItem)

        // Quit
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit \(AppConstants.appName)", action: #selector(menuQuit), keyEquivalent: "q"))

        // Set targets
        for item in menu.items where item.action != nil {
            item.target = self
        }

        // Show menu — temporarily assign then remove so left-click still works
        self.statusItem.menu = menu
        self.statusItem.button?.performClick(nil)
        self.statusItem.menu = nil
    }

    // MARK: - Menu Actions

    @objc private func menuConnect() {
        viewModel.connectToGateway(
            host: settingsViewModel.settingsStore.host,
            port: settingsViewModel.settingsStore.port
        )
    }

    @objc private func menuDisconnect() {
        viewModel.disconnectFromGateway()
    }

    @objc private func menuStartGateway() {
        viewModel.startGateway()
    }

    @objc private func menuStopGateway() {
        viewModel.stopGateway()
    }

    @objc private func menuNewSession() {
        viewModel.chatViewModel.newSession()
        windowManager.showPanel(relativeTo: statusItem.button)
    }

    @objc private func menuOpenFullWindow() {
        windowManager.openFullWindow()
    }

    @objc private func menuOpenSettings() {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }

    @objc private func menuQuit() {
        NSApplication.shared.terminate(nil)
    }

    // MARK: - Deep Links

    public func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let link = deepLinkHandler.parse(url: url) else { continue }
            handleDeepLink(link)
        }
    }

    private func handleDeepLink(_ link: DeepLinkHandler.DeepLink) {
        switch link {
        case .chat(let sessionKey):
            if let sessionKey {
                viewModel.chatViewModel.switchToSession(sessionKey: sessionKey)
            }
            windowManager.showPanel(relativeTo: statusItem.button)
        case .settings:
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        case .connect(let host, let port):
            viewModel.connectToGateway(host: host, port: port)
        case .unknown:
            break
        }
    }

    // MARK: - ViewModel Observation

    /// Observes the AppViewModel's state changes and updates the status item icon.
    private func observeViewModel() {
        withObservationTracking {
            _ = viewModel.connectionState
            _ = viewModel.processState
            _ = viewModel.menuBarUptime
        } onChange: { [weak self] in
            Task { @MainActor in
                self?.updateStatusItem()
                self?.observeViewModel()
            }
        }
    }

    private func updateStatusItem() {
        let iconName = statusIconName(for: viewModel.connectionState)
        statusItem.button?.image = NSImage(
            systemSymbolName: iconName,
            accessibilityDescription: AppConstants.appName
        )

        let uptime = viewModel.menuBarUptime
        if uptime.isEmpty {
            statusItem.button?.title = ""
        } else {
            statusItem.button?.title = " \(uptime)"
        }
        statusItem.button?.imagePosition = .imageLeading
    }

    private func statusIconName(for state: ConnectionState) -> String {
        switch state {
        case .connected: return "checkmark.circle.fill"
        case .connecting, .handshaking: return "arrow.triangle.2.circlepath"
        case .reconnecting: return "arrow.clockwise"
        case .disconnected: return "xmark.circle"
        }
    }
}
