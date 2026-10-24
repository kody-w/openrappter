import AppKit
import SwiftUI
import DynamicNotchKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = CreatureModel()
    var notch: DynamicNotch<Expanded, CompactLeading, CompactTrailing>?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)   // no Dock icon: the notch is the app
        let model = self.model
        let notch = DynamicNotch(
            hoverBehavior: .all,
            style: .auto,
            expanded: { Expanded(model: model) },
            compactLeading: { CompactLeading(model: model) },
            compactTrailing: { CompactTrailing(model: model) }
        )
        notch.transitionConfiguration.skipIntermediateHides = true
        self.notch = notch
        Task { @MainActor in
            FileHandle.standardError.write("compact shown\n".data(using: .utf8)!)
            // Phase 0 demo loop, driven by env so screenshots can be taken from outside.
            if ProcessInfo.processInfo.environment["OPENRAPPTER_DEMO"] == "1" {
                try? await Task.sleep(for: .seconds(2))
                model.posture = .needsYou
                model.line = "One decision is waiting from this morning."
                FileHandle.standardError.write("posture set\n".data(using: .utf8)!)
                try? await Task.sleep(for: .seconds(2))
                FileHandle.standardError.write("expanding\n".data(using: .utf8)!)
                await notch.expand()
                FileHandle.standardError.write("expanded\n".data(using: .utf8)!)
                try? await Task.sleep(for: .seconds(4))
                model.posture = .idle
                model.line = "Hold ⌥ Space and talk to me."
                await notch.compact()
            }
        }
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
