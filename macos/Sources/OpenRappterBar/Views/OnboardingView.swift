import SwiftUI

/// Visual onboarding wizard shown in the menu bar panel.
/// Guides non-technical users through setup without touching the terminal.
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
            // Progress bar
            progressBar
            Divider()

            // Step content
            ScrollView {
                VStack(spacing: 20) {
                    switch viewModel.currentStep {
                    case .welcome:
                        welcomeStep
                    case .github:
                        githubStep
                    case .telegram:
                        telegramStep
                    case .starting:
                        startingStep
                    case .done:
                        doneStep
                    }
                }
                .padding(24)
            }
        }
        .frame(width: 360)
    }

    // MARK: - Progress Bar

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
            dinoAnimation
            Text("Welcome to openrappter!")
                .font(.title2).bold()
            Text("I'm your personal AI agent. I run in the background, remember things, automate tasks, and learn over time.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Spacer().frame(height: 8)

            Button(action: { viewModel.advance() }) {
                Text("Get Started")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)

            Button("I already set up via terminal") {
                viewModel.skipToChat()
                onComplete()
            }
            .buttonStyle(.plain)
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - GitHub Auth

    private var githubStep: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.crop.circle.badge.checkmark")
                .font(.system(size: 40))
                .foregroundStyle(.green)

            Text("Connect GitHub Copilot")
                .font(.title3).bold()
            Text("openrappter uses your existing Copilot subscription for AI. No extra API keys needed.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            switch viewModel.authState {
            case .idle:
                VStack(spacing: 10) {
                    Button(action: { viewModel.startGitHubAuth() }) {
                        Label("Log in with GitHub", systemImage: "arrow.up.forward.app")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)

                    Button("Use existing token") {
                        viewModel.quickAuth()
                    }
                    .buttonStyle(.bordered)
                    .font(.callout)
                }

            case .waitingForCode(let code, _):
                VStack(spacing: 8) {
                    Text("Enter this code on GitHub:")
                        .font(.callout).foregroundStyle(.secondary)
                    Text(code)
                        .font(.system(.title, design: .monospaced))
                        .bold()
                        .padding(8)
                        .background(Color.gray.opacity(0.1))
                        .cornerRadius(8)
                    ProgressView()
                        .padding(.top, 4)
                    Text("Waiting for authorization...")
                        .font(.caption).foregroundStyle(.secondary)
                }

            case .validating:
                VStack(spacing: 8) {
                    ProgressView()
                    Text("Checking credentials...")
                        .font(.callout).foregroundStyle(.secondary)
                }

            case .success:
                VStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 32))
                        .foregroundStyle(.green)
                    Text("Connected to GitHub Copilot!")
                        .font(.callout).bold()

                    Button(action: { viewModel.advance() }) {
                        Text("Continue")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }

            case .failed(let message):
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 32))
                        .foregroundStyle(.orange)
                    Text(message)
                        .font(.caption).foregroundStyle(.secondary)

                    Button("Try Again") { viewModel.startGitHubAuth() }
                        .buttonStyle(.bordered)
                    Button("Skip for now") { viewModel.advance() }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    // MARK: - Telegram

    private var telegramStep: some View {
        VStack(spacing: 16) {
            Image(systemName: "paperplane.fill")
                .font(.system(size: 40))
                .foregroundStyle(.blue)

            Text("Connect Telegram")
                .font(.title3).bold()
            Text("Optional: I can send you messages, alerts, and briefings on Telegram.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if viewModel.telegramBotName.isEmpty && !viewModel.telegramSkipped {
                VStack(spacing: 8) {
                    TextField("Bot token from @BotFather", text: $viewModel.telegramToken)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(.body, design: .monospaced))

                    Button(action: {
                        viewModel.connectTelegram()
                        viewModel.advance()
                    }) {
                        Text("Connect")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(viewModel.telegramToken.isEmpty)

                    Button("Skip — I'll add this later") {
                        viewModel.skipTelegram()
                        viewModel.advance()
                    }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            } else {
                VStack(spacing: 8) {
                    if !viewModel.telegramBotName.isEmpty {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                        Text("Connected: \(viewModel.telegramBotName)")
                    }

                    Button(action: { viewModel.advance() }) {
                        Text("Continue")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }
            }
        }
    }

    // MARK: - Starting

    private var startingStep: some View {
        VStack(spacing: 20) {
            dinoAnimation

            Text("Setting everything up...")
                .font(.title3).bold()

            VStack(alignment: .leading, spacing: 12) {
                statusRow(label: "Starting daemon", done: viewModel.daemonStarted)
                statusRow(label: "Installing auto-start", done: viewModel.autoStartInstalled)
                statusRow(label: "Scheduling daily tips", done: viewModel.daemonStarted)
            }
            .padding()
            .background(Color.gray.opacity(0.05))
            .cornerRadius(10)

            if let error = viewModel.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            ProgressView()
        }
    }

    // MARK: - Done

    private var doneStep: some View {
        VStack(spacing: 16) {
            Text("🦖")
                .font(.system(size: 48))

            Text("You're all set!")
                .font(.title2).bold()

            VStack(alignment: .leading, spacing: 8) {
                checkRow("Copilot", ok: viewModel.authState.isSuccess)
                checkRow("Daemon", ok: viewModel.daemonStarted)
                checkRow("Auto-start", ok: viewModel.autoStartInstalled)
                checkRow("Daily tips at 9am", ok: true)
            }
            .padding()
            .background(Color.gray.opacity(0.05))
            .cornerRadius(10)

            Text("Click the 🦖 in your menu bar anytime to chat with me. I'll send you a tip every morning to help you get the most out of openrappter.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button(action: { onComplete() }) {
                Text("Start Chatting")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
        }
    }

    // MARK: - Shared Components

    private var dinoAnimation: some View {
        Text("🦖")
            .font(.system(size: 56))
    }

    private func statusRow(label: String, done: Bool) -> some View {
        HStack(spacing: 8) {
            if done {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                ProgressView()
                    .controlSize(.small)
            }
            Text(label)
                .font(.callout)
            Spacer()
        }
    }

    private func checkRow(_ label: String, ok: Bool) -> some View {
        HStack(spacing: 6) {
            Image(systemName: ok ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(ok ? .green : .secondary)
                .font(.caption)
            Text(label)
                .font(.callout)
        }
    }
}

// Helper for auth state comparison
extension OnboardingViewModel.AuthState {
    var isSuccess: Bool {
        if case .success = self { return true }
        return false
    }
}
