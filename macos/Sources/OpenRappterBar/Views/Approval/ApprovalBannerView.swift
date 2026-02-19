import SwiftUI

// MARK: - Approval Banner View

/// A compact banner shown in the chat panel when there are pending execution approvals.
public struct ApprovalBannerView: View {
    let approvals: [ExecutionApproval]
    let onApprove: (ExecutionApproval) -> Void
    let onDeny: (ExecutionApproval) -> Void
    let onViewAll: () -> Void

    public init(
        approvals: [ExecutionApproval],
        onApprove: @escaping (ExecutionApproval) -> Void,
        onDeny: @escaping (ExecutionApproval) -> Void,
        onViewAll: @escaping () -> Void
    ) {
        self.approvals = approvals
        self.onApprove = onApprove
        self.onDeny = onDeny
        self.onViewAll = onViewAll
    }

    public var body: some View {
        if let first = approvals.first {
            VStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.shield.fill")
                        .foregroundStyle(.orange)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Approval Required")
                            .font(.caption)
                            .fontWeight(.semibold)
                        Text(first.command)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer()

                    if approvals.count > 1 {
                        Button {
                            onViewAll()
                        } label: {
                            Text("\(approvals.count)")
                                .font(.caption2)
                                .fontWeight(.bold)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Color.orange.opacity(0.2), in: Capsule())
                        }
                        .buttonStyle(.borderless)
                    }
                }

                HStack(spacing: 8) {
                    Button {
                        onApprove(first)
                    } label: {
                        Label("Approve", systemImage: "checkmark.circle.fill")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(.green)

                    Button {
                        onDeny(first)
                    } label: {
                        Label("Deny", systemImage: "xmark.circle.fill")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .tint(.red)

                    Spacer()
                }
            }
            .padding(10)
            .background(Color.orange.opacity(0.06))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }
}
