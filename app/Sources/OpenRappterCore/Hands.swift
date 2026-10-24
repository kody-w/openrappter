import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision

/// Dictation anywhere: put the text where the cursor is. Needs Accessibility (asked once).
public enum Dictation {
    public static func trusted(prompt: Bool) -> Bool {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
    }

    /// Puts `text` where the cursor is. First through Accessibility (inserts at the selection, no clipboard),
    /// then by clipboard + ⌘V for apps that don't expose their text field (terminals, some Electron apps).
    /// Returns a short word for the log: "ax", "paste", or "denied".
    @MainActor
    @discardableResult
    public static func paste(_ text: String) async -> String {
        let trusted = AXIsProcessTrusted()
        let canPost = CGPreflightPostEventAccess()
        guard trusted || canPost else { return "denied" }
        if trusted, insertViaAccessibility(text) { return "ax" }
        let pb = NSPasteboard.general
        let saved = pb.string(forType: .string)
        pb.clearContents()
        pb.setString(text, forType: .string)
        try? await Task.sleep(for: .milliseconds(150))   // let the user's modifier keys come up
        let src = CGEventSource(stateID: .combinedSessionState)
        let down = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: true)   // v
        let up = CGEvent(keyboardEventSource: src, virtualKey: 9, keyDown: false)
        down?.flags = .maskCommand; up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap); up?.post(tap: .cghidEventTap)
        try? await Task.sleep(for: .milliseconds(600))
        if let saved { pb.clearContents(); pb.setString(saved, forType: .string) }
        return "paste"
    }

    /// Sets the selected text of the focused element to `text`, which inserts it at the cursor.
    static func insertViaAccessibility(_ text: String) -> Bool {
        let system = AXUIElementCreateSystemWide()
        var focused: AnyObject?
        guard AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let el = focused else { return false }
        let element = el as! AXUIElement
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue else { return false }
        return AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFTypeRef) == .success
    }
}

/// Ask about my screen: read the front window's text on the device. Needs Screen Recording (asked once).
public enum Eyes {
    public static func frontWindowText() async throws -> (app: String, text: String) {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let front = NSWorkspace.shared.frontmostApplication
        let mine = ProcessInfo.processInfo.processIdentifier
        guard let win = content.windows.first(where: {
            $0.owningApplication?.processID == front?.processIdentifier && $0.windowLayer == 0 && $0.frame.width > 200
        }) ?? content.windows.first(where: { $0.owningApplication?.processID != mine && $0.windowLayer == 0 && $0.frame.width > 200 })
        else { throw EyesError.noWindow }
        let filter = SCContentFilter(desktopIndependentWindow: win)
        let cfg = SCStreamConfiguration()
        cfg.width = Int(win.frame.width) * 2; cfg.height = Int(win.frame.height) * 2
        cfg.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: image).perform([req])
        let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        return (win.owningApplication?.applicationName ?? "the front app", lines.joined(separator: "\n"))
    }
}

public enum EyesError: Error { case noWindow }
