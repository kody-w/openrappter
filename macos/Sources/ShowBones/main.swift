import AppKit
import OpenRappterBarLib

/// Open the bones window on its own.
///
/// Exists so the window is verifiable. It was previously reachable only by
/// option-clicking the menu-bar dino or through its transient context menu,
/// neither of which a script can drive — so it could never be screenshotted or
/// regression-tested. Something that cannot be opened by a machine cannot be
/// checked, and that is a design defect rather than a testing inconvenience.
///
///     swift run ShowBones
///
let app = NSApplication.shared
app.setActivationPolicy(.regular)

final class ProbeDelegate: NSObject, NSApplicationDelegate {
    private var controller: BonesWindowController?
    func applicationDidFinishLaunching(_ notification: Notification) {
        MainActor.assumeIsolated {
            let c = BonesWindowController()
            controller = c
            c.show()
            NSApp.activate(ignoringOtherApps: true)
        }
    }
}

let delegate = ProbeDelegate()
app.delegate = delegate
app.run()
