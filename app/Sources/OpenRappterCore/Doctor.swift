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

    public static func check(env: [String: String] = ProcessInfo.processInfo.environment) async -> DoctorReport {
        let mind = await checkMind(address: env["OPENRAPPTER_MIND"] ?? "http://127.0.0.1:18790")
        let home = env["HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser
        let checks = [
            mind,
            microphoneCheck(AVCaptureDevice.authorizationStatus(for: .audio)),
            speechCheck(SFSpeechRecognizer.authorizationStatus()),
            loginItemCheck(at: loginItemURL(home: home)),
        ]
        let next: String
        if mind.status == "unreachable" {
            next = "Open OpenRappter to help me find my mind."
        } else if mind.status == "hungry" {
            next = "Choose Sign in to my mind in OpenRappter to feed me."
        } else if checks[1].status != "ok" || checks[2].status != "ok" {
            next = "Allow OpenRappter to use the microphone and speech recognition in System Settings."
        } else if checks[3].status != "ok" {
            next = "Open OpenRappter from your Applications folder so I can return when you sign in."
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

    static func loginItemCheck(at url: URL) -> DoctorCheck {
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
