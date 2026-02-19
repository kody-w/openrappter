import SwiftUI

// MARK: - Approval Detail View

/// Full-screen view for reviewing all pending execution approvals.
public struct ApprovalDetailView: View {
    @Bindable var viewModel: ApprovalViewModel

    public init(viewModel: ApprovalViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Pending Approvals")
                    .font(.headline)
                Spacer()
                Text("\(viewModel.pendingApprovals.count) pending")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()

            Divider()

            if viewModel.pendingApprovals.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "checkmark.shield.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.green)
                    Text("No pending approvals")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(viewModel.pendingApprovals) { approval in
                        ApprovalDetailRow(
                            approval: approval,
                            onApprove: { viewModel.approve(approval) },
                            onDeny: { viewModel.deny(approval) }
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
        .onAppear { viewModel.loadPending() }
    }
}

// MARK: - Approval Detail Row

struct ApprovalDetailRow: View {
    let approval: ExecutionApproval
    let onApprove: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "terminal.fill")
                    .foregroundStyle(.orange)
                Text(approval.command)
                    .font(.callout)
                    .fontWeight(.medium)
                    .lineLimit(2)
                Spacer()
                Text(approval.timestamp, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }

            if let description = approval.description {
                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 4) {
                if let requestedBy = approval.requestedBy {
                    Text("From: \(requestedBy)")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                if let sessionKey = approval.sessionKey {
                    Text("Session: \(String(sessionKey.prefix(8)))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            HStack(spacing: 8) {
                Button(action: onApprove) {
                    Label("Approve", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.green)

                Button(action: onDeny) {
                    Label("Deny", systemImage: "xmark.circle.fill")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .tint(.red)
            }
        }
        .padding(.vertical, 4)
    }
}
