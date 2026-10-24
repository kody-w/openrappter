import AVFoundation
import Speech

/// On-device speech to text. Start on key down, stop on key up, get the transcript.
@MainActor
public final class Ears: NSObject {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var latest = ""
    private var finalWaiter: CheckedContinuation<Void, Never>?
    public var onPartial: ((String) -> Void)?
    public private(set) var listening = false

    public static func authorize() async -> Bool {
        let speech: Bool = await withCheckedContinuation { c in
            SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) }
        }
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        return speech && mic
    }

    public var onDevice: Bool { recognizer?.supportsOnDeviceRecognition ?? false }

    public func start() throws {
        guard !listening, let recognizer, recognizer.isAvailable else { throw EarsError.unavailable }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)   // a second tap on the same bus is an uncatchable crash; never leave one behind
        input.installTap(onBus: 0, bufferSize: 1024, format: fmt) { buf, _ in req.append(buf) }
        engine.prepare()
        do { try engine.start() } catch { input.removeTap(onBus: 0); throw error }
        latest = ""
        listening = true
        task = recognizer.recognitionTask(with: req) { [weak self] res, err in
            guard let self else { return }
            Task { @MainActor in
                if let res {
                    self.latest = res.bestTranscription.formattedString
                    self.onPartial?(self.latest)
                    if res.isFinal { self.finalWaiter?.resume(); self.finalWaiter = nil }
                }
                if err != nil { self.finalWaiter?.resume(); self.finalWaiter = nil }
            }
        }
        request = req
    }

    /// Stops the microphone and returns the best transcript, waiting up to 1.5 s for the final pass.
    public func stop() async -> String {
        guard listening else { return "" }
        listening = false
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            finalWaiter = c
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(1500))
                self.finalWaiter?.resume(); self.finalWaiter = nil
            }
        }
        task?.cancel(); task = nil; request = nil
        return latest.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public enum EarsError: Error { case unavailable }
