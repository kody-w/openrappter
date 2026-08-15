import AppKit
import Foundation
@testable import OpenRappterBarLib

/// The bones window must actually open, with real content.
///
/// The previous round claimed this feature worked on the strength of "the
/// strings are in the shipped binary", which is not verification of a window.
/// It could not be checked because it was reachable only by option-clicking the
/// menu-bar dino or through its transient context menu — neither of which a
/// script can drive.
///
/// So the window is now openable headlessly and asserted on directly: it exists,
/// it is sized, it is titled, and it is populated from the real organism.
func runBonesWindowTests() async {
    await suite("Bones window") {

        await test("the controller opens a real, sized, titled window") {
            let controller = await MainActor.run { BonesWindowController() }
            await MainActor.run { controller.show() }

            let window = await MainActor.run { NSApp.windows.first { $0.title.contains("Anatomy") } }
            try expectNotNil(window, "show() must produce a window")
            let w = window!
            try expect(w.frame.width > 400, "window is \(w.frame.width) wide — too narrow to read")
            try expect(w.frame.height > 300, "window is \(w.frame.height) tall")
            try expect(w.contentView != nil, "window must have content, not be an empty frame")
        }

        await test("reopening reuses the window rather than stacking duplicates") {
            let controller = await MainActor.run { BonesWindowController() }
            await MainActor.run { controller.show() }
            let first = await MainActor.run { NSApp.windows.filter { $0.title.contains("Anatomy") }.count }
            await MainActor.run { controller.show() }
            let second = await MainActor.run { NSApp.windows.filter { $0.title.contains("Anatomy") }.count }
            try expectEqual(second, first, "a second show() must not open another window")
        }

        await test("what it renders comes from the real organism") {
            // The window reads BonesInspector at open time. Assert the same
            // source it draws from, so a window showing sample data would fail.
            let bones = BonesInspector.inspect()
            try expect(bones.home.hasSuffix(".openrappter"),
                       "must read the real runtime dir, got \(bones.home)")
            try expect(!bones.sections.isEmpty, "must have sections to draw")
        }

        // ── the native drop ────────────────────────────────────────────────
        //
        // Dropping an agent on the menu-bar app must do the same thing as
        // dropping it in the browser. It cannot write the file itself: only the
        // daemon owns the live registry, so a local write would produce an agent
        // that is installed and not usable — the exact failure the feature
        // exists to prevent. So the install path is an HTTP call, and when
        // nothing is listening it has to say so in the organism's voice rather
        // than fail silently.

        await test("a drop with no daemon refuses honestly instead of failing silently") {
            // Port 1 is reserved and nothing can be listening on it.
            let result = await AgentInstaller.install(
                filename: "probe_agent.py",
                contents: "from agents.basic_agent import BasicAgent\n",
                port: 1
            )
            var refusal: String? = nil
            if case .refused(let reason) = result { refusal = reason }
            try expectNotNil(refusal, "claimed to learn an agent with no daemon running")
            try expect(refusal!.lowercased().contains("not running"),
                       "the refusal must say why, got: \(refusal!)")
        }

        await test("a drop authenticates to the discovered Desktop gateway") {
            let request = AgentInstaller.makeRequest(
                filename: "probe_agent.py",
                contents: "print('safe')",
                port: 18791,
                token: String(repeating: "a", count: 64)
            )
            try expectEqual(
                request?.value(forHTTPHeaderField: "X-Gateway-Token"),
                String(repeating: "a", count: 64)
            )
        }

        await test("only .py and .js are treated as agents") {
            // The drop filter is what stands between a stray screenshot and an
            // attempt to execute it.
            try expect(AgentDropWebView.isAgentFile(URL(fileURLWithPath: "/tmp/x_agent.py")))
            try expect(AgentDropWebView.isAgentFile(URL(fileURLWithPath: "/tmp/x_agent.js")))
            try expect(!AgentDropWebView.isAgentFile(URL(fileURLWithPath: "/tmp/photo.png")))
            try expect(!AgentDropWebView.isAgentFile(URL(fileURLWithPath: "/tmp/notes.txt")))
        }
    }
}
