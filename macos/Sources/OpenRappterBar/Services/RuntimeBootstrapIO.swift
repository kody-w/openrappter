import CryptoKit
import Darwin
import Foundation

enum RuntimeBootstrapError: LocalizedError {
    case rejected(String)
    case downloadFailed
    case timedOut
    case processFailed

    var errorDescription: String? {
        switch self {
        case .rejected(let reason): return reason
        case .downloadFailed: return "The verified runtime download could not finish. Check your connection and retry."
        case .timedOut: return "The verified runtime installer timed out. Nothing unverified was activated; retry setup."
        case .processFailed: return "The verified runtime installer could not finish. Check the setup status and retry."
        }
    }
}

struct PinnedRuntimeArtifact: Codable, Equatable {
    let url: String
    let sha256: String
    let size: Int64

    func validate(maximumSize: Int64 = 256 * 1024 * 1024) throws {
        guard size > 0, size <= maximumSize,
              sha256.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
              let parsed = URL(string: url), parsed.scheme == "https",
              parsed.user == nil, parsed.password == nil, parsed.port == nil,
              parsed.query == nil, parsed.fragment == nil else {
            throw RuntimeBootstrapError.rejected("The signed runtime download identity is invalid.")
        }
    }
}

enum BootstrapFileIntegrity {
    static func digest(_ file: URL, expectedSize: Int64? = nil) throws -> String {
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw RuntimeBootstrapError.rejected("A runtime artifact is not a regular file.")
        }
        if let expectedSize,
           (attributes[.size] as? NSNumber)?.int64Value != expectedSize {
            throw RuntimeBootstrapError.rejected("Runtime download size did not match its signed identity.")
        }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            hash.update(data: chunk)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func verify(_ file: URL, sha256: String, size: Int64) throws {
        guard try digest(file, expectedSize: size) == sha256 else {
            throw RuntimeBootstrapError.rejected("Runtime bytes did not match their signed SHA-256. Nothing was executed.")
        }
    }

    static func createExclusiveFile(_ url: URL) throws -> FileHandle {
        let descriptor = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else {
            throw RuntimeBootstrapError.rejected("A private installer file could not be created safely.")
        }
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }
}

/// Streams the pinned Node archive directly into the private setup workspace.
/// It never uses URLSession's shared download directory or buffers the archive.
final class PinnedRuntimeDownload: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let artifact: PinnedRuntimeArtifact
    private let destination: URL
    private let progress: @Sendable (Int64, Int64) -> Void
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var task: URLSessionDataTask?
    private var session: URLSession?
    private var output: FileHandle?
    private var archiveHash = SHA256()
    private var received: Int64 = 0
    private var cancelled = false
    private var completed = false

    init(artifact: PinnedRuntimeArtifact, destination: URL, progress: @escaping @Sendable (Int64, Int64) -> Void) {
        self.artifact = artifact
        self.destination = destination
        self.progress = progress
    }

    func run() async throws {
        try artifact.validate()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                lock.lock()
                if cancelled {
                    lock.unlock()
                    continuation.resume(throwing: CancellationError())
                    return
                }
                self.continuation = continuation
                do {
                    output = try BootstrapFileIntegrity.createExclusiveFile(destination)
                } catch {
                    lock.unlock()
                    finish(error)
                    return
                }
                let configuration = URLSessionConfiguration.ephemeral
                configuration.timeoutIntervalForRequest = 30
                configuration.timeoutIntervalForResource = 300
                let queue = OperationQueue()
                queue.maxConcurrentOperationCount = 1
                let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
                var request = URLRequest(url: URL(string: artifact.url)!)
                request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
                let task = session.dataTask(with: request)
                self.session = session
                self.task = task
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            self.lock.lock()
            self.cancelled = true
            self.lock.unlock()
            self.finish(CancellationError())
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // The official, versioned Node endpoint does not require redirects.
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200,
              response.expectedContentLength == -1 || response.expectedContentLength == artifact.size else {
            completionHandler(.cancel)
            finish(RuntimeBootstrapError.downloadFailed)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        var failure: Error?
        lock.lock()
        if !completed {
            do {
                guard received + Int64(data.count) <= artifact.size else {
                    throw RuntimeBootstrapError.rejected("The runtime download exceeded its signed byte limit.")
                }
                try output?.write(contentsOf: data)
                received += Int64(data.count)
                archiveHash.update(data: data)
            } catch { failure = error }
        }
        let count = received
        lock.unlock()
        if let failure { finish(failure) }
        else { progress(count, artifact.size) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(error is CancellationError ? error : RuntimeBootstrapError.downloadFailed); return }
        lock.lock()
        let valid = received == artifact.size
            && archiveHash.finalize().map { String(format: "%02x", $0) }.joined() == artifact.sha256
        lock.unlock()
        finish(valid ? nil : RuntimeBootstrapError.rejected("The runtime archive failed its signed checksum. Nothing was executed."))
    }

    private func finish(_ error: Error?) {
        lock.lock()
        guard !completed else { lock.unlock(); return }
        completed = true
        let continuation = continuation
        self.continuation = nil
        let task = task
        let session = session
        self.task = nil
        self.session = nil
        try? output?.close()
        output = nil
        lock.unlock()
        if let error { task?.cancel(); continuation?.resume(throwing: error) }
        else { continuation?.resume() }
        session?.invalidateAndCancel()
    }
}

/// Only launches fixed system tools or the already-hash-verified Node binary.
/// Cancellation owns one exact child and escalates without using process names.
final class BootstrapProcess: @unchecked Sendable {
    private let process = Process()
    private let lock = NSLock()
    private var cancelled = false
    private var failure: Error?
    private var complete = false
    private var timeout: DispatchWorkItem?

