import Foundation
@testable import OpenRappterBarLib

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
}
