import SwiftUI

// MARK: - Menu Nodes Section

public struct MenuNodesSection: View {
    let nodes: [Node]

    public init(nodes: [Node]) {
        self.nodes = nodes
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Nodes")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)

            if nodes.isEmpty {
                Text("No connected nodes")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 12)
            } else {
                ForEach(nodes) { node in
                    HStack(spacing: 6) {
                        Circle()
                            .fill(nodeStatusColor(node.status))
                            .frame(width: 6, height: 6)

                        Text(node.name)
                            .font(.caption)
                            .lineLimit(1)

                        Spacer()

                        Text(node.platform ?? "")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 2)
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func nodeStatusColor(_ status: NodeStatus) -> Color {
        switch status {
        case .online: return .green
        case .busy: return .orange
        case .offline: return .gray
        case .error: return .red
        }
    }
}
