import SwiftUI

@MainActor
public struct GeneralSettingsView: View {
    @Bindable var settingsStore: SettingsStore
    @State private var startAtLogin: Bool = false
    @State private var loginToggleError: String?

    private let launchAgent = LaunchAgentManager()

    public init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
    }

    public var body: some View {
        Form {
            Section("Connection") {
                TextField("Host", text: $settingsStore.host)
                    .textFieldStyle(.roundedBorder)
                TextField("Port", value: $settingsStore.port, format: .number)
                    .textFieldStyle(.roundedBorder)
                Toggle("Auto-connect on launch", isOn: $settingsStore.autoConnect)
                Toggle("Auto-start gateway", isOn: $settingsStore.autoStartGateway)
            }

            Section("Gateway") {
                Toggle("Start gateway at login", isOn: $startAtLogin)
                    .onChange(of: startAtLogin) { _, newValue in
                        toggleLaunchAgent(enabled: newValue)
                    }

                if let error = loginToggleError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            Section("Appearance") {
                Toggle("Show in Dock", isOn: $settingsStore.showInDock)
                Toggle("Compact mode", isOn: $settingsStore.compactMode)
            }
        }
        .formStyle(.grouped)
        .padding()
        .onAppear {
            startAtLogin = launchAgent.isInstalled
        }
    }

    private func toggleLaunchAgent(enabled: Bool) {
        loginToggleError = nil
        Task {
            do {
                // Resolve paths for the plist
                let pm = ProcessManager(port: settingsStore.port)
                let nodePath = "/opt/homebrew/bin/node"  // Use common default
                let projectPath = pm.projectPath

                try await launchAgent.setEnabled(
                    enabled,
                    nodePath: nodePath,
                    projectPath: projectPath,
                    port: settingsStore.port
                )
            } catch {
                loginToggleError = error.localizedDescription
                startAtLogin = !enabled  // Revert toggle
            }
        }
    }
}
