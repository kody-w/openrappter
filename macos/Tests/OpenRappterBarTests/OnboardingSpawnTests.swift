import Foundation
@testable import OpenRappterBarLib

/// Onboarding must not die on a spawn that could never have worked.
///
/// The defect this covers: the GitHub auth step ran `dist/index.js` as a process
/// executable. That file is mode 0644 with no shebang — an ESM module, not a
/// program — so `Process.run()` threw `NSCocoaErrorDomain Code=4`, which
/// Foundation renders as `The file "index.js" doesn't exist.` The file was on
/// disk the entire time.
///
/// Two things are asserted here, because fixing only the first would leave the
/// trap armed for the next caller:
///
///  1. The spawn now succeeds, because the script is run through `node`.
///  2. When a spawn *does* fail this way, the error says what is actually
///     wrong instead of repeating Foundation's untrue message.
/// Foundation localises with typographic quotes; compare on a flattened form.
private func normalizeQuotes(_ s: String) -> String {
    s.replacingOccurrences(of: "\u{2019}", with: "'")
        .replacingOccurrences(of: "\u{201C}", with: "\"")
        .replacingOccurrences(of: "\u{201D}", with: "\"")
}

func runOnboardingSpawnTests() async {
    await suite("Onboarding spawn") {

        // Reproduce the original failure directly against Foundation, so this
        // test documents the real behaviour rather than trusting the write-up.
        await test("Foundation reports a non-executable file as 'doesn't exist'") {
            let tmp = FileManager.default.temporaryDirectory
                .appendingPathComponent("openrappter-spawn-\(UUID().uuidString).js")
            try "export const x = 1;\n".write(to: tmp, atomically: true, encoding: .utf8)
            defer { try? FileManager.default.removeItem(at: tmp) }

            // 0644 — present, readable, not executable. Exactly dist/index.js.
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o644], ofItemAtPath: tmp.path)
            try expect(FileManager.default.fileExists(atPath: tmp.path),
                       "precondition: the file must exist")
            try expect(!FileManager.default.isExecutableFile(atPath: tmp.path),
                       "precondition: the file must not be executable")

            let process = Process()
            process.executableURL = tmp
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice

            var message: String?
            do {
                try process.run()
                process.waitUntilExit()
            } catch {
                message = error.localizedDescription
            }

            try expectNotNil(message, "spawning a 0644 script must fail")
            // The lie, pinned. Foundation types this with a curly apostrophe
            // (U+2019) and curly double quotes, so a literal ASCII comparison
            // silently never matches — normalise before asserting.
            let said = normalizeQuotes(message!)
            try expect(said.contains("doesn't exist") || said.contains("does not exist"),
                       "expected Foundation's misleading message, got: \(message!)")
        }

        await test("ShellError says what is actually wrong") {
            let err = ShellError.notExecutable("/tmp/index.js", "no execute permission")
            let text = err.errorDescription ?? ""
            try expect(text.contains("Cannot execute"),
                       "error should name the real problem, got: \(text)")
            try expect(!normalizeQuotes(text).contains("doesn't exist"),
                       "error must not repeat Foundation's lie, got: \(text)")
        }

        await test("ShellError distinguishes genuinely missing from not-executable") {
            let missing = ShellError.notFound("/tmp/nope.js").errorDescription ?? ""
            try expect(missing.contains("No such file"),
                       "a truly absent file should say so, got: \(missing)")
        }

        // The positive case: the same module runs fine when handed to node.
        await test("the CLI entrypoint runs when launched through node") {
            let home = NSHomeDirectory() + "/.openrappter"
            let index = home + "/typescript/dist/index.js"
            guard FileManager.default.fileExists(atPath: index) else {
                // The runtime home is not present on every machine (CI). Skipping
                // is honest; asserting against a file that isn't there would be
                // testing the environment, not the fix.
                return
            }

            let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
                .first { FileManager.default.isExecutableFile(atPath: $0) }
            guard let nodePath = node else { return }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: nodePath)
            process.arguments = [index, "--help"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()

            try expect(process.terminationStatus == 0,
                       "node should run the module, exit was \(process.terminationStatus)")
            try expect(!data.isEmpty, "`--help` should print something")
        }
    }
}
