import AppKit
import SwiftUI

/// "Click the dino, see what you are made of."
///
/// Opens the real files that constitute this AI — agents, skills, identity,
/// memory, configuration — read from disk at the moment it is opened. Nothing
/// here is sample data: an empty section says it is empty, and a file that
/// should exist but does not is shown as missing rather than omitted.
///
/// Two deliberate refusals:
///   · `.env` and anything credential-shaped is listed by name and size but can
///     never be opened from here. The bones are for understanding the organism,
///     not for putting secrets on screen.
///   · A missing file is not silently dropped. "You have no SOUL.md" is the
///     answer to why the assistant sounds generic, so it has to be visible.
@MainActor
public final class BonesWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?

    public override init() { super.init() }

    public func show() {
        if let window {
            // Re-read on every open: the organism changes while you use it, and
            // a stale inventory is the one thing this window must not show.
            window.contentView = NSHostingView(rootView: BonesView(bones: BonesInspector.inspect()))
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 720, height: 620),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        w.title = "🦖  The bones"
        w.center()
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.contentView = NSHostingView(rootView: BonesView(bones: BonesInspector.inspect()))
        window = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    public func windowWillClose(_ notification: Notification) { /* keep for reuse */ }
}

struct BonesView: View {
    let bones: Bones

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ForEach(bones.sections) { section in
                        sectionView(section)
                    }
                }
                .padding(18)
            }
        }
        .frame(minWidth: 560, minHeight: 420)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("What this AI is made of")
                .font(.system(size: 16, weight: .semibold))
            Text("\(bones.totalFiles) files · read from \(bones.home) just now")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
    }

    @ViewBuilder
    private func sectionView(_ section: Bones.Section) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(section.title).font(.system(size: 13, weight: .semibold))
                Spacer()
                Button("Reveal") {
                    NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: section.root)
                }
                .buttonStyle(.link)
                .font(.system(size: 11))
            }
            Text(section.blurb)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)

            let present = section.items.filter { !$0.missing }
            if present.isEmpty && section.items.allSatisfy({ $0.missing }) {
                Text(section.emptyNote)
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 6)
            }

            ForEach(section.items) { item in
                itemRow(item)
            }
        }
    }

    @ViewBuilder
    private func itemRow(_ item: Bones.Item) -> some View {
        let secret = BonesInspector.isSecret(item.path)
        HStack(spacing: 10) {
            Text(item.name)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(item.missing ? .tertiary : .primary)
            if item.missing {
                Text("missing").font(.system(size: 10)).foregroundStyle(.tertiary)
            }
            if secret {
                // Named, sized, never opened.
                Text("contents withheld").font(.system(size: 10)).foregroundStyle(.orange)
            }
            Spacer()
            Text(item.sizeLabel).font(.system(size: 11)).foregroundStyle(.secondary)
            if !item.missing && !secret {
                Button("Open") { NSWorkspace.shared.open(URL(fileURLWithPath: item.path)) }
                    .buttonStyle(.link)
                    .font(.system(size: 11))
            }
        }
        .padding(.vertical, 3)
    }
}
