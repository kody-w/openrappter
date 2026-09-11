import Foundation
@testable import OpenRappterBarLib

// MARK: - Fixture Process Helpers

/// Spawn a harmless `/bin/sh` fixture process and wait for a readiness byte
/// written after its `trap` handlers are installed. Backing the fixture with
/// `sleep 5 & wait` (rather than a bare `sleep 5`) prevents the
/// shell from exec-tail-call-optimizing itself away, which would otherwise
/// replace the shell (and its traps) with the `sleep` binary's own (default)
/// signal disposition.
func spawnTrapFixture(_ trapBody: String) async throws -> Process {
    let proc = Process()
    let readyPipe = Pipe()
    proc.executableURL = URL(fileURLWithPath: "/bin/sh")
    proc.arguments = ["-c", "\(trapBody); printf R; sleep 5 & wait"]
    proc.standardOutput = readyPipe.fileHandleForWriting
    proc.standardError = FileHandle.nullDevice
    try proc.run()
    let marker = try readyPipe.fileHandleForReading.read(upToCount: 1)
    try expectEqual(marker, Data("R".utf8), "Fixture should report traps installed")
    return proc
}

@MainActor
func runProcessManagerTests() async {
    suite("Process Manager") {
        test("initial state is stopped") {
            let pm = ProcessManager()
            try expectEqual(pm.state, .stopped)
        }

        test("custom port accepted") {
            let pm = ProcessManager(port: 19999)
            try expectEqual(pm.state, .stopped)
        }

        test("project path resolves to non-empty string") {
            let pm = ProcessManager()
            let path = pm.projectPath
            try expect(!path.isEmpty, "Project path should not be empty")
        }
    }

    await suite("Process Manager (async)") {
        await test("health check fails when no server") {
            let pm = ProcessManager(port: 49999)
            let healthy = await pm.checkHealth()
            try expect(!healthy, "Health check should fail with no server")
        }

        await test("stop is safe when already stopped") {
            let pm = ProcessManager()
            await pm.stop()
            try expectEqual(pm.state, .stopped)
        }
    }

    // MARK: - Node Path Resolution

    await suite("Process Manager — node path resolution") {
        test("firstExistingNodePath never returns /usr/bin/env when nothing is found") {
            let resolved = ProcessManager.firstExistingNodePath(
                candidates: ["/definitely/not/here/node", "/also/missing/node"],
                pathEnv: "/also/not/a/real/dir:/still/not/real",
                fileExists: { _ in false }
            )
            try expectNil(resolved, "Should return nil rather than a bogus/shim path")
        }

        test("firstExistingNodePath returns the first existing candidate") {
            let resolved = ProcessManager.firstExistingNodePath(
                candidates: ["/opt/first/node", "/opt/second/node"],
                pathEnv: nil,
                fileExists: { $0 == "/opt/second/node" }
            )
            try expectEqual(resolved, "/opt/second/node")
        }

        test("firstExistingNodePath falls back to searching PATH directories") {
            let resolved = ProcessManager.firstExistingNodePath(
                candidates: ["/opt/missing/node"],
                pathEnv: "/usr/local/bin:/opt/homebrew/bin:/custom/bin",
                fileExists: { $0 == "/custom/bin/node" }
            )
            try expectEqual(resolved, "/custom/bin/node")
        }

        test("resolveNodePath on a real instance never returns /usr/bin/env") {
            let pm = ProcessManager()
            if let resolved = pm.resolveNodePath() {
                try expect(resolved != "/usr/bin/env", "Must never resolve to the env shim")
                try expect(FileManager.default.fileExists(atPath: resolved), "Resolved path should actually exist")
            }
            // If nil, that's the documented "clear error" contract for a
            // machine with no discoverable node — also acceptable.
        }

        await test("start() throws a clear nodeNotFound error instead of using /usr/bin/env") {
            let pm = ProcessManager(port: 49998, nodePathResolver: { nil })
            do {
                try await pm.start()
                try expect(false, "start() should throw when node cannot be resolved")
            } catch ProcessManagerError.nodeNotFound {
                // expected
            } catch {
                try expect(false, "Expected .nodeNotFound, got \(error)")
            }
            try expectEqual(pm.state, .stopped)
        }
    }

    // MARK: - Graceful Shutdown Escalation (fake child processes)

    await suite("Process Manager — stop escalation by exact PID") {
        await test("stopProcess succeeds at the SIGINT stage when the process cooperates") {
            let pm = ProcessManager()
            let proc = try await spawnTrapFixture("trap 'exit 0' INT")

            await pm.stopProcess(proc, sigintTimeout: 1, sigtermTimeout: 1, sigkillTimeout: 1)

            try expect(!proc.isRunning, "Process should have exited after SIGINT")
        }

        await test("stopProcess escalates to SIGTERM when SIGINT is ignored") {
            let pm = ProcessManager()
            let proc = try await spawnTrapFixture("trap '' INT; trap 'exit 0' TERM")

            await pm.stopProcess(proc, sigintTimeout: 0.4, sigtermTimeout: 1, sigkillTimeout: 1)

            try expect(!proc.isRunning, "Process should have exited after escalating to SIGTERM")
        }

        await test("stopProcess escalates to SIGKILL by the exact managed PID when both signals are ignored") {
            let pm = ProcessManager()
            let proc = try await spawnTrapFixture("trap '' INT TERM")
            let pid = proc.processIdentifier

            await pm.stopProcess(proc, sigintTimeout: 0.3, sigtermTimeout: 0.3, sigkillTimeout: 1)

            try expect(!proc.isRunning, "Process should have been killed after escalating to SIGKILL")
            // Confirm it was this exact PID that died (never a name-based kill
            // of some unrelated process) — signalling a dead pid with signal 0
            // fails with ESRCH.
            try expect(kill(pid, 0) != 0, "The exact managed PID should no longer exist")
        }

        await test("stop() coalesces concurrent calls instead of double-signaling") {
            let stopGate = TestGate()
            let requests = AsyncCollector<ProcessManager.LifecycleRequest>()
            let completions = AsyncCollector<ProcessManager.LifecycleResult>()
            let pm = ProcessManager(
                processStopper: { proc in
                    await stopGate.wait()
                    proc.interrupt()
                    proc.waitUntilExit()
                },
                lifecycleObserver: { request in
                    Task { await requests.append(request) }
                }
            )
            let proc = try await spawnTrapFixture("trap 'exit 0' INT")
            pm.adoptForTesting(proc)

            let first = Task {
                let result = await pm.stop()
                await completions.append(result)
                return result
            }
            await stopGate.waitUntilEntered()
            let second = Task {
                let result = await pm.stop()
                await completions.append(result)
                return result
            }
            _ = try await requests.waitForCount(2)
            try expect(await completions.values.isEmpty, "duplicate stop returned before termination")
            await stopGate.open()
            let results = await (first.value, second.value)

            try expectEqual(pm.state, .stopped)
            try expectEqual(results.0, .stopped)
            try expectEqual(results.1, .stopped)
            try expect(!proc.isRunning, "Adopted process should have been stopped exactly once")
        }
    }

    // MARK: - Owned vs. External Process Ownership

    await suite("Process Manager — owned vs. external processes") {
        await test("stop() supersedes a start still awaiting gateway detection") {
            let gate = TestGate()
            var nodeResolverCalls = 0
            let pm = ProcessManager(
                nodePathResolver: {
                    nodeResolverCalls += 1
                    return "/bin/sh"
                },
                gatewayDetector: {
                    await gate.wait()
                    return false
                }
            )

            let startTask = Task { try await pm.start() }
            await gate.waitUntilEntered()
            try expectEqual(pm.state, .starting)

            let stopTask = Task { await pm.stop() }
            await gate.open()
            let startResult = try await startTask.value
            let stopResult = await stopTask.value

            try expectEqual(startResult, .superseded)
            try expectEqual(stopResult, .stopped)
            try expectEqual(pm.state, .stopped)
            try expectEqual(nodeResolverCalls, 0)
        }

        await test("duplicate start() calls join the in-flight detection task") {
            let gate = TestGate()
            let requests = AsyncCollector<ProcessManager.LifecycleRequest>()
            let completions = AsyncCollector<ProcessManager.LifecycleResult>()
            var detectorCalls = 0
            let pm = ProcessManager(
                gatewayDetector: {
                    detectorCalls += 1
                    await gate.wait()
                    return true
                },
                lifecycleObserver: { request in
                    Task { await requests.append(request) }
                }
            )

            let first = Task {
                let result = try await pm.start()
                await completions.append(result)
                return result
            }
            await gate.waitUntilEntered()
            let second = Task {
                let result = try await pm.start()
                await completions.append(result)
                return result
            }
            _ = try await requests.waitForCount(2)
            try expect(await completions.values.isEmpty, "duplicate start returned before detection completed")
            await gate.open()
            let results = try await (first.value, second.value)

            try expectEqual(detectorCalls, 1)
            try expectEqual(results.0, .alreadyRunning)
            try expectEqual(results.1, .alreadyRunning)
            try expectEqual(pm.state, .running)
        }

        await test("stop() leaves an externally-detected gateway's state consistent without owning a process") {
            let pm = ProcessManager()
            pm.simulateExternallyDetectedGateway()
            try expectEqual(pm.state, .running)

            await pm.stop()

            // No owned `Process` ever existed for this instance, so stop()
            // must take the no-op guard path (never attempts to signal
            // anything) and still leave state consistent.
            try expectEqual(pm.state, .stopped)
        }

        await test("stop() terminates only a process this instance actually adopted") {
            let pm = ProcessManager()
            let proc = try await spawnTrapFixture("trap 'exit 0' INT")
            pm.adoptForTesting(proc)

            await pm.stop()

            try expectEqual(pm.state, .stopped)
            try expect(!proc.isRunning, "The adopted/owned process should be stopped")
        }
    }

    // MARK: - Lightweight Integration Test

    await suite("Process Manager — fixture process integration") {
        await test("start()-style spawn and stop() round-trip via a harmless fixture process") {
            // Exercises the same Process lifecycle plumbing `start()`/`stop()`
            // use (spawn, adopt, graceful signal, confirm exit) end-to-end
            // against a real (harmless) child process, without depending on
            // a Node install or a built gateway bundle.
            let pm = ProcessManager()
            let proc = try await spawnTrapFixture("trap 'exit 0' INT TERM")

            try expect(proc.isRunning, "Fixture process should be running before stop")
            pm.adoptForTesting(proc)
            try expectEqual(pm.state, .running)

            await pm.stop()

            try expectEqual(pm.state, .stopped)
            try expect(!proc.isRunning, "Fixture process should have exited")
        }
    }
}
