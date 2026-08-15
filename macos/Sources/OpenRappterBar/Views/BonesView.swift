import AppKit
import SwiftUI
import WebKit

/// "Click the dino, see what you are made of."
///
/// The window is native; the content is the anatomy page the gateway serves at
/// `/bones`. That split is deliberate. The same page has to work in this window,
/// in a browser at :18790, and in the vbrainstem chat surface — one
/// implementation, three surfaces, which is the brainstem parity asked for every
/// round. Reimplementing it in SwiftUI would guarantee the three drift apart,
/// and a SwiftUI list of files is exactly what was rejected: "it needs to not be
/// just the raw files... that is the openclaw slop pattern."
///
/// `BonesInspector` remains the truth source and still backs the offline
/// fallback below, along with its two refusals:
///   · `.env` and anything credential-shaped is named but never read. In the
///     anatomy framing it becomes the Vault, shown sealed.
///   · A missing file is shown as missing, never dropped. "You have no SOUL.md"
///     is the answer to why the assistant sounds generic.
@MainActor
public final class BonesWindowController: NSObject, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow?
    private var webView: AgentDropWebView?

    private var anatomyURL: URL? {
        URL(string: "http://127.0.0.1:\(AppConstants.defaultPort)/bones")
    }

    public override init() { super.init() }

    public func show() {
        if let window, let webView {
            reload(webView)
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let web = AgentDropWebView(frame: .zero, configuration: WKWebViewConfiguration())
        web.navigationDelegate = self
        web.onAgentDropped = { [weak self] result in self?.presentDropResult(result) }

        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 860),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        w.title = "🦖  Anatomy"
        w.center()
        w.isReleasedWhenClosed = false
        w.delegate = self
        w.contentView = web
        window = w
        webView = web

        reload(web)
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Re-read on every open: the organism changes while you use it, and a stale
    /// reading is the one thing this window must not show.
    private func reload(_ web: WKWebView) {
        guard let url = anatomyURL else {
            web.loadHTMLString(Self.asleepPage(), baseURL: nil)
            return
        }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 4
        web.load(request)
    }

    // A dead daemon must not produce a white screen with a network error in it.
    // The bones are still on disk, so render those and say the organism is asleep.
    public func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        webView.loadHTMLString(Self.asleepPage(), baseURL: nil)
    }

    public func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        webView.loadHTMLString(Self.asleepPage(), baseURL: nil)
    }

    private func presentDropResult(_ result: AgentDropResult) {
        let alert = NSAlert()
        switch result {
        case .learned(let names, let file):
            alert.messageText = "I can do something new."
            alert.informativeText = "Learned \(names) from \(file). Ask me in your next message — no restart needed."
            alert.alertStyle = .informational
            if let webView { reload(webView) }
        case .refused(let reason):
            alert.messageText = "I could not learn that."
            alert.informativeText = reason
            alert.alertStyle = .warning
        }
        alert.addButton(withTitle: "OK")
        if let window {
            alert.beginSheetModal(for: window, completionHandler: nil)
        } else {
            alert.runModal()
        }
    }

    public func windowWillClose(_ notification: Notification) { /* keep for reuse */ }

    /// The offline / no-daemon rendering, built from `BonesInspector`.
    ///
    /// Degradation is a first-class state, not an error page: the skeleton is
    /// real and readable even when nothing is running.
    static func asleepPage() -> String {
        let bones = BonesInspector.inspect()
        let rows = bones.sections.map { section -> String in
            let items = section.items.isEmpty
                ? "<div class=\"empty\">\(escapeHTML(section.emptyNote))</div>"
                : section.items.map { item -> String in
                    let meta = item.missing
                        ? "missing"
                        : (BonesInspector.isSecret(item.path) ? "sealed" : item.sizeLabel)
                    return "<div class=\"row\"><span>\(escapeHTML(item.name))</span><span class=\"m\">\(meta)</span></div>"
                }.joined()
            return "<section><h2>\(escapeHTML(section.title))</h2><p>\(escapeHTML(section.blurb))</p>\(items)</section>"
        }.joined()

        return """
        <!doctype html><html><head><meta charset="utf-8"><style>
        :root { --ink:#141413; --cream:#FAF9F5; --tile:#EFE9DE; --coral:#9A5233; --hair:rgba(20,20,19,0.12); }
        * { margin:0; padding:0; box-sizing:border-box; }
        body { background:var(--cream); color:var(--ink); padding:38px 42px;
               font-family:system-ui,-apple-system,"Segoe UI",Helvetica,sans-serif; }
        .kicker { font-family:ui-monospace,Menlo,monospace; font-size:12px; letter-spacing:.16em; text-transform:uppercase; }
        .spike { color:#CC785C; margin-right:10px; }
        h1 { font-family:"Iowan Old Style",Palatino,Georgia,serif; font-size:48px; font-weight:400; letter-spacing:-.02em; margin:18px 0 4px; }
        .sub { font-family:"Iowan Old Style",Palatino,Georgia,serif; font-style:italic; font-size:20px; color:rgba(20,20,19,.66); }
        .note { border:1px solid var(--hair); background:var(--tile); border-radius:10px; padding:16px 18px; margin:24px 0 30px; font-size:15px; line-height:1.5; }
        section { margin-bottom:26px; }
        h2 { font-family:"Iowan Old Style",Palatino,Georgia,serif; font-size:27px; font-weight:400; }
        section p { color:rgba(20,20,19,.62); font-size:14px; margin:2px 0 10px; }
        .row { display:flex; justify-content:space-between; font-family:ui-monospace,Menlo,monospace; font-size:12.5px; padding:5px 0; border-bottom:1px solid var(--hair); }
        .m { color:var(--coral); }
        .empty { font-size:14px; color:rgba(20,20,19,.5); font-style:italic; }
        </style></head><body>
        <div class="kicker"><span class="spike">✱</span>ANATOMY OF A RAPPTER</div>
        <h1>Asleep</h1>
        <div class="sub">Bones intact, no pulse.</div>
        <div class="note">No daemon is running, so there is nothing live to read — no mind, no pulse, no
        open port. These are the files it is made of, read from \(escapeHTML(bones.home)) just now.
        Start openrappter and this becomes the living anatomy.</div>
        \(rows)
        </body></html>
        """
    }

    private static func escapeHTML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

