import SwiftUI

/// Visual onboarding wizard shown in the menu bar panel.
///
/// Guides the user through openrappter's iMessage-first setup — including the
/// system permissions that silently break an iMessage bot — opening the right
/// Settings pane for each and verifying the grant before advancing.
@MainActor
public struct OnboardingView: View {
    @Bindable var viewModel: OnboardingViewModel
    var onComplete: () -> Void

    public init(viewModel: OnboardingViewModel, onComplete: @escaping () -> Void) {
        self.viewModel = viewModel
        self.onComplete = onComplete
    }

    public var body: some View {
        VStack(spacing: 0) {
            progressBar
            Divider()
            ScrollView {
                VStack(spacing: 20) {
                    switch viewModel.currentStep {
                    case .welcome: welcomeStep
                    case .ai: aiStep
                    case .fullDiskAccess: fullDiskAccessStep
                    case .automation: automationStep
                    case .imessage: imessageStep
                    case .starting: startingStep
                    case .done: doneStep
                    }
                }
                .padding(24)
            }
        }
        .frame(width: 380)
    }

    // MARK: - Progress bar

    private var progressBar: some View {
        HStack(spacing: 4) {
            ForEach(OnboardingViewModel.Step.allCases, id: \.rawValue) { step in
                RoundedRectangle(cornerRadius: 2)
                    .fill(step.rawValue <= viewModel.currentStep.rawValue ? Color.green : Color.gray.opacity(0.3))
                    .frame(height: 3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    // MARK: - Welcome

    private var welcomeStep: some View {
        VStack(spacing: 16) {
            Text("🦖").font(.system(size: 56))
            Text("Welcome to openrappter")
                .font(.title2).bold()
            Text("Your personal AI, reachable from iMessage. In a minute you'll be texting it like a friend — this wizard turns on the few macOS permissions that make that work, and checks each one for you.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button(action: { viewModel.advance() }) {
                Text("Get Started").frame(maxWidth: .infinity).padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent).tint(.green)

            Button("I already set this up") {
                viewModel.skipToDone(); onComplete()
            }
            .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
        }
    }

    // MARK: - AI (Copilot, CLI-first)

    private var aiStep: some View {
        VStack(spacing: 16) {
            Image(systemName: "sparkles").font(.system(size: 40)).foregroundStyle(.green)
            Text("Connect the AI").font(.title3).bold()
            Text("openrappter thinks using your existing GitHub Copilot subscription — no extra API keys or bills.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)

            switch viewModel.authState {
            case .idle:
                VStack(spacing: 10) {
                    Text("We couldn't find a Copilot sign-in yet.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button(action: { viewModel.signInCopilotCLI() }) {
                        Label("Sign in with GitHub Copilot", systemImage: "arrow.up.forward.app")
                            .frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent).tint(.green)
                    Button("Re-check") { viewModel.detectAI() }
                        .buttonStyle(.bordered).font(.callout)
                    skipLink
                }
            case .checking:
                spinner("Checking your Copilot connection…")
            case .waitingForCode(let code, _):
                VStack(spacing: 8) {
                    Text("Enter this code on GitHub:").font(.callout).foregroundStyle(.secondary)
                    Text(code).font(.system(.title, design: .monospaced)).bold()
                        .padding(8).background(Color.gray.opacity(0.1)).cornerRadius(8)
                    ProgressView()
                }
            case .success(let detail):
                VStack(spacing: 8) {
                    successBadge("Connected via \(detail)")
                    continueButton
                }
            case .failed(let message):
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle").font(.system(size: 28)).foregroundStyle(.orange)
                    Text(message).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try Again") { viewModel.signInCopilotCLI() }.buttonStyle(.bordered)
                    skipLink
                }
            }
        }
    }

    // MARK: - Full Disk Access

    private var fullDiskAccessStep: some View {
        permissionStep(
            icon: "externaldrive.badge.person.crop",
            title: "Allow Full Disk Access",
            blurb: "This lets openrappter read your Messages so it can see texts sent to it. macOS keeps this locked by default — even for apps you trust.",
            state: viewModel.fdaState,
            howTo: [
                "Click **Open Settings** below.",
                "Find **OpenRappter Bar** in the list and switch it **on** (use the **+** to add it if it isn't listed).",
                "Come back and click **I've enabled it**."
            ],
            openTitle: "Open Full Disk Access",
            open: { viewModel.openFullDiskAccessSettings() },
            verify: { Task { await viewModel.verifyFullDiskAccess() } }
        )
    }

    // MARK: - Automation

    private var automationStep: some View {
        permissionStep(
            icon: "wand.and.stars",
            title: "Allow Messages Automation",
            blurb: "This lets openrappter send replies through Messages. The first check pops up a “control Messages” request — click **OK**.",
            state: viewModel.automationState,
            howTo: [
                "Click **Request access** — approve the macOS pop-up.",
                "If you missed it, click **Open Settings** and enable **Messages** under **OpenRappter Bar**.",
                "Then click **I've enabled it**."
            ],
            openTitle: "Open Automation Settings",
            open: { viewModel.openAutomationSettings() },
            verify: { Task { await viewModel.verifyAutomation(triggerPrompt: true) } },
            primaryActionTitle: "Request access",
            primaryAction: { Task { await viewModel.verifyAutomation(triggerPrompt: true) } }
        )
    }

    // MARK: - iMessage

    private var imessageStep: some View {
        VStack(spacing: 16) {
            Image(systemName: "message.badge.filled.fill").font(.system(size: 40)).foregroundStyle(.green)
            Text("Set up iMessage").font(.title3).bold()

            statusLine(viewModel.imessageState,
                       okText: "Messages is signed in to iMessage",
                       pendingText: "Checking iMessage sign-in…")

            if case .denied(let hint) = viewModel.imessageState {
                VStack(spacing: 8) {
                    Text(hint).font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    HStack {
                        Button("Open Messages") { viewModel.openMessagesApp() }.buttonStyle(.bordered)
                        Button("Re-check") { Task { await viewModel.verifyIMessageSignedIn() } }.buttonStyle(.bordered)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Who can talk to your rappter?").font(.callout).bold()
                Text("Enter your own phone number or email — the address you'll text it from.")
                    .font(.caption).foregroundStyle(.secondary)
                TextField("+1 555 555 5555 or you@icloud.com", text: $viewModel.ownerContact)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
            }
            .padding(12).background(Color.gray.opacity(0.05)).cornerRadius(10)

            // Live end-to-end proof.
            switch viewModel.testMessageState {
            case .granted:
                successBadge("Test message sent — reply to it to chat!")
            case .checking:
                spinner("Sending a test iMessage…")
            case .denied(let hint):
                Text(hint).font(.caption).foregroundStyle(.orange).multilineTextAlignment(.center)
            case .unknown:
                EmptyView()
            }

            Button(action: { viewModel.sendTestMessage() }) {
                Label("Send a test message", systemImage: "paperplane.fill")
                    .frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.ownerContact.trimmingCharacters(in: .whitespaces).isEmpty)

            Button(action: { viewModel.saveIMessageConfig(); viewModel.advance() }) {
                Text("Continue").frame(maxWidth: .infinity).padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent).tint(.green)
            .disabled(viewModel.ownerContact.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    // MARK: - Starting

    private var startingStep: some View {
        VStack(spacing: 20) {
            Text("🦖").font(.system(size: 56))
            Text("Starting your rappter…").font(.title3).bold()
            VStack(alignment: .leading, spacing: 12) {
                statusRow(label: "Starting the agent", done: viewModel.daemonStarted)
                statusRow(label: "Enabling auto-start", done: viewModel.autoStartInstalled)
            }
            .padding().background(Color.gray.opacity(0.05)).cornerRadius(10)
            if let error = viewModel.errorMessage {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            ProgressView()
        }
    }

    // MARK: - Done

    private var doneStep: some View {
        VStack(spacing: 16) {
            Text("🦖").font(.system(size: 48))
            Text("You're all set!").font(.title2).bold()
            VStack(alignment: .leading, spacing: 8) {
                checkRow("AI (Copilot)", ok: viewModel.authState.isSuccess)
                checkRow("Full Disk Access", ok: viewModel.fdaState.isGranted)
                checkRow("Messages Automation", ok: viewModel.automationState.isGranted)
                checkRow("iMessage signed in", ok: viewModel.imessageState.isGranted)
                checkRow("Agent running", ok: viewModel.daemonStarted)
            }
            .padding().background(Color.gray.opacity(0.05)).cornerRadius(10)
            Text("Text your rappter from the number you added and it'll reply. Click the 🦖 in your menu bar anytime.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button(action: { onComplete() }) {
                Text("Done").frame(maxWidth: .infinity).padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent).tint(.green)
        }
    }

    // MARK: - Reusable permission step

    private func permissionStep(icon: String, title: String, blurb: String,
                                state: OnboardingViewModel.PermissionState,
                                howTo: [String], openTitle: String,
                                open: @escaping () -> Void, verify: @escaping () -> Void,
                                primaryActionTitle: String? = nil,
                                primaryAction: (() -> Void)? = nil) -> some View {
        VStack(spacing: 16) {
            Image(systemName: icon).font(.system(size: 40)).foregroundStyle(.green)
            Text(title).font(.title3).bold()
            Text(blurb).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)

            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(howTo.enumerated()), id: \.offset) { _, line in
                    Text(try! AttributedString(markdown: "• " + line))
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(12).background(Color.gray.opacity(0.05)).cornerRadius(10)

            statusLine(state, okText: "Enabled — you're good", pendingText: "Checking…")

            if state.isGranted {
                continueButton
            } else {
                VStack(spacing: 8) {
                    if let title = primaryActionTitle, let action = primaryAction {
                        Button(action: action) {
                            Text(title).frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.borderedProminent).tint(.green)
                    }
                    if primaryActionTitle == nil {
                        Button(action: open) {
                            Label(openTitle, systemImage: "gearshape").frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.borderedProminent).tint(.green)
                    } else {
                        Button(action: open) {
                            Label(openTitle, systemImage: "gearshape").frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.bordered).tint(.green)
                    }
                    Button(action: verify) {
                        Label("I've enabled it — verify", systemImage: "checkmark.shield")
                            .frame(maxWidth: .infinity).padding(.vertical, 6)
                    }
                    .buttonStyle(.bordered)
                    skipLink
                }
            }
        }
    }

    // MARK: - Shared components

    private var continueButton: some View {
        Button(action: { viewModel.advance() }) {
            Text("Continue").frame(maxWidth: .infinity).padding(.vertical, 8)
        }
        .buttonStyle(.borderedProminent).tint(.green)
    }

    private var skipLink: some View {
        Button("Skip for now") { viewModel.advance() }
            .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
    }

    private func statusLine(_ state: OnboardingViewModel.PermissionState,
                            okText: String, pendingText: String) -> some View {
        Group {
            switch state {
            case .granted:
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    Text(okText).font(.callout).bold()
                }
            case .checking:
                HStack(spacing: 6) { ProgressView().controlSize(.small); Text(pendingText).font(.callout).foregroundStyle(.secondary) }
            case .denied(let hint):
                HStack(spacing: 6) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
                    Text(hint).font(.caption).foregroundStyle(.secondary)
                }
            case .unknown:
                EmptyView()
            }
        }
    }

    private func spinner(_ label: String) -> some View {
        VStack(spacing: 8) { ProgressView(); Text(label).font(.callout).foregroundStyle(.secondary) }
    }

    private func successBadge(_ label: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").font(.system(size: 32)).foregroundStyle(.green)
            Text(label).font(.callout).bold().multilineTextAlignment(.center)
        }
    }

    private func statusRow(label: String, done: Bool) -> some View {
        HStack(spacing: 8) {
            if done { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
            else { ProgressView().controlSize(.small) }
            Text(label).font(.callout)
            Spacer()
        }
    }

    private func checkRow(_ label: String, ok: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: ok ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(ok ? .green : .secondary).font(.caption)
            Text(label).font(.callout)
        }
    }
}
