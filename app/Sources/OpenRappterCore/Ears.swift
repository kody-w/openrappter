import AVFoundation
import Speech

/// On-device speech to text. Start on key down, stop on key up, get the transcript.
@MainActor
public final class Ears: NSObject {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let capture = MicrophoneCapture()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var latest = ""
    private var finalWaiter: CheckedContinuation<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var generation = 0
    private var finished = false
    private var stopping = false
    public var onPartial: ((String) -> Void)?
    public private(set) var listening = false

    public static func authorize() async -> Bool {
        await permission() == .allowed
    }

    public static func permission() async -> HearingPermission {
        var speech = SFSpeechRecognizer.authorizationStatus()
        if speech == .notDetermined {
            speech = await withCheckedContinuation { c in
                SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
            }
        }
        guard speech == .authorized else { return .speech }
        var mic = AVCaptureDevice.authorizationStatus(for: .audio)
        if mic == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .audio)
            mic = AVCaptureDevice.authorizationStatus(for: .audio)
        }
        return mic == .authorized ? .allowed : .microphone
    }

    public var onDevice: Bool { recognizer?.supportsOnDeviceRecognition ?? false }

    public func start() throws {
        guard !listening, !stopping, let recognizer, recognizer.isAvailable else { throw EarsError.unavailable }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        do { try capture.start { req.append($0) } }
        catch { request = nil; throw error }
        latest = ""
        finished = false
        generation += 1
        let id = generation
        listening = true
        task = recognizer.recognitionTask(with: req) { [weak self] res, err in
            guard let self else { return }
            Task { @MainActor in
                guard self.generation == id else { return }
                if let res {
                    self.latest = res.bestTranscription.formattedString
                    self.onPartial?(self.latest)
                    if res.isFinal { self.finishRecognition() }
                }
                if err != nil { self.finishRecognition() }
            }
        }
        request = req
    }

    /// Stops the microphone and returns the best transcript, waiting up to 1.5 s for the final pass.
    public func stop() async -> String {
        guard listening else { return "" }
        listening = false
        stopping = true
        let id = generation
        capture.stop()
        request?.endAudio()
        if !finished {
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                finalWaiter = c
                timeout = Task { @MainActor in
                    do { try await Task.sleep(for: .milliseconds(1500)) } catch { return }
                    guard self.generation == id else { return }
                    self.finishRecognition()
                }
            }
        }
        guard generation == id else { return "" }
        task?.cancel(); task = nil; request = nil
        stopping = false
        return latest.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func cancel() {
        generation += 1
        capture.stop()
        finishRecognition()
        task?.cancel(); task = nil; request = nil
        listening = false; stopping = false; latest = ""
    }

    private func finishRecognition() {
        finished = true
        timeout?.cancel(); timeout = nil
        let waiter = finalWaiter; finalWaiter = nil
        waiter?.resume()
    }
}

public enum EarsError: Error { case unavailable }