/// What came back from dropping a file on the window.
public enum AgentDropResult {
    case learned(names: String, file: String)
    case refused(reason: String)
}

/// A `WKWebView` that accepts agent files dropped anywhere on it.
///
/// The page has its own HTML drop handler, but `WKWebView` consumes drags of
/// local file URLs before the page sees them — so the native side has to own the
/// gesture, or dropping on the menu-bar app would silently do nothing while
/// dropping in a browser worked. Same gesture, same result, both surfaces.
final class AgentDropWebView: WKWebView {
    var onAgentDropped: ((AgentDropResult) -> Void)?

    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        registerForDraggedTypes([.fileURL])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }

    /// The filter that stands between a stray screenshot and an execution attempt.
    static func isAgentFile(_ url: URL) -> Bool {
        url.pathExtension == "py" || url.pathExtension == "js"
    }

    private func agentURLs(_ sender: NSDraggingInfo) -> [URL] {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] ?? []
        return urls.filter { Self.isAgentFile($0) }
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        agentURLs(sender).isEmpty ? [] : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        agentURLs(sender).isEmpty ? [] : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        guard let url = agentURLs(sender).first else { return false }

        // The trust boundary, stated at the moment of the drop. This runs code on
        // the machine, and the person has to say so out loud first.
        let confirm = NSAlert()
        confirm.messageText = "Install \(url.lastPathComponent)?"
        confirm.informativeText = "This runs code on your machine."
        confirm.alertStyle = .warning
        confirm.addButton(withTitle: "Install")
        confirm.addButton(withTitle: "Cancel")
        guard confirm.runModal() == .alertFirstButtonReturn else { return false }

        guard let contents = try? String(contentsOf: url, encoding: .utf8) else {
            onAgentDropped?(.refused(reason: "\(url.lastPathComponent) could not be read as text."))
            return false
        }

        Task { [weak self] in
            let result = await AgentInstaller.install(filename: url.lastPathComponent, contents: contents)
            await MainActor.run { self?.onAgentDropped?(result) }
        }
        return true
    }
}

/// Sends a dropped agent to the running daemon.
///
/// Deliberately NOT a local file write. Only the daemon owns the live registry,
/// so writing the file from here would produce an agent that is installed and
/// not usable — the exact failure this feature exists to avoid.
public enum AgentInstaller {
    public static func install(
        filename: String,
        contents: String,
        port: Int = AppConstants.defaultPort,
        token: String? = AppConstants.defaultGatewayToken
    ) async -> AgentDropResult {
        guard let request = makeRequest(
            filename: filename,
            contents: contents,
            port: port,
            token: token
        ) else {
            return .refused(reason: "Could not reach the daemon.")
        }

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return .refused(reason: "The daemon returned something unreadable.")
            }
            if (json["status"] as? String) == "ok" {
                let learned = (json["learned"] as? [[String: Any]] ?? [])
                    .compactMap { $0["name"] as? String }
                    .joined(separator: ", ")
                return .learned(names: learned.isEmpty ? filename : learned,
                                file: (json["file"] as? String) ?? filename)
            }
            return .refused(reason: (json["error"] as? String) ?? "The daemon refused it without saying why.")
        } catch {
            return .refused(reason: "openrappter is not running, so there is nothing to teach. Start it and drop again.")
        }
    }

    static func makeRequest(
        filename: String,
        contents: String,
        port: Int,
        token: String?
    ) -> URLRequest? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/agents/import") else {
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token, !token.isEmpty {
            request.setValue(token, forHTTPHeaderField: "X-Gateway-Token")
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "filename": filename,
            "contents": contents,
        ])
        request.timeoutInterval = 45
        return request
    }
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
