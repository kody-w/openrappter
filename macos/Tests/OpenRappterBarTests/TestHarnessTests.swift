import Foundation

func runTestHarnessTests() async {
    await suite("Test Harness — cancellation-aware waits") {
        await test("AsyncCollector timeout resumes and removes its waiter") {
            let collector = AsyncCollector<Int>(sleeper: { _ in })

            do {
                _ = try await collector.waitForCount(1, timeout: .seconds(30))
                try expect(false, "waitForCount should throw on timeout")
            } catch is AssertionError {
                // expected
            }

            try expectEqual(await collector.pendingWaiterCount, 0)
            await collector.append(42)
            try expectEqual(await collector.values, [42])
        }

        await test("AsyncCollector cancellation resumes and removes its waiter") {
            let sleeper = ManualSleeper()
            let collector = AsyncCollector<Int>(sleeper: { _ in
                try await sleeper.sleep(1)
            })
            let waiting = Task {
                try await collector.waitForCount(1, timeout: .seconds(30))
            }

            _ = await sleeper.waitForScheduledCount(1)
            waiting.cancel()

            do {
                _ = try await waiting.value
                try expect(false, "cancelled waitForCount should throw")
            } catch is CancellationError {
                // expected
            }

            try expectEqual(await collector.pendingWaiterCount, 0)
            await sleeper.waitForCancellationCount(1)
        }
    }
}
