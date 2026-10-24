import AppKit
import SwiftUI
import DynamicNotchKit
import OpenRappterCore

func log(_ s: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(s)\n"
    FileHandle.standardError.write(line.data(using: .utf8)!)
    if let path = ProcessInfo.processInfo.environment["OPENRAPPTER_EVIDENCE"],
       let h = FileHandle(forWritingAtPath: path) ?? (FileManager.default.createFile(atPath: path, contents: nil) ? FileHandle(forWritingAtPath: path) : nil) {
        h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); h.closeFile()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = CreatureModel()
    var notch: DynamicNotch<Expanded, CompactLeading, CompactTrailing>?
    var mind: MindClient?

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
            await notch.compact()
            log("compact shown")
            if ProcessInfo.processInfo.environment["OPENRAPPTER_DEMO"] == "1" {
                await demo(notch: notch)
            }
        }
    }

    /// Phase 1 walk: find the mind, ask it one thing, show and log the answer. Driven by env so it can be proven from outside.
    func demo(notch: DynamicNotch<Expanded, CompactLeading, CompactTrailing>) async {
        let env = ProcessInfo.processInfo.environment
        let kernelDir = URL(fileURLWithPath: env["OPENRAPPTER_KERNEL_DIR"] ?? FileManager.default.currentDirectoryPath + "/kernel")
        var runner = MindRunner(kernelDir: kernelDir)
        runner.log = { log($0) }

        model.posture = .thinking
        model.line = "Finding my mind…"
        do {
            let (client, health) = try await runner.attachOrLaunch()
            mind = client
            log("mind \(client.baseURL) v\(health.version) model=\(health.model) agents=\(health.agentCount) hungry=\(health.isHungry)")
            if health.isHungry { throw MindError.hungry("health: \(health.status)") }
            let question = env["OPENRAPPTER_DEMO_QUESTION"] ?? "Say hello in under ten words."
            let reply = try await client.chat(question)
            model.posture = .speaking
            model.line = reply.voice.isEmpty ? reply.text : reply.voice
            log("reply text=\(reply.text.debugDescription) voice=\(reply.voice.debugDescription) session=\(reply.sessionId ?? "-")")
            await notch.expand()
            log("speaking")
            try? await Task.sleep(for: .seconds(6))
        } catch MindError.hungry(let why) {
            model.posture = .needsYou
            model.line = "I can't think yet. Sign me in and I'm fed."
            log("hungry \(why)")
            await notch.expand()
            try? await Task.sleep(for: .seconds(6))
        } catch {
            model.posture = .needsYou
            model.line = "I can't find my mind."
            log("error \(error)")
            await notch.expand()
            try? await Task.sleep(for: .seconds(4))
        }
        model.posture = .idle
        model.line = "Hold ⌥ Space and talk to me."
        await notch.compact()
        log("done")
        if env["OPENRAPPTER_DEMO_EXIT"] == "1" { NSApp.terminate(nil) }
    }
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
