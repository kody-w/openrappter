import SwiftUI

// MARK: - Channels Settings View

public struct ChannelsSettingsView: View {
    @Bindable var viewModel: ChannelsViewModel

    public init(viewModel: ChannelsViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Channels")
                    .font(.headline)
                Spacer()
                Button {
                    viewModel.loadChannels()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
            }
            .padding()

            Divider()

            if viewModel.isLoading {
                ProgressView("Loading channels...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.channels.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.largeTitle)
                        .foregroundStyle(.tertiary)
                    Text("No channels configured")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text("Configure channels in the gateway config YAML.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(viewModel.channels) { channel in
                        ChannelRow(
                            channel: channel,
                            onToggle: {
                                if channel.enabled {
                                    viewModel.disableChannel(channel)
                                } else {
                                    viewModel.enableChannel(channel)
                                }
                            },
                            onTest: { viewModel.testChannel(channel) },
                            onDelete: { viewModel.deleteChannel(channel) }
                        )
                    }
                }
                .listStyle(.inset(alternatesRowBackgrounds: true))
            }

            if let error = viewModel.error {
                ErrorBanner(message: error) {
                    viewModel.error = nil
                }
            }
        }
        .onAppear { viewModel.loadChannels() }
    }
}

// MARK: - Channel Row

struct ChannelRow: View {
    let channel: Channel
    let onToggle: () -> Void
    let onTest: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            // Status indicator
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            // Channel info
            VStack(alignment: .leading, spacing: 2) {
                Text(channel.name)
                    .font(.callout)
                    .fontWeight(.medium)
                HStack(spacing: 4) {
                    Text(channel.type.rawValue)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(channel.status.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()

            // Actions
            Button(action: onTest) {
                Image(systemName: "bolt.fill")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .help("Test channel")

            Toggle("", isOn: .constant(channel.enabled))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .onTapGesture { onToggle() }

            Button(action: onDelete) {
                Image(systemName: "trash")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    private var statusColor: Color {
        switch channel.status {
        case .connected: return .green
        case .connecting: return .orange
        case .disconnected: return .gray
        case .error: return .red
        }
    }
}
