import AVFoundation
import Foundation
import Speech

public struct DoctorCheck: Codable, Sendable, Equatable {
    public let name: String
    public let status: String
    public let words: String
}

public struct DoctorReport: Codable, Sendable {
    public let checks: [DoctorCheck]
    public let next: String

    public func output(json: Bool) throws -> String {
        if json {
            return String(decoding: try JSONEncoder().encode(self), as: UTF8.self)
        }
        return (checks.map { "\($0.name): \($0.words)" } + ["Next: \(next)"]).joined(separator: "\n")
    }
}

/// Observations only: no permission prompts, app startup, or service changes.
public enum Doctor {
    public static let loginItemLabel = "com.openrappter.app"

    public static func loginItemURL(home: URL) -> URL {
        home.appendingPathComponent("Library/LaunchAgents/\(loginItemLabel).plist")
    }

    public static func check(env: [String: String] = ProcessInfo.processInfo.environment,
                             microphone: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .audio),
                             speech: SFSpeechRecognizerAuthorizationStatus = SFSpeechRecognizer.authorizationStatus()) async -> DoctorReport {
        let mind = await checkMind(address: env["OPENRAPPTER_MIND"] ?? "http://127.0.0.1:18790")
        let home = env["HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser
        let checks = [
            mind,
            microphoneCheck(microphone),
            speechCheck(speech),
            loginItemCheck(at: loginItemURL(home: home), stopped:
                StartupPreference(home: home).isStopped || env["OPENRAPPTER_NO_LOGIN_ITEM"] != nil),
        ]
        return report(checks)
    }

    static func report(_ checks: [DoctorCheck]) -> DoctorReport {
        let mind = checks[0]
        let permissions = checks[1...2].map(\.status)
        let next: String
        if mind.status == "unreachable" {
            next = "Open OpenRappter to help me find my mind."
        } else if mind.status == "hungry" {
            next = "Choose Sign in to my mind in OpenRappter to feed me."
        } else if mind.status == "no-copilot" {
            next = "Enable Copilot for that GitHub account, or use one that has it, then choose Sign in to my mind."
        } else if permissions.contains("restricted") {
            next = "This Mac's rules block permission to hear you; ask whoever manages it."
        } else if permissions.contains("blocked") {
            next = "Allow OpenRappter to use the microphone and speech recognition in System Settings."
        } else if permissions.contains("needed") {
            next = "Hold Option and Space once in OpenRappter and allow the permission prompts."
        } else if permissions.contains("unknown") {
            next = "Open OpenRappter and hold Option and Space to check permission to hear you."
        } else if !["ok", "off-by-choice"].contains(checks[3].status) {
            next = "Everything works. To have me return each time this Mac starts, open OpenRappter from your Applications folder once."
        } else {
            next = "Everything is ready; hold Option and Space to talk to me."
        }
        return DoctorReport(checks: checks, next: next)
    }

    static func checkMind(address: String) async -> DoctorCheck {
        guard let url = URL(string: address), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil else {
            return DoctorCheck(name: "mind", status: "unreachable", words: "I can't find my mind right now.")
        }
        let client = MindClient(baseURL: url, timeout: 5)
        // Bound the entire read, including a mind that accepts a connection but never finishes answering.
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration)
        var boundedClient = client
        boundedClient.session = session
        defer { session.invalidateAndCancel() }
        do {
            let health = try await boundedClient.health()
            if health.copilot == "no_access" {
                return DoctorCheck(name: "mind", status: "no-copilot", words: "You're signed in, but that GitHub account has no Copilot.")
            }
            if health.isHungry {
                return DoctorCheck(name: "mind", status: "hungry", words: "My mind is here, but I need you to sign in before I can think.")
            }
            guard health.status == "ok" else {
                return DoctorCheck(name: "mind", status: "unreachable", words: "My mind isn't ready to answer right now.")
            }
            return DoctorCheck(name: "mind", status: "ok", words: "My mind is fed and ready to think.")
        } catch {
            return DoctorCheck(name: "mind", status: "unreachable", words: "I can't reach my mind right now.")
        }
    }

    static func microphoneCheck(_ status: AVAuthorizationStatus) -> DoctorCheck {
        switch status {
        case .authorized:
            return DoctorCheck(name: "microphone", status: "ok", words: "I'm allowed to hear you through the microphone.")
        case .notDetermined:
            return DoctorCheck(name: "microphone", status: "needed", words: "I haven't asked to use your microphone yet.")
        case .denied:
            return DoctorCheck(name: "microphone", status: "blocked", words: "Microphone access is off for OpenRappter in System Settings.")
        case .restricted:
            return DoctorCheck(name: "microphone", status: "restricted", words: "This Mac's rules don't allow me to use the microphone.")
        @unknown default:
            return DoctorCheck(name: "microphone", status: "unknown", words: "I couldn't tell whether I'm allowed to use the microphone.")
        }
    }

    static func speechCheck(_ status: SFSpeechRecognizerAuthorizationStatus) -> DoctorCheck {
        switch status {
        case .authorized:
            return DoctorCheck(name: "speech", status: "ok", words: "I'm allowed to turn your speech into words.")
        case .notDetermined:
            return DoctorCheck(name: "speech", status: "needed", words: "I haven't asked to recognize your speech yet.")
        case .denied:
            return DoctorCheck(name: "speech", status: "blocked", words: "Speech recognition is off for OpenRappter in System Settings.")
        case .restricted:
            return DoctorCheck(name: "speech", status: "restricted", words: "This Mac's rules don't allow me to recognize speech.")
        @unknown default:
            return DoctorCheck(name: "speech", status: "unknown", words: "I couldn't tell whether I'm allowed to recognize speech.")
        }
    }

    static func loginItemCheck(at url: URL, stopped: Bool = false) -> DoctorCheck {
        if stopped {
            return DoctorCheck(name: "login-item", status: "off-by-choice", words: "You've told me not to start on my own.")
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
            return DoctorCheck(name: "login-item", status: "missing", words: "I'm not set to open when you sign in to this Mac.")
        }
        do {
            let data = try Data(contentsOf: url)
            let object = try PropertyListSerialization.propertyList(from: data, options: [], format: nil)
            guard let item = object as? [String: Any],
                  item["Label"] as? String == loginItemLabel,
                  item["RunAtLoad"] as? Bool == true,
                  item["KeepAlive"] as? Bool == true,
                  let executable = (item["ProgramArguments"] as? [String])?.first,
                  FileManager.default.isExecutableFile(atPath: executable) else {
                return DoctorCheck(name: "login-item", status: "needs-attention", words: "My sign-in setting needs attention before I can return on my own.")
            }
            return DoctorCheck(name: "login-item", status: "ok", words: "I'm set to open when you sign in to this Mac.")
        } catch {
            return DoctorCheck(name: "login-item", status: "unreadable", words: "I couldn't read my setting for opening when you sign in.")
        }
    }
}
