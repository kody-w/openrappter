import SwiftUI

// MARK: - Cron Settings View

public struct CronSettingsView: View {
    @Bindable var viewModel: CronViewModel
    @State private var showingCreateSheet = false

    public init(viewModel: CronViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Scheduled Jobs")
                    .font(.headline)
                Spacer()
                Button {
                    showingCreateSheet = true
                } label: {
                    Image(systemName: "plus")
                }
                .buttonStyle(.borderless)

                Button {
                    viewModel.loadJobs()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
            }
            .padding()

            Divider()

            if viewModel.isLoading {
                ProgressView("Loading jobs...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.jobs.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "clock.arrow.2.circlepath")
                        .font(.largeTitle)
                        .foregroundStyle(.tertiary)
                    Text("No scheduled jobs")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(viewModel.jobs) { job in
                        CronJobRow(
                            job: job,
                            onToggle: { viewModel.toggleJob(job) },
                            onRun: { viewModel.runJobNow(job) },
                            onDelete: { viewModel.deleteJob(job) }
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
        .onAppear { viewModel.loadJobs() }
        .sheet(isPresented: $showingCreateSheet) {
            CreateCronJobSheet(viewModel: viewModel, isPresented: $showingCreateSheet)
        }
    }
}

// MARK: - Cron Job Row

struct CronJobRow: View {
    let job: CronJob
    let onToggle: () -> Void
    let onRun: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            // Status
            Image(systemName: job.enabled ? "clock.fill" : "clock")
                .foregroundStyle(job.enabled ? .blue : .gray)

            VStack(alignment: .leading, spacing: 2) {
                Text(job.name)
                    .font(.callout)
                    .fontWeight(.medium)
                HStack(spacing: 6) {
                    Text(job.schedule)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospaced()
                    if let lastResult = job.lastResult {
                        Text(lastResult.rawValue)
                            .font(.caption2)
                            .foregroundStyle(lastResult == .success ? .green : .red)
                    }
                }
            }

            Spacer()

            Button(action: onRun) {
                Image(systemName: "play.fill")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .help("Run now")

            Toggle("", isOn: .constant(job.enabled))
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
}

// MARK: - Create Cron Job Sheet

struct CreateCronJobSheet: View {
    @Bindable var viewModel: CronViewModel
    @Binding var isPresented: Bool
    @State private var name = ""
    @State private var schedule = ""
    @State private var command = ""

    var body: some View {
        VStack(spacing: 16) {
            Text("New Scheduled Job")
                .font(.headline)

            Form {
                TextField("Name", text: $name)
                TextField("Schedule (cron)", text: $schedule)
                    .monospaced()
                TextField("Command", text: $command)
            }
            .formStyle(.grouped)

            HStack {
                Button("Cancel") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button("Create") {
                    viewModel.createJob(name: name, schedule: schedule, command: command)
                    isPresented = false
                }
                .keyboardShortcut(.defaultAction)
                .disabled(name.isEmpty || schedule.isEmpty || command.isEmpty)
            }
        }
        .padding()
        .frame(width: 400)
    }
}
