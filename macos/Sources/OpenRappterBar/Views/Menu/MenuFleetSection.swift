import SwiftUI

// MARK: - Menu Fleet Section

/// Shows live fleet status, Mars Barn data, and quick actions in the menu dropdown.
public struct MenuFleetSection: View {
    @Bindable var fleetVM: FleetViewModel

    public init(fleetVM: FleetViewModel) {
        self.fleetVM = fleetVM
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Fleet status
            fleetStatusRow
            statsRow

            Divider()
                .padding(.horizontal, 12)

            // Mars Barn
            marsStatusRow
            marsButton

            Divider()
                .padding(.horizontal, 12)

            // Quick actions
            quickActions

            // Redline indicator
            if fleetVM.isRedline {
                redlineIndicator
            }
        }
        .padding(.vertical, 6)
    }

    // MARK: - Fleet

    private var fleetStatusRow: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(fleetVM.fleetOnline ? Color.green : Color.gray)
                .frame(width: 7, height: 7)

            if fleetVM.fleetOnline {
                Text("Fleet: Frame \(fleetVM.currentFrame)")
                    .font(.caption)
                    .fontWeight(.medium)
            } else {
                Text("Fleet: Offline")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Text("Rappterbook")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
    }

    private var statsRow: some View {
        Group {
            if fleetVM.fleetOnline {
                Text("\(formatNumber(fleetVM.totalPosts)) posts | \(formatNumber(fleetVM.totalComments)) comments")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.leading, 13)  // align with text after dot
            }
        }
    }

    // MARK: - Mars Barn

    private var marsStatusRow: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(fleetVM.marsOnline ? Color.red : Color.gray)
                .frame(width: 7, height: 7)

            if fleetVM.marsOnline {
                Text("Mars: Sol \(fleetVM.marsSol) | Pop \(fleetVM.marsPopulation)")
                    .font(.caption)
                    .fontWeight(.medium)
            } else {
                Text("Mars: Offline")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Text("Mars Barn")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
    }

    private var marsButton: some View {
        Button {
            if let url = URL(string: "http://localhost:9091/game.html") {
                NSWorkspace.shared.open(url)
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "gamecontroller.fill")
                    .font(.caption2)
                Text("Open Game")
                    .font(.caption2)
            }
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .padding(.leading, 13)
    }

    // MARK: - Quick Actions

    private var quickActions: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Quick Actions")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)

            Button {
                if let url = URL(string: "https://kody-w.github.io/rappterbook/docs/terrarium.html") {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "leaf.fill")
                        .font(.caption2)
                    Text("Open Terrarium")
                        .font(.caption)
                }
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 12)

            Button {
                // Launch openrappter --web via shell
                Task {
                    let process = Process()
                    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                    process.arguments = ["openrappter", "--web"]
                    process.standardOutput = FileHandle.nullDevice
                    process.standardError = FileHandle.nullDevice
                    try? process.run()
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "globe")
                        .font(.caption2)
                    Text("Open Dashboard")
                        .font(.caption)
                }
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 12)
        }
    }

    // MARK: - Redline

    private var redlineIndicator: some View {
        HStack(spacing: 4) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(.red)
            Text("REDLINE")
                .font(.caption)
                .fontWeight(.bold)
                .foregroundStyle(.red)
            Spacer()
            Text("> 2 frames/hr")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 12)
    }

    // MARK: - Helpers

    private func formatNumber(_ n: Int) -> String {
        if n >= 1000 {
            let k = Double(n) / 1000.0
            return String(format: "%.1fk", k)
        }
        return "\(n)"
    }
}
