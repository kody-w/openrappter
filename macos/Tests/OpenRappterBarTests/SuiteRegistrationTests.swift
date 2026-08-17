import Foundation

/// Every suite in this directory must actually run.
///
/// The Bar's tests are not XCTest, so nothing discovers them. `main.swift`
/// calls each `run…Tests()` by hand. A new suite can therefore compile, be
/// committed, pass review and never execute a single assertion — and nothing
/// would look wrong, because the only symptom is a total that failed to go up,
/// and no one reads the total.
///
/// That is the failure the TypeScript inert-test guard was built for (#215,
/// #217): a test that cannot fail is worse than no test, because it is counted
/// as coverage. TypeScript, the UI and Python are all protected against some
/// form of it. This runtime was not, which made it the one place where the
/// oversight could recur silently.
///
/// The registration currently matches. This pins it so it keeps matching.
func runSuiteRegistrationTests() throws {
    suite("Suite registration") {

        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()

        func mainBody() throws -> String {
            try String(
                contentsOf: testsDirectory.appendingPathComponent("main.swift"),
                encoding: .utf8
            )
        }

        /// Names of `func run…Tests(` declared across every file but main.swift.
        func definedSuites() throws -> [String] {
            var names: Set<String> = []
            let files = try FileManager.default.contentsOfDirectory(
                at: testsDirectory,
                includingPropertiesForKeys: nil
            )
            for url in files
            where url.pathExtension == "swift" && url.lastPathComponent != "main.swift" {
                let body = try String(contentsOf: url, encoding: .utf8)
                for line in body.split(separator: "\n") {
                    guard line.hasPrefix("func run"),
                          line.contains("Tests("),
                          let open = line.firstIndex(of: "(")
                    else { continue }
                    let start = line.index(line.startIndex, offsetBy: "func ".count)
                    names.insert(String(line[start..<open]))
                }
            }
            return names.sorted()
        }

        /// A suite is registered when main.swift names it followed by its call
        /// parenthesis, whatever `try`/`await` prefix that call happens to carry.
        func unregistered(among names: [String], in main: String) -> [String] {
            names.filter { !main.contains("\($0)(") }.sorted()
        }

        test("every suite defined here is called by main.swift") {
            let missing = try unregistered(among: definedSuites(), in: mainBody())
            try expect(
                missing.isEmpty,
                "defined but never called from main.swift, so it never runs: "
                    + missing.joined(separator: ", ")
            )
        }

        test("finds the suites to check") {
            // Without this the guard passes just as happily on an empty
            // directory, which is the exact shape of failure it is meant to
            // catch.
            let found = try definedSuites().count
            try expect(found >= 15, "expected at least 15 suites, found \(found)")
        }

        test("would notice a suite that main.swift never calls") {
            // Negative control over the detector itself, not over the tree: a
            // name that is deliberately absent must be reported as missing.
            let main = try mainBody()
            let probe = unregistered(
                among: ["runAppConstantsTests", "runSuiteNobodyRegisteredTests"],
                in: main
            )
            try expectEqual(probe, ["runSuiteNobodyRegisteredTests"])
        }
    }
}
