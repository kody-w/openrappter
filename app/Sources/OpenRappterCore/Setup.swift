import AVFoundation
import Speech
import ApplicationServices
import CoreGraphics
import AppKit

/// The four things the creature needs to be allowed to do. Plain words, in the order we ask.
public enum Power: String, CaseIterable, Identifiable, Sendable {
    case microphone, speech, typing, screen
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .microphone: return "Hear you"
        case .speech: return "Understand you"
        case .typing: return "Type for you"
        case .screen: return "See your screen"
        }
    }

    public var why: String {
        switch self {
        case .microphone: return "I listen only while you hold the key."
        case .speech: return "Your words become text on this Mac, nowhere else."
        case .typing: return "So what you say lands where your cursor is. Turn on OpenRappter in the Accessibility list."
        case .screen: return "So you can ask about what you're looking at. Turn on OpenRappter in the Screen Recording list."
        }
    }

    public var symbol: String {
        switch self {
        case .microphone: return "mic.fill"
        case .speech: return "waveform"
        case .typing: return "keyboard"
        case .screen: return "display"
        }
    }

    var settingsPane: String {
        switch self {
        case .microphone: return "Privacy_Microphone"
        case .speech: return "Privacy_SpeechRecognition"
        case .typing: return "Privacy_Accessibility"
        case .screen: return "Privacy_ScreenCapture"
        }
    }

    public var settingsURL: URL { URL(string: "x-apple.systempreferences:com.apple.preference.security?\(settingsPane)")! }
}

public enum PowerState: String, Sendable {
    case granted, denied, notAsked

    public var label: String {
        switch self {
        case .granted: return "allowed"
        case .denied: return "turned off"
        case .notAsked: return "not yet"
        }
    }
}

public enum Powers {
    /// What the system says right now.
    public static func state(_ p: Power) -> PowerState {
        switch p {
        case .microphone:
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: return .granted
            case .notDetermined: return .notAsked
            default: return .denied
            }
        case .speech:
            switch SFSpeechRecognizer.authorizationStatus() {
            case .authorized: return .granted
            case .notDetermined: return .notAsked
            default: return .denied
            }
        case .typing:
            return AXIsProcessTrusted() ? .granted : .notAsked
        case .screen:
            return CGPreflightScreenCaptureAccess() ? .granted : .notAsked
        }
    }

    /// All four, with an optional override ("typing:notAsked,screen:denied") for screenshots and proofs.
    public static func states(fake: String? = nil) -> [Power: PowerState] {
        var d: [Power: PowerState] = [:]
        for p in Power.allCases { d[p] = state(p) }
        if let fake { d.merge(parseFake(fake)) { $1 } }
        return d
    }

    public static func parseFake(_ s: String) -> [Power: PowerState] {
        var d: [Power: PowerState] = [:]
        for part in s.split(separator: ",") {
            let kv = part.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            guard kv.count == 2, let p = Power(rawValue: kv[0]), let st = PowerState(rawValue: kv[1]) else { continue }
            d[p] = st
        }
        return d
    }

    /// The first power still missing, in asking order.
    public static func next(_ s: [Power: PowerState]) -> Power? {
        Power.allCases.first { s[$0] != .granted }
    }

    public static func allGranted(_ s: [Power: PowerState]) -> Bool { next(s) == nil }

    /// Ask for one power. The first ask for the microphone and speech is the system prompt; after a refusal,
    /// and always for typing and the screen, the right pane in System Settings opens with the app in its list.
    @MainActor
    public static func request(_ p: Power, current: PowerState) async {
        switch (p, current) {
        case (.microphone, .notAsked):
            _ = await AVCaptureDevice.requestAccess(for: .audio)
        case (.speech, .notAsked):
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                SFSpeechRecognizer.requestAuthorization { _ in c.resume() }
            }
        case (.typing, _):
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            NSWorkspace.shared.open(p.settingsURL)
        case (.screen, _):
            if !CGRequestScreenCaptureAccess() { NSWorkspace.shared.open(p.settingsURL) }
        default:
            NSWorkspace.shared.open(p.settingsURL)
        }
    }
}
