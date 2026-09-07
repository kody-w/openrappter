import CryptoKit
import Darwin
import Foundation
import Security

public struct RuntimeBootstrapProgress: Equatable, Sendable {
    public let phase: String
    public let message: String
    public let bytes: Int64?
    public let totalBytes: Int64?

    public var fraction: Double? {
        guard let bytes, let totalBytes, totalBytes > 0 else { return nil }
        return min(1, max(0, Double(bytes) / Double(totalBytes)))
    }
}

struct RuntimeBootstrapMetadata: Decodable {
    struct Node: Decodable {
        let version: String
        let url: String
        let sha256: String
        let size: Int64
        let binary_path: String
        let binary_sha256: String
        let binary_size: Int64
    }
    struct Runtime: Decodable {
        let file: String
        let sha256: String
        let size: Int64
    }
    struct Variant: Decodable {
        let node: Node
        let runtime: Runtime
    }
    let schema: String
    let source_commit: String
    let version: String
    let approval_url: String
    let helper_sha256: String
    let variants: [String: Variant]

    func validate(version expectedVersion: String, sourceCommit: String, architecture: String) throws -> Variant {
        guard schema == "openrappter-bar-bootstrap/v1",
              version == expectedVersion,
              version.range(of: #"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"#, options: .regularExpression) != nil,
              source_commit == sourceCommit,
              source_commit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              approval_url == "https://github.com/kody-w/openrappter/releases/download/v\(version)-bar/runtime-bootstrap-proof.json",
              helper_sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              Set(variants.keys) == Set(["arm64", "x86_64"]),
              let selected = variants[architecture] else {
            throw RuntimeBootstrapError.rejected("This signed bootstrap metadata does not match the Bar release or architecture.")
        }
        let node = selected.node
        let nodeArchitecture = architecture == "x86_64" ? "x64" : architecture
        let prefix = "node-v\(node.version)-darwin-\(nodeArchitecture)"
        guard node.version.range(of: #"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$"#, options: .regularExpression) != nil,
              Int(node.version.split(separator: ".").first ?? "") ?? 0 >= 24,
              node.url == "https://nodejs.org/dist/v\(node.version)/\(prefix).tar.gz",
              node.binary_path == "\(prefix)/bin/node",
              node.binary_sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              node.binary_size > 0, node.binary_size <= 256 * 1024 * 1024,
              selected.runtime.file == "openrappter-runtime-\(version)-darwin-\(architecture).tar.gz",
              selected.runtime.sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              selected.runtime.size > 0, selected.runtime.size <= 512 * 1024 * 1024 else {
            throw RuntimeBootstrapError.rejected("The runtime or Node download is not pinned to this architecture.")
        }
        try PinnedRuntimeArtifact(url: node.url, sha256: node.sha256, size: node.size).validate()
        return selected
    }
}

public struct VerifiedRuntimeLocation: Equatable, Sendable {
    public let projectPath: String
    public let nodePath: String
    public let sourceCommit: String
    public let version: String
    public let architecture: String
}

struct RuntimeBootstrapContext {
    let metadataURL: URL
    let helperURL: URL
    let version: String
    let sourceCommit: String
    let architecture: String
}

@MainActor
struct VerifiedRuntimeInstallerDependencies {
    var context: () throws -> RuntimeBootstrapContext
    var home: URL
    var desktopIsAuthoritative: () -> Bool
    var download: (PinnedRuntimeArtifact, URL, @escaping @Sendable (Int64, Int64) -> Void) async throws -> Void
    var runProcess: (
        URL, [String], URL, URL?, Int64,
        @escaping @Sendable (String) -> Void,
        @escaping @Sendable () async -> Bool
    ) async throws -> Void
}

/// The bootstrap root of trust is the Developer-ID-sealed app resource set.
/// Downloaded Node and runtime bytes are independently pinned and verified;
/// downloaded approval documents are data, never executable installer code.
@Observable
@MainActor
public final class VerifiedRuntimeInstaller {
    public private(set) var progress: RuntimeBootstrapProgress?
    private let dependencies: VerifiedRuntimeInstallerDependencies
    private var operation: Task<Void, Error>?
    private var generation: UInt = 0
    private var lastHelperFailure: String?

    public static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unsupported"
        #endif
    }

    public static func live(homeDirectory: String = NSHomeDirectory()) -> VerifiedRuntimeInstaller {
        VerifiedRuntimeInstaller(dependencies: VerifiedRuntimeInstallerDependencies(
            context: { try signedContext(bundle: .main) },
            home: URL(fileURLWithPath: homeDirectory),
            desktopIsAuthoritative: { DesktopGatewayDiscovery.current() != nil },
            download: { artifact, destination, progress in
                try await PinnedRuntimeDownload(artifact: artifact, destination: destination, progress: progress).run()
            },
            runProcess: { executable, arguments, directory, output, maximum, onLine, shouldCommit in
                try await BootstrapProcess().run(
                    executable: executable, arguments: arguments, directory: directory,
                    outputFile: output, maximumOutput: maximum, onLine: onLine,
                    shouldCommit: shouldCommit
                )
            }
        ))
    }

    init(dependencies: VerifiedRuntimeInstallerDependencies) {
        self.dependencies = dependencies
    }

    public func install() async throws {
        if let operation {
            let priorGeneration = generation
            do { return try await operation.value }
            catch {
                guard operation.isCancelled, !Task.isCancelled else { throw error }
                if generation == priorGeneration { self.operation = nil }
                return try await install()
            }
        }
        generation &+= 1
        let current = generation
        let task = Task { try await performInstall(generation: current) }
        operation = task
        defer { if current == generation { operation = nil } }
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    public func cancel() {
        operation?.cancel()
    }

    private func performInstall(generation current: UInt) async throws {
        if dependencies.desktopIsAuthoritative() { return }
        var workspace: URL?
        defer { if let workspace { try? FileManager.default.removeItem(at: workspace) } }
        do {
            progress = nil
            lastHelperFailure = nil
            update(phase: "checking-release")
            let context = try dependencies.context()
            let metadataData = try boundedData(context.metadataURL, maximum: 64 * 1024)
            let metadata = try JSONDecoder().decode(RuntimeBootstrapMetadata.self, from: metadataData)
            let selected = try metadata.validate(
                version: context.version, sourceCommit: context.sourceCommit, architecture: context.architecture
            )
            let helper = try boundedData(context.helperURL, maximum: 256 * 1024)
            guard SHA256.hash(data: helper).map({ String(format: "%02x", $0) }).joined() == metadata.helper_sha256 else {
                throw RuntimeBootstrapError.rejected("The sealed installer helper has changed. Reinstall the signed Bar.")
            }
            try Task.checkCancellation()
            if dependencies.desktopIsAuthoritative() { return }
            let root = try privateWorkspace(home: dependencies.home)
            workspace = root
            // Execute snapshots of the sealed resources, not mutable downloaded scripts.
            let helperCopy = root.appendingPathComponent("verified-runtime-bootstrap.mjs")
            let metadataCopy = root.appendingPathComponent("runtime-bootstrap.json")
            try writeExclusive(helper, to: helperCopy)
            try writeExclusive(metadataData, to: metadataCopy)
            let archive = root.appendingPathComponent("node.tar.gz")
            let node = root.appendingPathComponent("node")
            update(phase: "downloading-node", bytes: 0, total: selected.node.size)
            try await dependencies.download(
                PinnedRuntimeArtifact(url: selected.node.url, sha256: selected.node.sha256, size: selected.node.size),
                archive
            ) { [weak self] bytes, total in
                Task { @MainActor in
                    guard let self, self.generation == current, self.operation != nil,
                          self.operation?.isCancelled != true else { return }
                    self.update(phase: "downloading-node", bytes: bytes, total: total)
                }
            }
            try Task.checkCancellation()
            try BootstrapFileIntegrity.verify(archive, sha256: selected.node.sha256, size: selected.node.size)
            if dependencies.desktopIsAuthoritative() { return }
            update(phase: "verifying-node")
            // -O extracts only the exact member to stdout. Tar never writes paths
            // from the archive; the resulting binary must pass its own signed pin.
            try await dependencies.runProcess(
                URL(fileURLWithPath: "/usr/bin/tar"),
                ["-xzOf", archive.path, selected.node.binary_path],
                root, node, selected.node.binary_size, { _ in }, { false }
            )
            try Task.checkCancellation()
            try BootstrapFileIntegrity.verify(node, sha256: selected.node.binary_sha256, size: selected.node.binary_size)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: node.path)
            if dependencies.desktopIsAuthoritative() { return }
            try BootstrapFileIntegrity.verify(
                helperCopy, sha256: metadata.helper_sha256, size: Int64(helper.count)
            )
            try BootstrapFileIntegrity.verify(
                metadataCopy,
                sha256: SHA256.hash(data: metadataData).map { String(format: "%02x", $0) }.joined(),
                size: Int64(metadataData.count)
            )
            update(phase: "checking-approval")
            try await dependencies.runProcess(
                node,
                [helperCopy.path, "--metadata", metadataCopy.path, "--architecture", context.architecture,
                 "--home", dependencies.home.path, "--workspace", root.path],
                root, nil, 1024 * 1024,
                { [weak self] line in
                    Task { @MainActor in
                        guard let self, self.generation == current, self.operation != nil,
                              self.operation?.isCancelled != true,
                              let data = line.data(using: .utf8),
                              let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let phase = event["phase"] as? String else { return }
                        if phase == "error" {
                            self.lastHelperFailure = (event["message"] as? String).map { String($0.prefix(512)) }
                        }
                        self.update(phase: phase, bytes: (event["bytes"] as? NSNumber)?.int64Value,
                                    total: (event["totalBytes"] as? NSNumber)?.int64Value,
                                    error: self.lastHelperFailure)
                    }
                },
                { [weak self] in
                    guard let self else { return false }
                    return await self.allowActivation(generation: current)
                }
            )
            try Task.checkCancellation()
            guard !dependencies.desktopIsAuthoritative() else { return }
            guard try Self.readInstallation(metadata: metadata, architecture: context.architecture, home: dependencies.home) != nil else {
                throw RuntimeBootstrapError.rejected("The runtime installation could not be verified after setup.")
            }
            update(phase: "installed")
        } catch {
            if error is CancellationError {
                update(phase: "cancelled")
            } else if progress?.phase != "error" {
                update(phase: "error", error: lastHelperFailure ?? error.localizedDescription)
            }
            if let lastHelperFailure, !(error is CancellationError) {
                throw RuntimeBootstrapError.rejected(lastHelperFailure)
            }
            throw error
        }
    }

    public static func preferredInstallation(
        homeDirectory: String = NSHomeDirectory(), bundle: Bundle = .main
    ) -> VerifiedRuntimeLocation? {
        do {
            let context = try signedContext(bundle: bundle)
            let metadata = try JSONDecoder().decode(RuntimeBootstrapMetadata.self, from: boundedData(context.metadataURL, maximum: 64 * 1024))
            _ = try metadata.validate(version: context.version, sourceCommit: context.sourceCommit, architecture: context.architecture)
            return try readInstallation(metadata: metadata, architecture: context.architecture, home: URL(fileURLWithPath: homeDirectory))
        } catch { return nil }
    }

    /// Use before the process manager's legacy Node search. It cannot pair a
    /// downloaded Node ABI with an independently selected/custom project.
    public static func preferredNodeExecutable(
        forProjectPath projectPath: String,
        homeDirectory: String = NSHomeDirectory(),
        bundle: Bundle = .main
    ) -> String? {
        guard let installation = preferredInstallation(homeDirectory: homeDirectory, bundle: bundle),
              URL(fileURLWithPath: projectPath).resolvingSymlinksInPath().path
                == URL(fileURLWithPath: installation.projectPath).resolvingSymlinksInPath().path else {
            return nil
        }
        return installation.nodePath
    }

    private func allowActivation(generation current: UInt) -> Bool {
        generation == current && !dependencies.desktopIsAuthoritative() && operation?.isCancelled != true
    }

    static func readInstallation(metadata: RuntimeBootstrapMetadata, architecture: String, home: URL) throws -> VerifiedRuntimeLocation? {
        guard !hasPendingActivation(homeDirectory: home.path) else { return nil }
        let marker = home.appendingPathComponent(".openrappter/runtime-bootstrap-installation.json")
        guard FileManager.default.fileExists(atPath: marker.path) else { return nil }
        let value = try JSONSerialization.jsonObject(with: boundedData(marker, maximum: 64 * 1024)) as? [String: Any]
        guard let selected = metadata.variants[architecture] else { return nil }
        let id = "\(metadata.source_commit)-\(architecture)-\(selected.runtime.sha256)"
        guard value?["schema"] as? String == "openrappter-bar-runtime-installation/v1",
              value?["source_commit"] as? String == metadata.source_commit,
              value?["version"] as? String == metadata.version,
              value?["architecture"] as? String == architecture,
              value?["runtime_sha256"] as? String == selected.runtime.sha256,
              value?["node_sha256"] as? String == selected.node.binary_sha256,
              value?["installation_id"] as? String == id else { return nil }
        let root = home.appendingPathComponent(".local/share/openrappter/releases/\(id)")
        try requireDirectoriesWithoutLinks(root, from: home)
        let project = root.appendingPathComponent("runtime")
        let node = root.appendingPathComponent("node/bin/node")
        try requireDirectoriesWithoutLinks(node.deletingLastPathComponent(), from: root)
        try requireDirectoriesWithoutLinks(project, from: root)
        try BootstrapFileIntegrity.verify(node, sha256: selected.node.binary_sha256, size: selected.node.binary_size)
        let package = try JSONSerialization.jsonObject(with: boundedData(project.appendingPathComponent("package.json"), maximum: MAX_PACKAGE_BYTES)) as? [String: Any]
        guard package?["name"] as? String == "openrappter", package?["version"] as? String == metadata.version,
              FileManager.default.isExecutableFile(atPath: node.path) else { return nil }
        try requireDirectoriesWithoutLinks(project.appendingPathComponent("dist"), from: root)
        _ = try boundedData(project.appendingPathComponent("dist/index.js"), maximum: 16 * 1024 * 1024)
        return VerifiedRuntimeLocation(
            projectPath: project.path, nodePath: node.path, sourceCommit: metadata.source_commit,
            version: metadata.version, architecture: architecture
        )
    }

    private static let MAX_PACKAGE_BYTES = 1024 * 1024

    public static func hasPendingActivation(homeDirectory: String = NSHomeDirectory()) -> Bool {
        let path = URL(fileURLWithPath: homeDirectory)
            .appendingPathComponent(".openrappter/runtime-bootstrap-transaction.json").path
        var status = stat()
        return lstat(path, &status) == 0 || errno != ENOENT
    }

    private static func signedContext(bundle: Bundle) throws -> RuntimeBootstrapContext {
        guard let resources = bundle.resourceURL,
              let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              let commit = bundle.object(forInfoDictionaryKey: "OpenRappterSourceCommit") as? String else {
            throw RuntimeBootstrapError.rejected("This Bar build lacks signed runtime download metadata. Install its approved signed release, then retry.")
        }
        var code: SecStaticCode?
        var requirement: SecRequirement?
        let expression = #"anchor apple generic and identifier "com.openrappter.bar" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"#
        guard SecStaticCodeCreateWithPath(bundle.bundleURL as CFURL, [], &code) == errSecSuccess,
              SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
              let code,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate), requirement) == errSecSuccess else {
            throw RuntimeBootstrapError.rejected("The Bar's Developer-ID resource seal could not be verified. Reinstall its signed release; no security override is needed.")
        }
        return RuntimeBootstrapContext(
            metadataURL: resources.appendingPathComponent("runtime-bootstrap.json"),
            helperURL: resources.appendingPathComponent("verified-runtime-bootstrap.mjs"),
            version: version, sourceCommit: commit, architecture: architecture
        )
    }

    private static func boundedData(_ file: URL, maximum: Int) throws -> Data {
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let size = attributes[.size] as? NSNumber, size.intValue > 0, size.intValue <= maximum else {
            throw RuntimeBootstrapError.rejected("A bootstrap metadata file is missing, linked, or oversized.")
        }
        return try Data(contentsOf: file)
    }

    private func boundedData(_ file: URL, maximum: Int) throws -> Data {
        try Self.boundedData(file, maximum: maximum)
    }

    private func writeExclusive(_ data: Data, to file: URL) throws {
        let output = try BootstrapFileIntegrity.createExclusiveFile(file)
        defer { try? output.close() }
        try output.write(contentsOf: data)
        try output.synchronize()
    }

    private func privateWorkspace(home: URL) throws -> URL {
        let base = home.appendingPathComponent(".openrappter/bootstrap")
        var cursor = home
        for name in [".openrappter", "bootstrap"] {
            cursor.appendPathComponent(name)
            if !FileManager.default.fileExists(atPath: cursor.path) {
                try FileManager.default.createDirectory(at: cursor, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            }
            try Self.requireDirectoriesWithoutLinks(cursor, from: home)
        }
        let result = base.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: result, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        return result
    }

    private static func requireDirectoriesWithoutLinks(_ destination: URL, from root: URL) throws {
        let base = root.standardizedFileURL.path
        let target = destination.standardizedFileURL.path
        guard target == base || target.hasPrefix(base + "/") else {
            throw RuntimeBootstrapError.rejected("Runtime installation escaped its user-owned root.")
        }
        var cursor = root
        for part in target.dropFirst(base.count).split(separator: "/") {
            cursor.appendPathComponent(String(part))
            let attributes = try FileManager.default.attributesOfItem(atPath: cursor.path)
            guard attributes[.type] as? FileAttributeType == .typeDirectory else {
                throw RuntimeBootstrapError.rejected("A runtime installation directory is linked or invalid.")
            }
        }
    }

    private func update(phase: String, bytes: Int64? = nil, total: Int64? = nil, error: String? = nil) {
        let order = ["checking-release", "downloading-node", "verifying-node", "checking-approval",
                     "downloading-runtime", "verifying-runtime", "downloading-runtime-parts", "extracting-runtime", "checking-runtime",
                     "ready-to-activate", "installed", "cancelled", "error"]
        if let previous = progress, let old = order.firstIndex(of: previous.phase),
           let next = order.firstIndex(of: phase), next < old { return }
        let messages = [
            "checking-release": "Checking this signed Bar release…",
            "downloading-node": "Downloading the pinned Node runtime…",
            "verifying-node": "Verifying Node before executing anything…",
            "checking-approval": "Verifying nightly → alpha → canary → beta receipts…",
            "downloading-runtime": "Downloading the exact approved candidate…",
            "verifying-runtime": "Checking candidate provenance and runtime hashes…",
            "downloading-runtime-parts": "Downloading the verified runtime parts…",
            "extracting-runtime": "Safely unpacking the matching runtime…",
            "checking-runtime": "Checking the prebuilt runtime without installing dependencies…",
            "ready-to-activate": "Checking Desktop authority before activation…",
            "installed": "Verified runtime installed. Checking gateway readiness…",
            "cancelled": "Runtime download cancelled. You can retry setup.",
            "error": error ?? "Verified runtime setup failed. You can retry.",
        ]
        guard let message = messages[phase] else { return }
        progress = RuntimeBootstrapProgress(phase: phase, message: message, bytes: bytes, totalBytes: total)
    }
}
