// Debug autopilot. The whole file is compiled out of Release builds;
// see AutopilotGate for the second, explicit launch-time lock.
#if DEBUG
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// The command mailbox: somewhere commands arrive and receipts are left.
protocol AutopilotMailbox: AnyObject {
    /// Monotonic marker so the driver reads only when something changed.
    var changeCount: Int { get }
    func read() -> String?
    func write(_ payload: String)
}

#if canImport(UIKit)
/// The system pasteboard, which is what `simctl pbcopy` and `simctl pbpaste`
/// talk to.
///
/// Reads are foreground-only and gated by `hasStrings`, which does not expose
/// content. Note that on iOS 16 and later the system shows a paste
/// confirmation for programmatic reads of content another process wrote, so
/// the read half of this mailbox needs an operator to allow it once per copy.
/// The write half — publishing receipts — is never prompted, which is why
/// receipts always come back this way regardless of how a command arrived.
final class PasteboardMailbox: AutopilotMailbox {
    private let pasteboard: UIPasteboard

    init(pasteboard: UIPasteboard = .general) {
        self.pasteboard = pasteboard
    }

    var changeCount: Int { pasteboard.changeCount }

    func read() -> String? {
        guard pasteboard.hasStrings else { return nil }
        return pasteboard.string
    }

    func write(_ payload: String) {
        pasteboard.string = payload
    }
}
#endif

/// Used by tests and by the URL carrier, which has no clipboard of its own.
final class InMemoryMailbox: AutopilotMailbox {
    private(set) var contents: String?
    private(set) var writes: [String] = []
    private(set) var changeCount = 0

    init(contents: String? = nil) {
        self.contents = contents
        if contents != nil { changeCount = 1 }
    }

    func read() -> String? { contents }

    func write(_ payload: String) {
        contents = payload
        writes.append(payload)
        changeCount += 1
    }

    /// Simulates an outside process dropping a command in.
    func deliver(_ payload: String) {
        contents = payload
        changeCount += 1
    }
}

/// A one-slot mailbox inside the app's own container.
///
/// It exists because iOS refuses unattended reads of pasteboard content another
/// process wrote — proven three ways on iOS 26: `UIPasteboard.general.string`
/// raises the system paste confirmation, `simctl privacy grant all` does not
/// cover it, and `detectedValues(for:)` throws "Operation not authorized". A
/// smoke journey that cannot run without someone tapping "Allow Paste" is not
/// an autopilot, so the unattended carrier is a file the driver owns and the
/// harness writes.
///
/// It carries the identical payload, reaches the identical parser and
/// allowlist, and — importantly — publishes its receipts to the pasteboard as
/// well, so receipts are always read with `simctl pbpaste`.
///
/// The mailbox is emptied when it is read, so a relaunch never re-runs the last
/// command it was handed.
final class ContainerFileMailbox: AutopilotMailbox {
    static let directoryName = "RappidFieldAutopilot"
    static let inboxName = "inbox.json"
    static let receiptName = "receipt.json"

    private let directory: URL
    private let fileManager: FileManager

    init?(fileManager: FileManager = .default) {
        guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
            return nil
        }
        self.fileManager = fileManager
        self.directory = support.appendingPathComponent(Self.directoryName, isDirectory: true)
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            return nil
        }
    }

    init(directory: URL, fileManager: FileManager = .default) throws {
        self.fileManager = fileManager
        self.directory = directory
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    var inboxURL: URL { directory.appendingPathComponent(Self.inboxName) }
    var receiptURL: URL { directory.appendingPathComponent(Self.receiptName) }

    /// Nanosecond modification time, so two commands never look identical.
    var changeCount: Int {
        guard let attributes = try? fileManager.attributesOfItem(atPath: inboxURL.path),
              let modified = attributes[.modificationDate] as? Date else {
            return 0
        }
        return Int(modified.timeIntervalSince1970 * 1_000_000_000)
    }

    func read() -> String? {
        guard let data = try? Data(contentsOf: inboxURL) else { return nil }
        try? fileManager.removeItem(at: inboxURL)
        return String(decoding: data, as: UTF8.self)
    }

    func write(_ payload: String) {
        try? Data(payload.utf8).write(to: receiptURL, options: .atomic)
    }
}
#endif
