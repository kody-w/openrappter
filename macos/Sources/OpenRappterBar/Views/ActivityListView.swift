import SwiftUI

@MainActor
public struct ActivityListView: View {
    @Bindable var viewModel: AppViewModel

    public var body: some View {
        if viewModel.activities.isEmpty {
            VStack(spacing: 8) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.title2)
                    .foregroundStyle(.tertiary)
                Text("No activity yet")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(viewModel.activities) { item in
                        ActivityRow(item: item)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
    }
}

struct ActivityRow: View {
    let item: ActivityItem

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: item.icon)
                .font(.caption2)
                .foregroundStyle(item.color)
                .frame(width: 14)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.text)
                    .font(.caption)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Text(item.timestamp, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }
}
