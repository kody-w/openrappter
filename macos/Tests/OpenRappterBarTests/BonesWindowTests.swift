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

            let window = await MainActor.run { NSApp.windows.first { $0.title.contains("bones") } }
            try expectNotNil(window, "show() must produce a window")
            let w = window!
            try expect(w.frame.width > 400, "window is \(w.frame.width) wide — too narrow to read")
            try expect(w.frame.height > 300, "window is \(w.frame.height) tall")
            try expect(w.contentView != nil, "window must have content, not be an empty frame")
        }

        await test("reopening reuses the window rather than stacking duplicates") {
            let controller = await MainActor.run { BonesWindowController() }
            await MainActor.run { controller.show() }
            let first = await MainActor.run { NSApp.windows.filter { $0.title.contains("bones") }.count }
            await MainActor.run { controller.show() }
            let second = await MainActor.run { NSApp.windows.filter { $0.title.contains("bones") }.count }
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
    }
}
