import SwiftUI

// MARK: - Status Badge

public struct StatusBadge: View {
    let state: ConnectionState

    public init(state: ConnectionState) {
        self.state = state
    }

    public var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var color: Color {
        switch state {
        case .connected: return .green
        case .connecting, .handshaking, .reconnecting: return .orange
        case .disconnected: return .gray
        }
    }

    private var label: String {
        switch state {
        case .connected: return "Connected"
        case .connecting: return "Connecting"
        case .handshaking: return "Handshaking"
        case .reconnecting: return "Reconnecting"
        case .disconnected: return "Disconnected"
        }
    }
}
