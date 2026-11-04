import AppKit

/// A temporary copy, not ownership of the clipboard. Never overwrite something copied meanwhile.
@MainActor
public final class ClipboardLease {
    public typealias Snapshot = [[String: Data]]
    private let read: () -> Snapshot
    private let write: (Snapshot) -> Void
    private let version: () -> Int
    private var saved: Snapshot?
    private var copiedVersion: Int?

    public init(read: @escaping () -> Snapshot, write: @escaping (Snapshot) -> Void,
                version: @escaping () -> Int) {
        self.read = read; self.write = write; self.version = version
    }

    public convenience init(pasteboard: NSPasteboard = .general) {
        self.init(read: {
            (pasteboard.pasteboardItems ?? []).map { item in
                Dictionary(uniqueKeysWithValues: item.types.compactMap { type in
                    item.data(forType: type).map { (type.rawValue, $0) }
                })
            }
        }, write: { snapshot in
            pasteboard.clearContents()
            let items = snapshot.map { data in
                let item = NSPasteboardItem()
                for (type, value) in data { item.setData(value, forType: NSPasteboard.PasteboardType(type)) }
                return item
            }
            if !items.isEmpty { pasteboard.writeObjects(items) }
        }, version: { pasteboard.changeCount })
    }

    public func copy(_ text: String) {
        if saved == nil || copiedVersion != version() { saved = read() }
        write([[NSPasteboard.PasteboardType.string.rawValue: Data(text.utf8)]])
        copiedVersion = version()
    }

    public func restore() {
        if let saved, copiedVersion == version() { write(saved) }
        saved = nil; copiedVersion = nil
    }
}
