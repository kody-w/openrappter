import Foundation

// Minimal test harness — no framework dependencies
var _testsPassed = 0
var _testsFailed = 0
var _currentSuite = ""

func suite(_ name: String, _ block: () throws -> Void) {
    _currentSuite = name
    print("Suite: \(name)")
    do {
        try block()
    } catch {
        _testsFailed += 1
        print("  FAIL (exception): \(error)")
    }
}

func suite(_ name: String, _ block: () async throws -> Void) async {
    _currentSuite = name
    print("Suite: \(name)")
    do {
        try await block()
    } catch {
        _testsFailed += 1
        print("  FAIL (exception): \(error)")
    }
}

func test(_ name: String, _ block: () throws -> Void) {
    do {
        try block()
        _testsPassed += 1
        print("  PASS: \(name)")
    } catch {
        _testsFailed += 1
        print("  FAIL: \(name) — \(error)")
    }
}

func test(_ name: String, _ block: () async throws -> Void) async {
    do {
        try await block()
        _testsPassed += 1
        print("  PASS: \(name)")
    } catch {
        _testsFailed += 1
        print("  FAIL: \(name) — \(error)")
    }
}

struct AssertionError: Error, CustomStringConvertible {
    let description: String
}

func expect(_ condition: Bool, _ message: String = "", file: String = #file, line: Int = #line) throws {
    if !condition {
        let msg = message.isEmpty ? "Assertion failed at \(file):\(line)" : message
        throw AssertionError(description: msg)
    }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ message: String = "", file: String = #file, line: Int = #line) throws {
    if a != b {
        let msg = message.isEmpty ? "Expected \(a) == \(b) at \(file):\(line)" : "\(message): \(a) != \(b)"
        throw AssertionError(description: msg)
    }
}

func expectNil<T>(_ value: T?, _ message: String = "", file: String = #file, line: Int = #line) throws {
    if value != nil {
        let msg = message.isEmpty ? "Expected nil at \(file):\(line)" : message
        throw AssertionError(description: msg)
    }
}

func expectNotNil<T>(_ value: T?, _ message: String = "", file: String = #file, line: Int = #line) throws {
    if value == nil {
        let msg = message.isEmpty ? "Expected non-nil at \(file):\(line)" : message
        throw AssertionError(description: msg)
    }
}

func printResults() {
    print("\n========================================")
    print("Results: \(_testsPassed) passed, \(_testsFailed) failed, \(_testsPassed + _testsFailed) total")
    print("========================================")
}

func exitWithCode() {
    exit(_testsFailed > 0 ? 1 : 0)
}
