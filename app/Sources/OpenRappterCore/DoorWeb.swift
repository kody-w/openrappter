import Foundation
import Network

/// The page, reachable from the owner's other devices over their private network (Tailscale), and from this Mac.
/// openrappter-door/1:
///   GET  /           the page, with a button for every choice
///   GET  /left.json  the same as data: {schema, mac, at, held, token, left: [{says, choices: [{offer, label}]}]}
///   POST /pick       t=<token>&k=<offer> (a form) or {"token": "...", "offer": "..."}; takes that one choice
///   POST /ask        {"title": "...", "text": "...", "choices": ["...", "..."]} puts a question to the owner; gives {ok, id}
///   GET  /all        one page for every Mac named in peers.json ([{"name": "...", "at": "100.x.y.z"}]); each button posts to its own Mac
///   GET  /answer/<id> {id, picked}; picked is null until the owner has chosen
/// A choice is only ever taken by POST, so a link preview or a page preload can never press a button.
/// Anything not from this Mac or the private network is hung up on.
@MainActor
public final class DoorWeb {
    let door: Door
    var listener: NWListener?
    public static let port: UInt16 = 7466
    public init(door: Door) { self.door = door }

    public func start() {
        guard let port = NWEndpoint.Port(rawValue: DoorWeb.port), let l = try? NWListener(using: .tcp, on: port) else { return }
        l.newConnectionHandler = { [weak self] c in Task { @MainActor in self?.accept(c) } }
        l.start(queue: .main); listener = l
    }

    /// This Mac itself, or an address on the Tailscale network (100.64.0.0/10, fd7a:115c:a1e0::/48). Nothing else.
    public static func allowed(_ peer: String) -> Bool {
        var h = peer.lowercased()
        if let i = h.firstIndex(of: "%") { h = String(h[..<i]) }
        if h.hasPrefix("::ffff:") { h = String(h.dropFirst(7)) }
        if h == "127.0.0.1" || h == "::1" || h.hasPrefix("fd7a:115c:a1e0:") { return true }
        let p = h.split(separator: ".").compactMap { Int($0) }
        return p.count == 4 && p[0] == 100 && (64...127).contains(p[1])
    }

    func accept(_ c: NWConnection) {
        guard case let .hostPort(host, _) = c.endpoint, DoorWeb.allowed("\(host)") else { c.cancel(); return }
        c.start(queue: .main); read(c, Data())
    }

