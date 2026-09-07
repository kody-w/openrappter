import Foundation

public enum RuntimePrerequisiteError: LocalizedError {
    case unavailable
    case disconnected
    case incompatible
    case timedOut

    public var errorDescription: String? {
        switch self {
        case .unavailable:
            return "The matching approved runtime is not available yet. Retry its verified download, or reconnect an already-authoritative OpenRappter Desktop."
        case .disconnected:
            return "The selected OpenRappter gateway did not become ready. Reopen that runtime and retry."
        case .incompatible:
            return "This gateway does not provide the chat and authentication capabilities required by OpenRappter Bar."
        case .timedOut:
            return "Runtime setup timed out. Setup has not completed; check the runtime and retry."
        }
    }
}

@MainActor
struct RuntimePrerequisiteDependencies {
    var desktopIsAuthoritative: () -> Bool
    var localRuntimeAvailable: () -> Bool
    var provisionVerifiedRuntime: () async throws -> Void
    var startLocalRuntime: () async throws -> Void
    var verifyGateway: (_ desktop: Bool) async throws -> Void
    var bootstrapProgress: () -> RuntimeBootstrapProgress? = { nil }
}

/// Coordinates receipt-verified first-launch provisioning for this Bar release.
/// Launch and connection stay owned by AppViewModel's lifecycle coordinator.
@MainActor
public final class RuntimePrerequisiteService {
    private let dependencies: RuntimePrerequisiteDependencies

    init(dependencies: RuntimePrerequisiteDependencies) {
        self.dependencies = dependencies
    }

    public var desktopIsAuthoritative: Bool { dependencies.desktopIsAuthoritative() }
    public var hasInstalledRuntime: Bool {
        desktopIsAuthoritative || dependencies.localRuntimeAvailable()
    }
    public var bootstrapProgress: RuntimeBootstrapProgress? { dependencies.bootstrapProgress() }

    func prepare() async throws -> Bool {
        if desktopIsAuthoritative {
            try await dependencies.verifyGateway(true)
            try Task.checkCancellation()
            return true
        }
        if !dependencies.localRuntimeAvailable() {
            do {
                try await dependencies.provisionVerifiedRuntime()
            } catch {
                guard desktopIsAuthoritative, !Task.isCancelled else { throw error }
            }
            try Task.checkCancellation()
        }
        // An authoritative Desktop may appear while setup is in progress.
        if desktopIsAuthoritative {
            try await dependencies.verifyGateway(true)
            try Task.checkCancellation()
            return true
        }
        guard dependencies.localRuntimeAvailable() else { throw RuntimePrerequisiteError.unavailable }
        try await dependencies.startLocalRuntime()
        try Task.checkCancellation()
        let desktop = desktopIsAuthoritative
        try await dependencies.verifyGateway(desktop)
        try Task.checkCancellation()
        return desktop
    }

    static func localRuntimeAvailable(
        projectPath: String? = nil,
        nodePath: String? = nil,
        files: FileManager = .default
    ) -> Bool {
        if VerifiedRuntimeInstaller.hasPendingActivation() { return false }
        guard let nodePath = nodePath ?? ProcessManager.resolveNodeExecutable(),
              files.isExecutableFile(atPath: nodePath) else { return false }
        let root = URL(fileURLWithPath: projectPath ?? ProcessManager.resolveProjectPath())
        guard let data = try? Data(contentsOf: root.appendingPathComponent("package.json")),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              manifest["name"] as? String == "openrappter",
              files.fileExists(atPath: root.appendingPathComponent("dist/index.js").path) else {
            return false
        }
        return true
    }

    static func requireCompatibleMethods(_ methods: [String], desktop: Bool) throws {
        var required: Set<String> = ["chat.send", "chat.abort", "chat.list", "chat.messages"]
        if desktop {
            required.formUnion(["auth.login", "auth.poll", "auth.cancel", "auth.active"])
        }
        guard required.isSubset(of: Set(methods)) else { throw RuntimePrerequisiteError.incompatible }
    }

    static func unconfigured() -> RuntimePrerequisiteService {
        RuntimePrerequisiteService(dependencies: RuntimePrerequisiteDependencies(
            desktopIsAuthoritative: { DesktopGatewayDiscovery.current() != nil },
            localRuntimeAvailable: { Self.localRuntimeAvailable() },
            provisionVerifiedRuntime: { throw RuntimePrerequisiteError.unavailable },
            startLocalRuntime: { throw RuntimePrerequisiteError.disconnected },
            verifyGateway: { _ in throw RuntimePrerequisiteError.disconnected }
        ))
    }
}
