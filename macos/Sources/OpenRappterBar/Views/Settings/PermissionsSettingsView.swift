import SwiftUI

// MARK: - Permissions Settings View

public struct PermissionsSettingsView: View {
    @Bindable var approvalViewModel: ApprovalViewModel

    public init(approvalViewModel: ApprovalViewModel) {
        self.approvalViewModel = approvalViewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Execution Permissions")
                    .font(.headline)
                Spacer()
                if approvalViewModel.hasPending {
                    Text("\(approvalViewModel.badgeCount) pending")
                        .font(.caption)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(Color.orange.opacity(0.2), in: Capsule())
                }
            }
            .padding()

            Divider()

            ApprovalDetailView(viewModel: approvalViewModel)

            Divider()

            VStack(alignment: .leading, spacing: 8) {
                Text("Approval Policy")
                    .font(.subheadline)
                    .fontWeight(.medium)
                Text("Commands that require approval are configured in the gateway config YAML under the `permissions` section.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}
