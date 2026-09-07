import CryptoKit
import Foundation
@testable import OpenRappterBarLib

private func bootstrapSHA(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}

@MainActor
private final class BootstrapFixture {
    let root: URL
    let home: URL
    let metadataURL: URL
    let helperURL: URL
    let node = Data("fixture verified Node".utf8)
    let archive = Data("fixture pinned archive".utf8)
    let sourceCommit = String(repeating: "a", count: 40)
    let version = "1.14.0"
    var architecture = "arm64"
    var metadata: [String: Any] = [:]
    var desktop = false
    var refuseContext = false
    var corruptDownload = false
    var corruptBinary = false
    var omitInstallation = false
    var takeoverBeforeCommit = false
    var downloadCount = 0
    var commands: [String] = []
    var helperGate: TestGate?

    init() throws {
        root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            .appendingPathComponent(".swift-bootstrap-\(UUID().uuidString)")
        home = root.appendingPathComponent("home")
        metadataURL = root.appendingPathComponent("runtime-bootstrap.json")
        helperURL = root.appendingPathComponent("verified-runtime-bootstrap.mjs")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let helper = Data("// fixture sealed helper\n".utf8)
        try helper.write(to: helperURL)
        var variants: [String: Any] = [:]
        for arch in ["arm64", "x86_64"] {
            let nodeRoot = "node-v24.19.0-darwin-\(arch == "x86_64" ? "x64" : arch)"
            variants[arch] = [
                "node": [
                    "version": "24.19.0", "url": "https://nodejs.org/dist/v24.19.0/\(nodeRoot).tar.gz",
                    "sha256": bootstrapSHA(archive), "size": archive.count,
                    "binary_path": "\(nodeRoot)/bin/node",
                    "binary_sha256": bootstrapSHA(node), "binary_size": node.count,
                ],
                "runtime": [
                    "file": "openrappter-runtime-\(version)-darwin-\(arch).tar.gz",
                    "sha256": String(repeating: "b", count: 64), "size": 4096,
                ],
            ]
        }
        metadata = [
            "schema": "openrappter-bar-bootstrap/v1", "source_commit": sourceCommit,
            "version": version,
            "approval_url": "https://github.com/kody-w/openrappter/releases/download/v\(version)-bar/runtime-bootstrap-proof.json",
            "helper_sha256": bootstrapSHA(helper), "variants": variants,
        ]
        try saveMetadata()
    }

    func saveMetadata() throws {
        try JSONSerialization.data(withJSONObject: metadata).write(to: metadataURL)
    }

    func clean() { try? FileManager.default.removeItem(at: root) }

