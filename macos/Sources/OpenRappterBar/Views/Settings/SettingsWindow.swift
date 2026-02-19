import SwiftUI

// MARK: - Settings Window

public struct SettingsWindow: View {
    @Bindable var viewModel: SettingsViewModel

    public init(viewModel: SettingsViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        TabView {
            GeneralSettingsView(settingsStore: viewModel.settingsStore)
                .tabItem {
                    Label("General", systemImage: "gear")
                }

            ChannelsSettingsView(viewModel: viewModel.channelsViewModel)
                .tabItem {
                    Label("Channels", systemImage: "antenna.radiowaves.left.and.right")
                }

            CronSettingsView(viewModel: viewModel.cronViewModel)
                .tabItem {
                    Label("Cron", systemImage: "clock.arrow.2.circlepath")
                }

            SessionsSettingsView(settingsStore: viewModel.settingsStore)
                .tabItem {
                    Label("Sessions", systemImage: "bubble.left.and.text.bubble.right")
                }

            ConfigEditorView(viewModel: viewModel)
                .tabItem {
                    Label("Config", systemImage: "doc.text")
                }

            PermissionsSettingsView(approvalViewModel: viewModel.approvalViewModel)
                .tabItem {
                    Label("Permissions", systemImage: "lock.shield")
                }

            SkillsSettingsView(viewModel: viewModel.skillsViewModel)
                .tabItem {
                    Label("Skills", systemImage: "puzzlepiece.extension")
                }

            DebugSettingsView()
                .tabItem {
                    Label("Debug", systemImage: "ladybug")
                }

            AboutSettingsView()
                .tabItem {
                    Label("About", systemImage: "info.circle")
                }
        }
        .frame(width: 560, height: 420)
    }
}
