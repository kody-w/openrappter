import AVFoundation
import Speech

/// On-device speech to text. Start on key down, stop on key up, get the transcript.
@MainActor
public final class Ears: NSObject {
    private let capture: MicrophoneCapture
    private let available: () -> Bool
    private let supportsOnDevice: () -> Bool
    private let recognize: (SFSpeechAudioBufferRecognitionRequest, @escaping (String?, Bool, Error?) -> Void) -> () -> Void
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var cancelRecognition: (() -> Void)?
    private var latest = ""
    private var finalWaiter: CheckedContinuation<Void, Never>?
    private var timeout: Task<Void, Never>?
    private var generation = 0
    private var finished = false
    private var stopping = false
    private var recognitionFailed = false
    public var onPartial: ((String) -> Void)?
    public private(set) var listening = false

    public init(capture: MicrophoneCapture, available: @escaping () -> Bool,
                supportsOnDevice: @escaping () -> Bool = { true },
                recognize: @escaping (SFSpeechAudioBufferRecognitionRequest,
                                      @escaping (String?, Bool, Error?) -> Void) -> () -> Void) {
        self.capture = capture; self.available = available
        self.supportsOnDevice = supportsOnDevice; self.recognize = recognize
        super.init()
    }

    public convenience override init() {
        let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
        self.init(capture: MicrophoneCapture(), available: { recognizer?.isAvailable == true },
                  supportsOnDevice: { recognizer?.supportsOnDeviceRecognition == true },
                  recognize: { request, receive in
            guard let recognizer else { return {} }
            let task = recognizer.recognitionTask(with: request) { result, error in
                receive(result?.bestTranscription.formattedString, result?.isFinal == true, error)
            }
            return { task.cancel() }
        })
    }

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

    public var onDevice: Bool { supportsOnDevice() }

    public func start() throws {
        guard !listening, !stopping else { throw EarsError.unavailable }
        guard available() else { throw EarsError.recognizerUnavailable }
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if supportsOnDevice() { req.requiresOnDeviceRecognition = true }
        do { try capture.start { req.append($0) } }
        catch { request = nil; throw error }
        latest = ""
        finished = false
        recognitionFailed = false
        generation += 1
        let id = generation
        listening = true
        cancelRecognition = recognize(req) { [weak self] text, final, error in
            guard let self else { return }
            Task { @MainActor in
                guard self.generation == id else { return }
                if let text {
                    self.latest = text
                    self.onPartial?(self.latest)
                    if final { self.finishRecognition() }
                }
                if error != nil { self.recognitionFailed = true; self.finishRecognition() }
            }
        }
        request = req
    }

    /// Stops the microphone and returns the best transcript, waiting up to 1.5 s for the final pass.
    public func stop() async -> Result<String, EarsError> {
        guard listening else { return .success("") }
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
        guard generation == id else { return .success("") }
        // Invalidate callbacks before cancellation, which can itself report an error.
        generation += 1
        cancelRecognition?(); cancelRecognition = nil; request = nil
        stopping = false
        return recognitionFailed ? .failure(.recognitionFailed) :
            .success(latest.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public func cancel() {
        generation += 1
        capture.stop()
        finishRecognition()
        cancelRecognition?(); cancelRecognition = nil; request = nil
        listening = false; stopping = false; latest = ""; recognitionFailed = false
    }

    private func finishRecognition() {
        finished = true
        timeout?.cancel(); timeout = nil
        let waiter = finalWaiter; finalWaiter = nil
        waiter?.resume()
    }
}

public enum EarsError: Error, Equatable { case unavailable, recognizerUnavailable, recognitionFailed }