    func installer() -> VerifiedRuntimeInstaller {
        VerifiedRuntimeInstaller(dependencies: VerifiedRuntimeInstallerDependencies(
            context: {
                if self.refuseContext { throw RuntimeBootstrapError.rejected("Unsealed app rejected") }
                return RuntimeBootstrapContext(
                    metadataURL: self.metadataURL, helperURL: self.helperURL,
                    version: self.version, sourceCommit: self.sourceCommit, architecture: self.architecture
                )
            },
            home: home,
            desktopIsAuthoritative: { self.desktop },
            download: { artifact, destination, progress in
                self.downloadCount += 1
                try (self.corruptDownload ? Data("tampered".utf8) : self.archive).write(to: destination)
                progress(artifact.size, artifact.size)
            },
            runProcess: { executable, arguments, directory, output, _, onLine, shouldCommit in
                self.commands.append(executable.path)
                if executable.path == "/usr/bin/tar" {
                    try expectEqual(arguments.prefix(1), ["-xzOf"].prefix(1))
                    try expect(arguments.last?.hasSuffix("/bin/node") == true)
                    try (self.corruptBinary ? Data("tampered".utf8) : self.node).write(to: output!)
                    return
                }
                try expectEqual(try BootstrapFileIntegrity.digest(executable), bootstrapSHA(self.node))
                try expect(arguments[0].hasSuffix("/verified-runtime-bootstrap.mjs"))
                try expect(directory.path.hasPrefix(self.home.path + "/.openrappter/bootstrap/"))
                if let gate = self.helperGate { await gate.wait() }
                try Task.checkCancellation()
                if self.takeoverBeforeCommit { self.desktop = true }
                guard await shouldCommit() else { throw RuntimeBootstrapError.rejected("Desktop became authoritative") }
                if !self.omitInstallation { try self.writeInstallation() }
                onLine(#"{"phase":"installed"}"#)
            }
        ))
    }

    func decoded() throws -> RuntimeBootstrapMetadata {
        try JSONDecoder().decode(RuntimeBootstrapMetadata.self, from: Data(contentsOf: metadataURL))
    }

    func writeInstallation() throws {
        let runtimeSHA = String(repeating: "b", count: 64)
        let id = "\(sourceCommit)-\(architecture)-\(runtimeSHA)"
        let install = home.appendingPathComponent(".local/share/openrappter/releases/\(id)")
        for folder in ["node/bin", "runtime/dist"] {
            try FileManager.default.createDirectory(at: install.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        let binary = install.appendingPathComponent("node/bin/node")
        try node.write(to: binary)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
        try JSONSerialization.data(withJSONObject: ["name": "openrappter", "version": version])
            .write(to: install.appendingPathComponent("runtime/package.json"))
        try Data("export const ready = true;\n".utf8).write(to: install.appendingPathComponent("runtime/dist/index.js"))
        let record: [String: Any] = [
            "schema": "openrappter-bar-runtime-installation/v1",
            "source_commit": sourceCommit, "version": version, "architecture": architecture,
            "runtime_sha256": runtimeSHA, "node_sha256": bootstrapSHA(node),
            "candidate_sha256": String(repeating: "c", count: 64), "installation_id": id,
        ]
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".openrappter"), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: record)
            .write(to: home.appendingPathComponent(".openrappter/runtime-bootstrap-installation.json"))
    }

    func workspaceCount() throws -> Int {
        let path = home.appendingPathComponent(".openrappter/bootstrap")
        guard FileManager.default.fileExists(atPath: path.path) else { return 0 }
        return try FileManager.default.contentsOfDirectory(atPath: path.path).count
    }
}

@MainActor
func runVerifiedRuntimeBootstrapTests() async {
    await suite("Verified first-launch runtime bootstrap") {
        await test("native activation is authorized before the helper closes stdout") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let lines = AsyncCollector<String>()
            try await BootstrapProcess().run(
                executable: URL(fileURLWithPath: "/bin/sh"),
                arguments: ["-c", "printf '{\"phase\":\"ready-to-activate\"}\\n'; IFS= read -r answer; test \"$answer\" = '{\"action\":\"commit\"}'"],
                directory: fixture.root, timeout: 3,
                onLine: { value in Task { await lines.append(value) } },
                shouldCommit: { true }
            )
            try expectEqual(try await lines.waitForCount(1), [#"{"phase":"ready-to-activate"}"#])
        }

        await test("a pending activation journal cannot masquerade as a committed preferred runtime") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            try fixture.writeInstallation()
            let journal = fixture.home.appendingPathComponent(".openrappter/runtime-bootstrap-transaction.json")
            try Data("{}".utf8).write(to: journal)
            try expect(VerifiedRuntimeInstaller.hasPendingActivation(homeDirectory: fixture.home.path))
            try expectNil(try VerifiedRuntimeInstaller.readInstallation(
                metadata: fixture.decoded(), architecture: fixture.architecture, home: fixture.home
            ))
        }

        await test("positive native path verifies archive and binary before running sealed helper") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let installer = fixture.installer()
            try await installer.install()
            try expectEqual(fixture.downloadCount, 1)
            try expectEqual(fixture.commands.count, 2)
            try expectEqual(fixture.commands[0], "/usr/bin/tar")
            try expect(fixture.commands[1].hasPrefix(fixture.home.path + "/.openrappter/bootstrap/"))
            try expectEqual(installer.progress?.phase, "installed")
            let location = try VerifiedRuntimeInstaller.readInstallation(
                metadata: fixture.decoded(), architecture: "arm64", home: fixture.home
            )
            try expectNotNil(location)
            try expectEqual(location?.sourceCommit, fixture.sourceCommit)
            try expectEqual(location?.version, fixture.version)
            try expectEqual(try fixture.workspaceCount(), 0)
        }

        await test("onboarding startup receives the exact newly installed Node and project pair") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let installer = fixture.installer()
            var selected: VerifiedRuntimeLocation?
            let runtime = RuntimePrerequisiteService(dependencies: RuntimePrerequisiteDependencies(
                desktopIsAuthoritative: { false },
                localRuntimeAvailable: {
                    (try? VerifiedRuntimeInstaller.readInstallation(
                        metadata: fixture.decoded(), architecture: fixture.architecture, home: fixture.home
                    )) != nil
                },
                provisionVerifiedRuntime: { try await installer.install() },
                startLocalRuntime: {
                    selected = try VerifiedRuntimeInstaller.readInstallation(
                        metadata: fixture.decoded(), architecture: fixture.architecture, home: fixture.home
                    )
                    try expectNotNil(selected)
                },
                verifyGateway: { desktop in
                    try expect(!desktop)
                    try expect(selected?.nodePath.hasSuffix("/node/bin/node") == true)
                    try expect(selected?.projectPath.hasSuffix("/runtime") == true)
                },
                bootstrapProgress: { installer.progress }
            ))
            try expect(!(try await runtime.prepare()))
            try expectEqual(selected?.version, fixture.version)
        }

