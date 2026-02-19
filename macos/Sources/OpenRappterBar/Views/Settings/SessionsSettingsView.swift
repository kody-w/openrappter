import SwiftUI

public struct SessionsSettingsView: View {
    @Bindable var settingsStore: SettingsStore

    public init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
    }

    public var body: some View {
        Form {
            Section("Session Limits") {
                Stepper(
                    "Max sessions: \(settingsStore.settings.session.maxSessions)",
                    value: $settingsStore.settings.session.maxSessions,
                    in: 5...200,
                    step: 5
                )
            }

            Section("Cleanup") {
                Toggle(
                    "Auto-delete old sessions",
                    isOn: Binding(
                        get: { settingsStore.settings.session.autoDeleteAfterDays != nil },
                        set: { enabled in
                            settingsStore.settings.session.autoDeleteAfterDays = enabled ? 30 : nil
                        }
                    )
                )

                if let days = settingsStore.settings.session.autoDeleteAfterDays {
                    Stepper(
                        "Delete after \(days) days",
                        value: Binding(
                            get: { days },
                            set: { settingsStore.settings.session.autoDeleteAfterDays = $0 }
                        ),
                        in: 1...365,
                        step: 7
                    )
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}
