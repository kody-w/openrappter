import Foundation

// MARK: - Settings ViewModel

@Observable
@MainActor
public final class SettingsViewModel {
    public let settingsStore: SettingsStore
    public let channelsViewModel = ChannelsViewModel()
    public let cronViewModel = CronViewModel()
    public let skillsViewModel = SkillsViewModel()
    public let approvalViewModel = ApprovalViewModel()
    private var rpcClient: RpcClient?

    // Config editor
    public var configYaml: String = ""
    public var configError: String?
    public var isLoadingConfig: Bool = false

    public init(settingsStore: SettingsStore) {
        self.settingsStore = settingsStore
    }

    /// Convenience init that creates a default SettingsStore. Must be called from @MainActor.
    public convenience init() {
        self.init(settingsStore: SettingsStore())
    }

    public func configure(rpcClient: RpcClient) {
        self.rpcClient = rpcClient
        channelsViewModel.configure(rpcClient: rpcClient)
        cronViewModel.configure(rpcClient: rpcClient)
        skillsViewModel.configure(rpcClient: rpcClient)
        approvalViewModel.configure(rpcClient: rpcClient)
    }

    // MARK: - Config Editor

    public func loadConfig() {
        guard let rpc = rpcClient else { return }
        isLoadingConfig = true
        configError = nil

        Task {
            do {
                let response = try await rpc.getConfig()
                configYaml = response
                isLoadingConfig = false
            } catch {
                configError = error.localizedDescription
                isLoadingConfig = false
            }
        }
    }

    public func saveConfig() {
        guard let rpc = rpcClient else { return }
        configError = nil

        Task {
            do {
                try await rpc.setConfig(yaml: configYaml)
            } catch {
                configError = error.localizedDescription
            }
        }
    }
}
