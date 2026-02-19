import Foundation

// MARK: - Cron ViewModel

@Observable
@MainActor
public final class CronViewModel {
    public var jobs: [CronJob] = []
    public var logs: [CronExecutionLog] = []
    public var isLoading: Bool = false
    public var error: String?

    private var rpcClient: RpcClient?

    public init() {}

    public func configure(rpcClient: RpcClient) {
        self.rpcClient = rpcClient
    }

    // MARK: - Jobs

    public func loadJobs() {
        guard let rpc = rpcClient else { return }
        isLoading = true
        error = nil

        Task {
            do {
                jobs = try await rpc.listCronJobs()
                isLoading = false
            } catch {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    public func createJob(name: String, schedule: String, command: String) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.createCronJob(name: name, schedule: schedule, command: command)
                loadJobs()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func deleteJob(_ job: CronJob) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.deleteCronJob(jobId: job.id)
                jobs.removeAll { $0.id == job.id }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func toggleJob(_ job: CronJob) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                if job.enabled {
                    try await rpc.pauseCronJob(jobId: job.id)
                } else {
                    try await rpc.resumeCronJob(jobId: job.id)
                }
                loadJobs()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    public func runJobNow(_ job: CronJob) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.triggerCronJob(jobId: job.id)
            } catch {
                self.error = "Run failed: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Logs

    public func loadLogs(jobId: String? = nil) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                logs = try await rpc.getCronLogs(jobId: jobId)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