    func run(
        executable: URL, arguments: [String], directory: URL,
        outputFile: URL? = nil, maximumOutput: Int64 = 1024 * 1024,
        timeout seconds: TimeInterval = 900,
        onLine: @escaping @Sendable (String) -> Void = { _ in },
        shouldCommit: @escaping @Sendable () async -> Bool = { true }
    ) async throws {
        try Task.checkCancellation()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let stdout = Pipe()
                let stderr = Pipe()
                let stdin = Pipe()
                let group = DispatchGroup()
                var file: FileHandle?
                var awaitingTermination = false
                do {
                    if let outputFile { file = try BootstrapFileIntegrity.createExclusiveFile(outputFile) }
                    process.executableURL = executable
                    process.arguments = arguments
                    process.currentDirectoryURL = directory
                    process.environment = [
                        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                        "HOME": directory.path,
                        "TMPDIR": directory.path,
                        "LANG": "en_US.UTF-8",
                        "NODE_NO_WARNINGS": "1",
                    ]
                    process.standardOutput = stdout
                    process.standardError = stderr
                    process.standardInput = stdin
                    lock.lock()
                    defer { lock.unlock() }
                    if cancelled { throw CancellationError() }
                    group.enter()
                    awaitingTermination = true
                    process.terminationHandler = { _ in group.leave() }
                    try process.run()
                    try? stdout.fileHandleForWriting.close()
                    try? stderr.fileHandleForWriting.close()
                    try? stdin.fileHandleForReading.close()
                } catch {
                    if awaitingTermination {
                        process.terminationHandler = nil
                        group.leave()
                    }
                    try? file?.close()
                    continuation.resume(throwing: error)
                    return
                }

                let destination = file
                group.enter()
                DispatchQueue.global(qos: .utility).async {
                    defer {
                        try? destination?.close()
                        try? stdout.fileHandleForReading.close()
                        group.leave()
                    }
                    var count: Int64 = 0
                    var pending = Data()
                    do {
                        while let data = try Self.readPipe(stdout.fileHandleForReading) {
                            count += Int64(data.count)
                            guard count <= maximumOutput else { throw RuntimeBootstrapError.processFailed }
                            if let destination {
                                try destination.write(contentsOf: data)
                            } else {
                                pending.append(data)
                                while let newline = pending.firstIndex(of: 10) {
                                    let line = String(decoding: pending[..<newline], as: UTF8.self)
                                    pending.removeSubrange(...newline)
                                    guard line.utf8.count <= 8192 else { throw RuntimeBootstrapError.processFailed }
                                    onLine(line)
                                    if let data = line.data(using: .utf8),
                                       let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                                        if event["phase"] as? String == "error", let message = event["message"] as? String {
                                            self.lock.lock()
                                            if self.failure == nil {
                                                self.failure = RuntimeBootstrapError.rejected(String(message.prefix(512)))
                                            }
                                            self.lock.unlock()
                                        }
                                        if event["phase"] as? String == "ready-to-activate" {
                                            Task {
                                                let allow = await shouldCommit()
                                                try? stdin.fileHandleForWriting.write(contentsOf: Data(
                                                    (allow ? "{\"action\":\"commit\"}\n" : "{\"action\":\"cancel\"}\n").utf8
                                                ))
                                            }
                                        }
                                    }
                                }
                                guard pending.count <= 8192 else { throw RuntimeBootstrapError.processFailed }
                            }
                        }
                    } catch { self.stop(error) }
                }
                group.enter()
                DispatchQueue.global(qos: .utility).async {
                    defer { try? stderr.fileHandleForReading.close(); group.leave() }
                    do {
                        while try Self.readPipe(stderr.fileHandleForReading) != nil {}
                    } catch { self.stop(error) }
                }
                let timer = DispatchWorkItem { self.stop(RuntimeBootstrapError.timedOut) }
                lock.lock()
                timeout = timer
                lock.unlock()
                DispatchQueue.global().asyncAfter(deadline: .now() + seconds, execute: timer)
                group.notify(queue: .global(qos: .utility)) {
                    self.lock.lock()
                    self.complete = true
                    self.timeout?.cancel()
                    let error = self.failure ?? (self.cancelled ? CancellationError() : nil)
                    self.lock.unlock()
                    try? stdin.fileHandleForWriting.close()
                    if let error { continuation.resume(throwing: error) }
                    else if self.process.terminationStatus != 0 { continuation.resume(throwing: RuntimeBootstrapError.processFailed) }
                    else { continuation.resume() }
                }
            }
        } onCancel: {
            self.lock.lock()
            self.cancelled = true
            self.lock.unlock()
            self.stop(CancellationError())
        }
    }

    private func stop(_ error: Error) {
        lock.lock()
        guard !complete else { lock.unlock(); return }
        if failure == nil { failure = error }
        let running = process.isRunning
        let pid = process.processIdentifier
        lock.unlock()
        guard running, pid > 0 else { return }
        process.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 3) {
            self.lock.lock()
            let stillOwned = !self.complete && self.process.isRunning && self.process.processIdentifier == pid
            self.lock.unlock()
            if stillOwned { Darwin.kill(pid, SIGKILL) }
        }

    }

    private static func readPipe(_ handle: FileHandle) throws -> Data? {
        var bytes = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = bytes.withUnsafeMutableBytes {
                Darwin.read(handle.fileDescriptor, $0.baseAddress, $0.count)
            }
            if count == 0 { return nil }
            if count > 0 { return Data(bytes.prefix(count)) }
            if errno != EINTR {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        }
    }
}