        await test("x86_64 selects its own pinned Node and runtime") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            fixture.architecture = "x86_64"
            try await fixture.installer().install()
            let location = try VerifiedRuntimeInstaller.readInstallation(
                metadata: fixture.decoded(), architecture: "x86_64", home: fixture.home
            )
            try expectEqual(location?.architecture, "x86_64")
        }

        await test("an unsealed Bar cannot download or execute bootstrap bytes") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            fixture.refuseContext = true
            do { try await fixture.installer().install(); throw AssertionError(description: "unsealed context accepted") }
            catch is RuntimeBootstrapError {}
            try expectEqual(fixture.downloadCount + fixture.commands.count, 0)
        }

        await test("wrong release source refuses before downloading") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            fixture.metadata["source_commit"] = String(repeating: "e", count: 40)
            try fixture.saveMetadata()
            do { try await fixture.installer().install(); throw AssertionError(description: "wrong release accepted") }
            catch is RuntimeBootstrapError {}
            try expectEqual(fixture.downloadCount + fixture.commands.count, 0)
        }

        await test("changed sealed helper refuses before downloading") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            try Data("replacement helper".utf8).write(to: fixture.helperURL)
            do { try await fixture.installer().install(); throw AssertionError(description: "changed helper accepted") }
            catch is RuntimeBootstrapError {}
            try expectEqual(fixture.downloadCount + fixture.commands.count, 0)
        }

        await test("a linked private bootstrap root is refused before downloading") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let outside = fixture.root.appendingPathComponent("outside")
            try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
            try FileManager.default.createSymbolicLink(
                at: fixture.home.appendingPathComponent(".openrappter"), withDestinationURL: outside
            )
            do { try await fixture.installer().install(); throw AssertionError(description: "linked bootstrap root accepted") }
            catch is RuntimeBootstrapError {}
            try expectEqual(fixture.downloadCount + fixture.commands.count, 0)
            try expectEqual(try FileManager.default.contentsOfDirectory(atPath: outside.path), [])
        }

        await test("changed downloaded Node archive is never handed to tar") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            fixture.corruptDownload = true
            do { try await fixture.installer().install(); throw AssertionError(description: "changed archive accepted") }
            catch is RuntimeBootstrapError {}
            try expectEqual(fixture.commands.count, 0)
            try expectEqual(try fixture.workspaceCount(), 0)
        }

        await test("changed extracted Node binary is never executed") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            fixture.corruptBinary = true
            do { try await fixture.installer().install(); throw AssertionError(description: "changed Node accepted") }
            catch is RuntimeBootstrapError {}
            try expectEqual(fixture.commands, ["/usr/bin/tar"])
            try expectEqual(try fixture.workspaceCount(), 0)
        }

        await test("helper exit alone cannot claim a verified installation") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            fixture.omitInstallation = true
            let installer = fixture.installer()
            do { try await installer.install(); throw AssertionError(description: "missing read-back accepted") }
            catch is RuntimeBootstrapError {}
            try expectEqual(installer.progress?.phase, "error")
        }

        await test("already-authoritative Desktop prevents any installer operation") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            fixture.desktop = true
            fixture.refuseContext = true
            try await fixture.installer().install()
            try expectEqual(fixture.downloadCount + fixture.commands.count, 0)
        }

        await test("Desktop takeover vetoes the activation handshake") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            fixture.takeoverBeforeCommit = true
            do { try await fixture.installer().install(); throw AssertionError(description: "Desktop was replaced") }
            catch is RuntimeBootstrapError {}
            try expectNil(try VerifiedRuntimeInstaller.readInstallation(
                metadata: fixture.decoded(), architecture: fixture.architecture, home: fixture.home
            ))
            try expectEqual(try fixture.workspaceCount(), 0)
        }

        await test("a provisioning veto yields to newly authoritative Desktop without failing onboarding") {
            var desktop = false
            var launches = 0
            let runtime = RuntimePrerequisiteService(dependencies: RuntimePrerequisiteDependencies(
                desktopIsAuthoritative: { desktop },
                localRuntimeAvailable: { false },
                provisionVerifiedRuntime: {
                    desktop = true
                    throw RuntimeBootstrapError.rejected("Desktop takeover")
                },
                startLocalRuntime: { launches += 1 },
                verifyGateway: { selectedDesktop in try expect(selectedDesktop) }
            ))
            try expect(try await runtime.prepare())
            try expectEqual(launches, 0)
        }

        await test("cancellation prevents late helper success and cleans its workspace") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let gate = TestGate()
            fixture.helperGate = gate
            let installer = fixture.installer()
            let task = Task { try await installer.install() }
            await gate.waitUntilEntered()
            task.cancel()
            await gate.open()
            do { try await task.value; throw AssertionError(description: "cancelled install succeeded") }
            catch is CancellationError {}
            try expectEqual(installer.progress?.phase, "cancelled")
            try expectEqual(try fixture.workspaceCount(), 0)
        }

        await test("a corrupt installed Node is never returned as a preferred executable") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            try await fixture.installer().install()
            let location = try VerifiedRuntimeInstaller.readInstallation(
                metadata: fixture.decoded(), architecture: fixture.architecture, home: fixture.home
            )!
            try Data("modified".utf8).write(to: URL(fileURLWithPath: location.nodePath))
            do {
                _ = try VerifiedRuntimeInstaller.readInstallation(
                    metadata: fixture.decoded(), architecture: fixture.architecture, home: fixture.home
                )
                throw AssertionError(description: "corrupted installed binary accepted")
            } catch is RuntimeBootstrapError {}
        }

        await test("bounded process output is written without executing archive paths") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let input = fixture.root.appendingPathComponent("input")
            let output = fixture.root.appendingPathComponent("output")
            let bytes = Data("bounded fixture bytes".utf8)
            try bytes.write(to: input)
            try await BootstrapProcess().run(
                executable: URL(fileURLWithPath: "/bin/cat"), arguments: [input.path], directory: fixture.root,
                outputFile: output, maximumOutput: Int64(bytes.count), timeout: 2
            )
            try expectEqual(try Data(contentsOf: output), bytes)
        }

        await test("bootstrap process output cannot exceed the pinned binary size") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let input = fixture.root.appendingPathComponent("oversized")
            try Data(repeating: 65, count: 100_000).write(to: input)
            do {
                try await BootstrapProcess().run(
                    executable: URL(fileURLWithPath: "/bin/cat"), arguments: [input.path], directory: fixture.root,
                    outputFile: fixture.root.appendingPathComponent("output"), maximumOutput: 8, timeout: 2
                )
                throw AssertionError(description: "oversized output accepted")
            } catch is RuntimeBootstrapError {}
        }

        await test("already-cancelled process invocation executes nothing") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let gate = TestGate()
            let output = fixture.root.appendingPathComponent("must-not-exist")
            let task = Task {
                await gate.wait()
                try await BootstrapProcess().run(
                    executable: URL(fileURLWithPath: "/bin/echo"), arguments: ["not executed"],
                    directory: fixture.root, outputFile: output
                )
            }
            await gate.waitUntilEntered()
            task.cancel()
            await gate.open()
            do { try await task.value; throw AssertionError(description: "cancelled process ran") }
            catch is CancellationError {}
            try expect(!FileManager.default.fileExists(atPath: output.path))
        }

        await test("a stuck bootstrap process is terminated within a bounded deadline") {
            let fixture = try BootstrapFixture()
            defer { fixture.clean() }
            let started = Date()
            do {
                try await BootstrapProcess().run(
                    executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"],
                    directory: fixture.root, timeout: 0.03
                )
                throw AssertionError(description: "stalled process succeeded")
            } catch is RuntimeBootstrapError {}
            try expect(Date().timeIntervalSince(started) < 5)
        }
    }
}
