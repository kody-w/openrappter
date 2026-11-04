import AVFoundation

/// Owns the tap independently of recognition, including the path where starting audio throws.
@MainActor
public final class MicrophoneCapture {
    private let format: () -> (sampleRate: Double, channels: UInt32)
    private let install: (@escaping (AVAudioPCMBuffer) -> Void) throws -> Void
    private let startEngine: () throws -> Void
    private let stopEngine: () -> Void
    private let remove: () -> Void
    public private(set) var hasTap = false

    public init(format: @escaping () -> (Double, UInt32),
                install: @escaping (@escaping (AVAudioPCMBuffer) -> Void) throws -> Void,
                start: @escaping () throws -> Void, stop: @escaping () -> Void,
                remove: @escaping () -> Void) {
        self.format = format; self.install = install; startEngine = start
        stopEngine = stop; self.remove = remove
    }

    public convenience init() {
        let engine = AVAudioEngine()
        var capturedFormat: AVAudioFormat?
        self.init(format: {
            let value = engine.inputNode.outputFormat(forBus: 0)
            capturedFormat = value
            return (value.sampleRate, value.channelCount)
        }, install: { append in
            guard let format = capturedFormat else { throw EarsError.unavailable }
            let input = engine.inputNode
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in append(buffer) }
        }, start: { engine.prepare(); try engine.start() },
        stop: { engine.stop() }, remove: { engine.inputNode.removeTap(onBus: 0) })
    }

    public func start(append: @escaping (AVAudioPCMBuffer) -> Void) throws {
        guard !hasTap else { throw EarsError.unavailable }
        let value = format()
        guard value.sampleRate.isFinite, value.sampleRate > 0, value.channels > 0 else { throw EarsError.unavailable }
        try install(append); hasTap = true
        do { try startEngine() }
        catch { stop(); throw error }
    }

    public func stop() {
        stopEngine()
        if hasTap { remove(); hasTap = false }
    }
}
