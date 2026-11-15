import Foundation
import Network

/// The page, reachable from the owner's other devices over their private network (Tailscale), and from this Mac.
/// openrappter-door/1:
///   GET  /           the page, with a button for every choice
///   GET  /left.json  the same as data: {schema, mac, at, held, token, left: [{says, choices: [{offer, label}]}]}
///   POST /pick       t=<token>&k=<offer> (a form) or {"token": "...", "offer": "..."}; takes that one choice
///   POST /ask        {"title": "...", "text": "...", "choices": ["...", "..."]} puts a question to the owner; gives {ok, id}
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
                send(c, "200 OK", "application/json", (try? Data(contentsOf: door.dir.appendingPathComponent("left.json"))) ?? Data("{}".utf8))
            }
        case ("POST", "/pick"):
            let json = (r.headers["content-type"] ?? "").contains("json")
            var ok = false
            if let ch = DoorWeb.choice(r) { ok = await door.pick(token: ch.token, key: ch.offer) }
            if json { send(c, ok ? "200 OK" : "409 Conflict", "application/json", Data("{\"ok\":\(ok),\"said\":\"\(ok ? "done" : "that choice is no longer on offer; read /left.json again")\"}".utf8)) }
            else { send(c, "303 See Other", "text/plain", Data(), extra: "Location: /\r\n") }
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

    func send(_ c: NWConnection, _ status: String, _ type: String, _ body: Data, extra: String = "") {
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\(extra)\r\n"
        c.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in c.cancel() })
    }
}