    func read(_ c: NWConnection, _ buf: Data) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, done, err in
            Task { @MainActor in
                guard let self else { return }
                var b = buf; if let data { b.append(data) }
                if let r = DoorWeb.parse(b) { await self.route(c, r) }
                else if done || err != nil || b.count > 200_000 { c.cancel() }
                else { self.read(c, b) }
            }
        }
    }

    public struct Request: Sendable { public var method: String, path: String, headers: [String: String], body: Data }

    public static func parse(_ d: Data) -> Request? {
        guard let cut = d.range(of: Data("\r\n\r\n".utf8)), let head = String(data: d[d.startIndex..<cut.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n"), first = lines[0].split(separator: " ")
        guard first.count >= 2 else { return nil }
        var h: [String: String] = [:]
        for l in lines.dropFirst() { if let i = l.firstIndex(of: ":") { h[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
        let body = d[cut.upperBound...], need = Int(h["content-length"] ?? "0") ?? 0
        guard body.count >= need else { return nil }
        return Request(method: String(first[0]), path: String(first[1]), headers: h, body: Data(body.prefix(need)))
    }

    /// The choice named in a POST body, as a form or as JSON.
    public static func choice(_ r: Request) -> (token: String, offer: String)? {
        if (r.headers["content-type"] ?? "").contains("json") {
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: String], let t = o["token"], let k = o["offer"] else { return nil }
            return (t, k)
        }
        var f: [String: String] = [:]
        for pair in (String(data: r.body, encoding: .utf8) ?? "").split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { f[kv[0]] = kv[1].removingPercentEncoding ?? kv[1] }
        }
        guard let t = f["t"], let k = f["k"] else { return nil }
        return (t, k)
    }

    /// The page's buttons, turned into forms that POST.
    public static func forWeb(_ html: String) -> String {
        let re = try! NSRegularExpression(pattern: "<a class=\"(btn[^\"]*)\" href=\"openrappter://pick/([^/\"]+)/([^\"]+)\">([^<]*)</a>")
        let out = re.stringByReplacingMatches(in: html, range: NSRange(html.startIndex..., in: html), withTemplate:
            "<form method=\"post\" action=\"/pick\"><input type=\"hidden\" name=\"t\" value=\"$2\"><input type=\"hidden\" name=\"k\" value=\"$3\"><button class=\"$1\">$4</button></form>")
        return out.replacingOccurrences(of: "</style>", with: "form{margin:0}button.btn{border:0;font:inherit;font-weight:600;cursor:pointer}</style>")
    }

    func route(_ c: NWConnection, _ r: Request) async {
        let path = r.path.split(separator: "?").first.map(String.init) ?? "/"
        switch (r.method, path) {
        case ("GET", "/"), ("GET", "/left.json"):
            _ = door.writePage(hours: 24)
            if path == "/" {
                let html = (try? String(contentsOf: door.dir.appendingPathComponent("page.html"), encoding: .utf8)) ?? ""
                send(c, "200 OK", "text/html; charset=utf-8", Data(DoorWeb.forWeb(html).utf8))
            } else {
                // Another door page on the private network may read this, so one page can show every Mac.
                let from = r.headers["origin"].flatMap { o in DoorWeb.safeBack(o + "/all") ? o : nil }
                send(c, "200 OK", "application/json", (try? Data(contentsOf: door.dir.appendingPathComponent("left.json"))) ?? Data("{}".utf8),
                     extra: from.map { "Access-Control-Allow-Origin: \($0)\r\nVary: Origin\r\n" } ?? "")
            }
        case ("POST", "/pick"):
            let json = (r.headers["content-type"] ?? "").contains("json")
            var ok = false
            if let ch = DoorWeb.choice(r) { ok = await door.pick(token: ch.token, key: ch.offer) }
            let back = DoorWeb.form(r)["back"].flatMap { DoorWeb.safeBack($0) ? $0 : nil }
            if json { send(c, ok ? "200 OK" : "409 Conflict", "application/json", Data("{\"ok\":\(ok),\"said\":\"\(ok ? "done" : "that choice is no longer on offer; read /left.json again")\"}".utf8)) }
            else { send(c, "303 See Other", "text/plain", Data(), extra: "Location: \(back ?? "/")\r\n") }
        case ("GET", "/all"):
            _ = door.writePage(hours: 24)
            let mine = (try? JSONSerialization.jsonObject(with: Data(contentsOf: door.dir.appendingPathComponent("left.json")))) as? [String: Any]
            var macs: [(name: String, base: String, doc: [String: Any]?)] = [(mine?["mac"] as? String ?? "This Mac", "", mine)]
            // The other Macs are asked by the owner's own browser, which can reach every one of them; the Macs need no link to each other.
            for p in door.peers() where DoorWeb.allowed(p.at) { macs.append((p.name, "http://\(p.at):\(DoorWeb.port)", nil)) }
            let me = "http://\(r.headers["host"] ?? "127.0.0.1:\(DoorWeb.port)")/all"
            send(c, "200 OK", "text/html; charset=utf-8", Data(DoorWeb.allPage(macs, back: me).utf8))
        case ("POST", "/ask"):
            guard let o = try? JSONSerialization.jsonObject(with: r.body) as? [String: Any], let title = o["title"] as? String,
                  let ch = o["choices"] as? [String], !ch.isEmpty, ch.count <= 6 else { send(c, "400 Bad Request", "application/json", Data("{\"ok\":false,\"said\":\"a question needs a title and up to six choices\"}".utf8)); return }
            var a = DoorAsk(id: "q-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(6).lowercased())", do: "question")
            a.title = String(title.prefix(200)); a.text = (o["text"] as? String).map { String($0.prefix(600)) }; a.choices = ch.map { String($0.prefix(60)) }
            if let d = try? JSONEncoder().encode(a) { try? d.write(to: door.dir.appendingPathComponent("\(a.id).json"), options: .atomic) }
            await door.drain(); _ = door.writePage(hours: 24)
            send(c, "200 OK", "application/json", Data("{\"ok\":true,\"id\":\"\(a.id)\"}".utf8))
        case ("GET", _) where path.hasPrefix("/answer/"):
            let id = String(path.dropFirst(8))
            guard !id.isEmpty, id.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { send(c, "400 Bad Request", "text/plain", Data()); return }
            let picked = door.answered(id)?["picked"] as? String
            let body: [String: Any] = ["id": id, "picked": picked ?? NSNull()]
            send(c, "200 OK", "application/json", (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8))
        default:
            send(c, "404 Not Found", "text/plain", Data("not here".utf8))
        }
    }

    /// The fields of a posted form.
    public static func form(_ r: Request) -> [String: String] {
        var f: [String: String] = [:]
        for pair in (String(data: r.body, encoding: .utf8) ?? "").split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { f[kv[0]] = (kv[1].replacingOccurrences(of: "+", with: " ")).removingPercentEncoding ?? kv[1] }
        }
        return f
    }

    /// Where a pick may send the browser back to: only another door page on the private network.
    public static func safeBack(_ url: String) -> Bool {
        guard let u = URL(string: url), u.scheme == "http", let h = u.host, u.path == "/all", u.query == nil else { return false }
        return allowed(h) || h.hasSuffix(".ts.net")
    }

    /// One page for every Mac: what each has left for the owner, with that Mac's own buttons.
    public static func allPage(_ macs: [(name: String, base: String, doc: [String: Any]?)], back: String) -> String {
        func esc(_ s: String) -> String { s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\"", with: "&quot;") }
        var body = "", total = 0
        for m in macs {
            guard let d = m.doc, let token = d["token"] as? String else {
                body += "<section class=\"far\" data-base=\"\(esc(m.base))\"><h2>\(esc(m.name)) <em></em></h2><p>Looking\u{2026}</p><ul></ul><p><a href=\"\(esc(m.base))/\">Everything \(esc(m.name)) did</a></p></section>"; continue
            }
            let left = (d["left"] as? [[String: Any]]) ?? []
            total += left.count
            body += "<h2>\(esc(m.name)) <em>\(left.count)</em></h2>"
            if left.isEmpty { body += "<p>Nothing. You do not need to do anything.</p>" }
            body += "<ul>"
            for item in left {
                body += "<li class=\"ask\"><b>\(esc(item["says"] as? String ?? ""))</b><div>"
                for (i, c) in ((item["choices"] as? [[String: String]]) ?? []).enumerated() {
                    body += "<form method=\"post\" action=\"\(esc(m.base))/pick\"><input type=\"hidden\" name=\"t\" value=\"\(esc(token))\"><input type=\"hidden\" name=\"k\" value=\"\(esc(c["offer"] ?? ""))\"><input type=\"hidden\" name=\"back\" value=\"\(esc(back))\"><button class=\"btn\(i > 0 || (c["label"] ?? "").hasPrefix("Always ") ? " quiet" : "")\">\(esc(c["label"] ?? ""))</button></form>"
                }
                body += "</div></li>"
            }
            body += "</ul><p><a href=\"\(esc(m.base))/\">Everything \(esc(m.name)) did</a></p>"
        }
        return """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="refresh" content="30"><title>All your Macs</title>
        <style>body{font:18px/1.5 -apple-system,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#14110f;color:#f3ece4}
        h1{font-size:34px;margin:0}h2{font-size:20px;margin:34px 0 8px;color:#f0a04b}h2 em{font-style:normal;opacity:.6}
        ul{list-style:none;padding:0;margin:0}li.ask{padding:10px 0;border-bottom:1px solid #2c2622}li b{font-weight:500}
        li.ask div{margin-top:10px;display:flex;gap:10px;flex-wrap:wrap}p{opacity:.6}a{color:#f0a04b}.sub{opacity:.6;margin:4px 0 0}
        form{margin:0}button.btn{border:0;font:inherit;font-weight:600;cursor:pointer;background:#f0a04b;color:#14110f;padding:10px 18px;border-radius:10px}
        button.btn.quiet{background:#2c2622;color:#f3ece4}</style>
        <h1>All your Macs</h1><p class="sub">\(total == 0 ? "Nothing is waiting on you." : "\(total) waiting on you.")</p>
        \(body)
        <script>
        const back = \(String(data: (try? JSONSerialization.data(withJSONObject: [back])) ?? Data("[\"\"]".utf8), encoding: .utf8) ?? "[\"\"]")[0];
        let more = 0;
        for (const s of document.querySelectorAll("section.far")) {
          const base = s.dataset.base, note = s.querySelector("p"), list = s.querySelector("ul");
          fetch(base + "/left.json").then(r => r.json()).then(d => {
            const left = d.left || []; s.querySelector("em").textContent = left.length;
            note.textContent = left.length ? "" : "Nothing. You do not need to do anything.";
            for (const item of left) {
              const li = document.createElement("li"); li.className = "ask";
              const b = document.createElement("b"); b.textContent = item.says; li.append(b);
              const row = document.createElement("div");
              (item.choices || []).forEach((c, i) => {
                const f = document.createElement("form"); f.method = "post"; f.action = base + "/pick";
                for (const [k, v] of [["t", d.token], ["k", c.offer], ["back", back]]) { const h = document.createElement("input"); h.type = "hidden"; h.name = k; h.value = v; f.append(h); }
                const btn = document.createElement("button"); btn.className = "btn" + (i > 0 || c.label.startsWith("Always ") ? " quiet" : ""); btn.textContent = c.label; f.append(btn); row.append(f);
              });
              li.append(row); list.append(li);
            }
            more += left.length;
            if (more) document.querySelector(".sub").textContent = (\(total) + more) + " waiting on you.";
          }).catch(() => { note.textContent = "I could not reach this Mac just now."; });
        }
        </script>
        """
    }

    func send(_ c: NWConnection, _ status: String, _ type: String, _ body: Data, extra: String = "") {
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\(extra)\r\n"
        c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
    }
}
