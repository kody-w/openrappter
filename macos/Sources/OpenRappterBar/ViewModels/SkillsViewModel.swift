import Foundation

// MARK: - Skills ViewModel

@Observable
@MainActor
public final class SkillsViewModel {
    public var skills: [Skill] = []
    public var isLoading: Bool = false
    public var error: String?

    private var rpcClient: RpcClient?

    public init() {}

    public func configure(rpcClient: RpcClient) {
        self.rpcClient = rpcClient
    }

    // MARK: - Actions

    public func loadSkills() {
        guard let rpc = rpcClient else { return }
        isLoading = true
        error = nil

        Task {
            do {
                skills = try await rpc.listSkills()
                isLoading = false
            } catch {
                self.error = error.localizedDescription
                isLoading = false
            }
        }
    }

    public func installSkill(name: String) {
        guard let rpc = rpcClient else { return }
        Task {
            do {
                try await rpc.installSkill(name: name)
                loadSkills()
            } catch {
                self.error = "Install failed: \(error.localizedDescription)"
            }
        }
    }

    public func toggleSkill(_ skill: Skill) {
        // Local toggle — skills are enabled/disabled via config
        if let idx = skills.firstIndex(where: { $0.id == skill.id }) {
            skills[idx].enabled.toggle()
        }
    }
}
