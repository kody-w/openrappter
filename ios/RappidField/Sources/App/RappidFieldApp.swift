import SwiftUI

@main
struct RappidFieldApp: App {
    @State private var model: AppModel
    @State private var player: WakeCallPlayer
    @State private var haptics = FieldHaptics()
    @State private var navigator: FieldNavigator
    @State private var engine: GameEngine
    @State private var autopilot = AutopilotSession()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let model = AppModel()
        let player = WakeCallPlayer()
        let navigator = FieldNavigator()
        _model = State(initialValue: model)
        _player = State(initialValue: player)
        _navigator = State(initialValue: navigator)
        _engine = State(initialValue: GameEngine(model: model, navigator: navigator, player: player))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(player)
                .environment(haptics)
                .environment(navigator)
                .environment(engine)
                .environment(autopilot)
                .preferredColorScheme(.dark)
                .tint(FieldTheme.mint)
                .task {
                    autopilot.start(model: model, navigator: navigator, player: player, engine: engine)
                }
                .onChange(of: scenePhase) { _, phase in
                    // Foreground only: the mailbox is never polled in the
                    // background, and a backgrounded app accepts nothing.
                    if phase == .active {
                        autopilot.resume()
                    } else {
                        autopilot.suspend()
                    }
                }
        }
    }
}
