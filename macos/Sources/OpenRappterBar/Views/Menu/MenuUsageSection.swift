import SwiftUI

// MARK: - Menu Usage Section

public struct MenuUsageSection: View {
    let usage: UsageStats

    public init(usage: UsageStats) {
        self.usage = usage
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Usage")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)

            HStack(spacing: 16) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Tokens")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(usage.formattedTokens)
                        .font(.caption)
                        .fontWeight(.medium)
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text("Cost")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(usage.formattedCost)
                        .font(.caption)
                        .fontWeight(.medium)
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text("Requests")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text("\(usage.requestCount)")
                        .font(.caption)
                        .fontWeight(.medium)
                }
            }
            .padding(.horizontal, 12)
        }
        .padding(.vertical, 4)
    }
}
