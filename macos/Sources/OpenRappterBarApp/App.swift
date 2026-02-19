import SwiftUI
import OpenRappterBarLib

@main
struct OpenRappterBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            SettingsWindow(viewModel: appDelegate.settingsViewModel)
        }
    }
}
