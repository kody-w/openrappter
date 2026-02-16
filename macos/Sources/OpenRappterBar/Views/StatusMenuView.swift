import SwiftUI

public struct StatusMenuView: View {
    @Bindable var viewModel: AppViewModel

    public init(viewModel: AppViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(spacing: 0) {
            // Status header
            statusHeader
            Divider()

            // Chat input
            ChatInputView(viewModel: viewModel)
                .padding(12)
            Divider()

            // Activity list
            ActivityListView(viewModel: viewModel)
                .frame(minHeight: 120, maxHeight: 200)
            Divider()

            // Footer buttons
            footerButtons
        }
        .frame(width: 320)
    }

    private var statusHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: viewModel.statusIcon)
                .foregroundStyle(viewModel.statusColor)
                .font(.title3)

            VStack(alignment: .leading, spacing: 2) {
                Text("OpenRappter")
                    .font(.headline)
                Text(viewModel.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if viewModel.connectionState == .disconnected {
                Button("Connect") {
                    viewModel.connectToGateway()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(12)
    }

    private var footerButtons: some View {
        HStack {
            if viewModel.processState == .stopped {
                Button {
                    viewModel.startGateway()
                } label: {
                    Label("Start Gateway", systemImage: "play.fill")
                }
                .controlSize(.small)
            } else if viewModel.processState == .running {
                Button {
                    viewModel.stopGateway()
                } label: {
                    Label("Stop Gateway", systemImage: "stop.fill")
                }
                .controlSize(.small)
            } else {
                ProgressView()
                    .controlSize(.small)
                Text(viewModel.processState == .starting ? "Starting..." : "Stopping...")
                    .font(.caption)
            }

            Spacer()

            Button("Quit") {
                NSApplication.shared.terminate(nil)
            }
            .controlSize(.small)
        }
        .padding(12)
    }
}
