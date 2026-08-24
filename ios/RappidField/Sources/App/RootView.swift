import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(WakeCallPlayer.self) private var player
    @Environment(AutopilotSession.self) private var autopilot

    var body: some View {
        Group {
            if model.onboardingComplete, model.chosenPath != nil {
                MainTabView()
            } else {
                OnboardingView()
            }
        }
        .task {
            await model.bootstrap()
        }
        .onDisappear {
            player.stop()
        }
        .overlay(alignment: .topTrailing) {
            #if DEBUG
            if autopilot.isEnabled {
                AutopilotBadge()
            }
            #endif
        }
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var model
    @Environment(FieldNavigator.self) private var navigator

    var body: some View {
        @Bindable var navigator = navigator
        return TabView(selection: $navigator.selectedTab) {
            FieldGuideView()
                .tabItem { Label("Field Guide", systemImage: "square.stack.3d.up") }
                .tag(FieldTab.fieldGuide)
            GrowthView()
                .tabItem { Label("Growth", systemImage: "arrow.up.forward.circle") }
                .tag(FieldTab.growth)
            CompanionChatView()
                .tabItem { Label("Companion", systemImage: "bubble.left.and.text.bubble.right") }
                .tag(FieldTab.companion)
            PairingView()
                .tabItem { Label("Host", systemImage: "externaldrive.connected.to.line.below") }
                .tag(FieldTab.host)
            PrivacySettingsView()
                .tabItem { Label("Privacy", systemImage: "lock.shield") }
                .tag(FieldTab.privacy)
        }
        .tint(model.chosenPath.map(FieldTheme.accent) ?? FieldTheme.mint)
    }
}
