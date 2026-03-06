import SwiftUI

// MARK: - Cron Settings View

public struct CronSettingsView: View {
    @Bindable var viewModel: CronViewModel
    @State private var showingCreateSheet = false
    @State private var selectedJob: CronJob? = nil

    public init(viewModel: CronViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let job = selectedJob {
                // Detail view — run history
                CronJobDetailView(job: job, viewModel: viewModel) {
                    selectedJob = nil
                }
            } else {
                // Job list
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
                                onTap: { selectedJob = job },
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
    let onTap: () -> Void
    let onToggle: () -> Void
    let onRun: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 12) {
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

            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onTapGesture { onTap() }
    }
}

// MARK: - Cron Job Detail View (Run History)

struct CronJobDetailView: View {
    let job: CronJob
    @Bindable var viewModel: CronViewModel
    let onBack: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Button(action: onBack) {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.left")
                            .font(.caption)
                        Text("Back")
                            .font(.callout)
                    }
                }
                .buttonStyle(.borderless)

                Spacer()

                Button {
                    viewModel.runJobNow(job)
                    // Reload logs after a delay
                    Task {
                        try? await Task.sleep(for: .seconds(3))
                        viewModel.loadLogs(jobId: job.id)
                    }
                } label: {
                    Label("Run Now", systemImage: "play.fill")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding()

            Divider()

            // Job info
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: job.enabled ? "clock.fill" : "clock")
                        .foregroundStyle(job.enabled ? .blue : .gray)
                    Text(job.name)
                        .font(.headline)
                }
                HStack(spacing: 12) {
                    Label(job.schedule, systemImage: "calendar")
                        .font(.caption)
                        .monospaced()
                        .foregroundStyle(.secondary)
                    if !job.command.isEmpty {
                        Text(job.command.prefix(60) + (job.command.count > 60 ? "…" : ""))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)

            Divider()

            // Run history
            HStack {
                Text("Run History")
                    .font(.subheadline)
                    .fontWeight(.semibold)
                Spacer()
                Button {
                    viewModel.loadLogs(jobId: job.id)
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal)
            .padding(.top, 8)

            if viewModel.logs.isEmpty {
                VStack(spacing: 8) {
                    Image(systemName: "doc.text.magnifyingglass")
                        .font(.title2)
                        .foregroundStyle(.tertiary)
                    Text("No runs yet")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text("Runs appear here after the cron fires or you click Run Now.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
            } else {
                List {
                    ForEach(viewModel.logs) { log in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Image(systemName: log.result == .success ? "checkmark.circle.fill" : log.result == .failure ? "xmark.circle.fill" : "clock.fill")
                                    .foregroundStyle(log.result == .success ? .green : log.result == .failure ? .red : .orange)
                                    .font(.caption)
                                Text(log.timestamp, style: .relative)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                if let duration = log.duration {
                                    Text(String(format: "%.1fs", duration))
                                        .font(.caption2)
                                        .monospaced()
                                        .foregroundStyle(.tertiary)
                                }
                            }
                            if let output = log.output, !output.isEmpty {
                                Text(output.prefix(200))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .listStyle(.inset(alternatesRowBackgrounds: true))
            }
        }
        .onAppear { viewModel.loadLogs(jobId: job.id) }
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
