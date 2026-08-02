import Foundation
@testable import OpenRappterBarLib

/// The bones window must show what is actually there.
///
/// A mock inventory would be worse than none: it would tell you an agent exists
/// when it does not, and the only reason to open this window is to find out
/// what is really installed. So these tests build a real directory on disk and
/// assert the inspector reports it — including the awkward parts.
func runBonesInspectorTests() async {
    await suite("Bones inspector") {

        func makeHome() throws -> String {
            let home = NSTemporaryDirectory() + "bones-\(UUID().uuidString)"
            try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
            return home
        }

        await test("reads real agent files from disk") {
            let home = try makeHome()
            defer { try? FileManager.default.removeItem(atPath: home) }
            let agents = home + "/agents"
            try FileManager.default.createDirectory(atPath: agents, withIntermediateDirectories: true)
            try "export function createAgent() {}".write(
                toFile: agents + "/morning_brief_agent.js", atomically: true, encoding: .utf8)

            let bones = BonesInspector.inspect(home: home)
            let section = bones.sections.first { $0.id == "agents" }
            try expectNotNil(section)
            try expectEqual(section!.items.count, 1)
            try expectEqual(section!.items[0].name, "morning_brief_agent.js")
            try expect(section!.items[0].bytes > 0, "a real file should report a real size")
            try expect(!section!.items[0].missing)
        }

        // The load-bearing honesty test. An empty section must say it is empty
        // rather than showing something plausible.
        await test("an empty organism reports nothing rather than inventing files") {
            let home = try makeHome()
            defer { try? FileManager.default.removeItem(atPath: home) }

            let bones = BonesInspector.inspect(home: home)
            let agents = bones.sections.first { $0.id == "agents" }!
            try expectEqual(agents.items.count, 0)
            try expect(!agents.emptyNote.isEmpty, "an empty section must explain itself")
            try expectEqual(bones.totalFiles, 0)
        }

        await test("a missing identity file is shown as missing, not omitted") {
            let home = try makeHome()
            defer { try? FileManager.default.removeItem(atPath: home) }
            try "I am the twin.".write(
                toFile: home + "/SOUL.md", atomically: true, encoding: .utf8)

            let identity = BonesInspector.inspect(home: home).sections.first { $0.id == "identity" }!
            let soul = identity.items.first { $0.name == "SOUL.md" }
            let user = identity.items.first { $0.name == "USER.md" }
            try expectNotNil(soul)
            try expect(!soul!.missing, "SOUL.md exists and should read as present")
            try expectNotNil(user, "USER.md must still be listed so its absence is visible")
            try expect(user!.missing, "USER.md does not exist and must say so")
        }

        await test("finds skills only when they carry a SKILL.md") {
            let home = try makeHome()
            defer { try? FileManager.default.removeItem(atPath: home) }
            let real = home + "/skills/pdf"
            let bogus = home + "/skills/not-a-skill"
            try FileManager.default.createDirectory(atPath: real, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(atPath: bogus, withIntermediateDirectories: true)
            try "# PDF".write(toFile: real + "/SKILL.md", atomically: true, encoding: .utf8)

            let skills = BonesInspector.inspect(home: home).sections.first { $0.id == "skills" }!
            try expectEqual(skills.items.count, 1)
            try expectEqual(skills.items[0].name, "pdf")
        }

        // The GOD boundary. `.env` may be counted, never opened.
        await test("credentials are listed but never openable") {
            try expect(BonesInspector.isSecret("/x/.env"))
            try expect(BonesInspector.isSecret("/x/.env.local"))
            try expect(BonesInspector.isSecret("/x/github_token.json"))
            try expect(BonesInspector.isSecret("/x/credentials.json"))
            try expect(!BonesInspector.isSecret("/x/morning_brief_agent.js"),
                       "ordinary agent files must stay openable")
            try expect(!BonesInspector.isSecret("/x/SOUL.md"))
        }

        await test("sizes are reported in human units") {
            let home = try makeHome()
            defer { try? FileManager.default.removeItem(atPath: home) }
            try String(repeating: "x", count: 2048).write(
                toFile: home + "/memory.json", atomically: true, encoding: .utf8)

            let memory = BonesInspector.inspect(home: home).sections.first { $0.id == "memory" }!
            let mem = memory.items.first { $0.name == "memory.json" }!
            try expectEqual(mem.sizeLabel, "2.0 KB")
        }

        await test("every section explains what it is for") {
            let bones = BonesInspector.inspect(home: try makeHome())
            for section in bones.sections {
                try expect(!section.blurb.isEmpty,
                           "\(section.title) should say what that part of the organism does")
            }
        }
    }
}
