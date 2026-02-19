import SwiftUI

public struct AboutSettingsView: View {
    public init() {}

    public var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "cpu")
                .font(.system(size: 48))
                .foregroundStyle(.blue)

            Text(AppConstants.appName)
                .font(.title)
                .fontWeight(.bold)

            Text("Version \(AppConstants.version)")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            Text("A local-first AI agent framework\nmenu bar companion.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Spacer()

            Text("Built with Swift & SwiftUI")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
