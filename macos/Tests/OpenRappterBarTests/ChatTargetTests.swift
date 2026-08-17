import Foundation
@testable import OpenRappterBarLib

/// Choosing which brain the Bar talks to.
///
/// The web dashboard got this selector first. The Bar calls the same
/// `chat.send` and had no way to choose, so the same feature was present in one
/// client of two — the narrowness #199, #200, #201 and #217 each had to correct
/// in an earlier guard.
///
/// What has to hold: the target reaches the wire on every send, an unrecognised
/// stored value cannot strand the Bar, and the choice survives a relaunch. The
/// two brains return the same §2.4 envelope, so an answer from the wrong one
/// does not look wrong — none of these failures would be visible.
func runChatTargetTests() async {
    await suite("Chat target") {

        func scratchDefaults() throws -> UserDefaults {
            let name = "chat-target-\(UUID().uuidString)"
            guard let defaults = UserDefaults(suiteName: name) else {
                throw AssertionError(description: "could not open a scratch defaults suite")
            }
            return defaults
        }

        await test("defaults to the local runtime") {
            let defaults = try scratchDefaults()
            try expectEqual(ChatTarget.restored(from: defaults), .openrappter)
        }

        await test("offers both brains, each with a label") {
            // Anti-vacuity: an empty case list would make the picker render
            // nothing and every assertion about it pass.
            try expectEqual(ChatTarget.allCases.count, 2)
            for target in ChatTarget.allCases {
                try expect(!target.label.isEmpty, "\(target) needs a label for the picker")
            }
        }

        await test("round-trips through defaults") {
            let defaults = try scratchDefaults()
            ChatTarget.brainstem.remember(in: defaults)
            try expectEqual(ChatTarget.restored(from: defaults), .brainstem)
        }

        await test("a stored value that is not a brain falls back rather than throwing") {
            // A hand-edited defaults file must not stop the Bar chatting, and
            // the local runtime is the safe brain to land on.
            let defaults = try scratchDefaults()
            defaults.set("something-else", forKey: ChatTarget.defaultsKey)
            try expectEqual(ChatTarget.restored(from: defaults), .openrappter)
        }

        await test("the wire value is the gateway's spelling, not the label") {
            // The gateway refuses an unknown target outright, so a renamed case
            // would fail every brainstem turn.
            try expectEqual(ChatTarget.openrappter.rawValue, "openrappter")
            try expectEqual(ChatTarget.brainstem.rawValue, "brainstem")
        }

        await test("sendChat puts the target on the wire, including the default") {
            // Always sent, even for the default: a gateway that ever changes its
            // own default must not be able to move the conversation silently.
            let source = try String(
                contentsOf: URL(fileURLWithPath: #filePath)
                    .deletingLastPathComponent()
                    .deletingLastPathComponent()
                    .deletingLastPathComponent()
                    .appendingPathComponent("Sources/OpenRappterBar/Services/RpcClient.swift"),
                encoding: .utf8
            )
            try expect(
                source.contains("\"target\": AnyCodable(target.rawValue)"),
                "sendChat must send the selected target"
            )
        }
    }
}
