import SwiftUI

public struct DebugSettingsView: View {
    public init() {}

    public var body: some View {
        Form {
            Section("Diagnostics") {
                LabeledContent("App Version", value: AppConstants.version)
                LabeledContent("Bundle ID", value: AppConstants.bundleId)
                LabeledContent("Platform", value: AppConstants.platform)
            }

            Section("Logging") {
                Text("Logs are written using os.Logger and visible in Console.app.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("Filter by subsystem: \(AppConstants.bundleId)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }

            Section("Cache") {
                let cachePath = NSHomeDirectory() + "/.openrappter/bar-sessions.json"
                LabeledContent("Sessions Cache") {
                    Text(cachePath)
                        .font(.caption)
                        .textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
    }
}
