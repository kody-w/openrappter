import SwiftUI

// MARK: - Account Settings View

public struct AccountSettingsView: View {
    var viewModel: AccountViewModel

    public init(viewModel: AccountViewModel) {
        self.viewModel = viewModel
    }

    private var authService: GitHubAuthService {
        viewModel.authService
    }

    public var body: some View {
        Form {
            Section("GitHub Account") {
                switch authService.authState {
                case .unknown:
                    ProgressView("Checking authentication...")

                case .unauthenticated:
                    unauthenticatedView

                case .authenticating:
                    authenticatingView

                case .authenticated:
                    authenticatedView
                }
            }

            if let error = authService.error {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.yellow)
                        .font(.callout)
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .onAppear {
            if authService.authState == .unknown {
                authService.checkAuthStatus()
            }
        }
        .onChange(of: authService.authState) { oldValue, newValue in
            if oldValue == .authenticating && newValue == .authenticated {
                viewModel.restartGatewayAfterAuth()
            }
        }
    }

    // MARK: - Unauthenticated

    private var unauthenticatedView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sign in to enable GitHub Copilot and other GitHub-powered features.")
                .font(.callout)
                .foregroundStyle(.secondary)

            Button("Sign in with GitHub") {
                authService.login()
            }
        }
    }

    // MARK: - Authenticating

    private var authenticatingView: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Enter this code on GitHub:")
                .font(.callout)
                .foregroundStyle(.secondary)

            Text(authService.userCode)
                .font(.system(size: 28, weight: .bold, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 4)

            if let url = URL(string: authService.verificationURL), !authService.verificationURL.isEmpty {
                Link(destination: url) {
                    Label(authService.verificationURL, systemImage: "safari")
                }
                .font(.callout)
            }

            HStack {
                ProgressView()
                    .controlSize(.small)
                Text("Waiting for authorization...")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Button("Cancel", role: .cancel) {
                authService.cancelLogin()
            }
            .controlSize(.small)
        }
    }

    // MARK: - Authenticated

    private var authenticatedView: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                if let username = authService.username {
                    Text("Signed in as **\(username)**")
                } else {
                    Text("Signed in to GitHub")
                }
            }

            Button("Sign Out", role: .destructive) {
                authService.logout()
            }
            .controlSize(.small)
        }
    }
}
