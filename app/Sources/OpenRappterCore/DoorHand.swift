import Foundation
import AppKit
import CoreGraphics

/// Your hand from your phone: see this Mac's screen, tap it, and type into it, from any browser on your private network.
/// What you type goes straight to the keyboard one key at a time: it never touches the clipboard and is never written down.
extension Screen {
    /// Types text as key presses, never through the clipboard (so a password is not left behind for other apps).
    public static func typeKeys(_ text: String) {
        let src = CGEventSource(stateID: .combinedSessionState)
        for ch in text {
            let u = Array(String(ch).utf16)
            for down in [true, false] {
                let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
                e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
                e?.post(tap: .cghidEventTap)
            }
            usleep(12_000)
        }
    }
}

extension Door {
    /// What a phone asked: a tap at a share of the screen (0...1 each way), some text, or one key.
    public enum HandAsk: Equatable { case tap(Double, Double), type(String), key(String), press(String) }

    public nonisolated static func handAsk(_ body: Data) -> HandAsk? {
        guard let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any], let what = o["do"] as? String else { return nil }
        switch what {
        case "tap":
            guard let x = (o["x"] as? NSNumber)?.doubleValue, let y = (o["y"] as? NSNumber)?.doubleValue,
                  (0...1).contains(x), (0...1).contains(y) else { return nil }
            return .tap(x, y)
        case "type":
            guard let t = o["text"] as? String, !t.isEmpty, t.count <= 500 else { return nil }
            return .type(t)
        case "key":
            guard let k = o["key"] as? String, ["return", "tab", "escape", "delete", "space", "up", "down", "left", "right"].contains(k) else { return nil }
            return .key(k)
        case "press":
            guard let t = o["label"] as? String, !t.isEmpty, t.count <= 120 else { return nil }
            return .press(t)
        default: return nil
        }
    }

    public struct HandChoice: Equatable { public var kind: String, label: String, x: Double, y: Double }

    /// The things on screen a person could say: buttons, links, switches and fields, top to bottom, each once.
    /// `bounds` turns screen points into shares of the screen, so the phone can tap a field it cannot press.
    public nonisolated static func handChoices(_ words: [String], bounds: CGRect) -> [HandChoice] {
        let press = ["Button", "Link", "CheckBox", "RadioButton", "Switch", "MenuButton", "PopUpButton", "MenuItem", "Tab"]
        let fields = ["TextField", "SecureTextField", "TextArea", "SearchField", "ComboBox"]
        var seen = Set<String>(), out: [HandChoice] = []
        for w in words {
            guard let colon = w.range(of: ": "), let at = w.range(of: " @", options: .backwards) else { continue }
            let role = String(w[..<colon.lowerBound]); var label = String(w[colon.upperBound..<at.lowerBound])
            let xy = w[at.upperBound...].split(separator: ",").compactMap { Double($0) }
            guard xy.count == 2, bounds.width > 0, bounds.height > 0 else { continue }
            let x = (xy[0] - bounds.minX) / bounds.width, y = (xy[1] - bounds.minY) / bounds.height
            guard (0...1).contains(x), (0...1).contains(y) else { continue }
            let kind = press.contains(role) ? "press" : (fields.contains(role) ? "field" : "")
            guard !kind.isEmpty else { continue }
            label = label.replacingOccurrences(of: " (on)", with: "").replacingOccurrences(of: " (off)", with: "")
            // Machine names like com.apple.something are not something a person can say.
            if label.contains("com.apple") || (label.contains(".") && !label.contains(" ")) || label.count < 2 { continue }
            guard seen.insert(kind + label.lowercased()).inserted else { continue }
            out.append(HandChoice(kind: kind, label: label, x: x, y: y))
        }
        return Array(out.sorted { $0.y != $1.y ? $0.y < $1.y : $0.x < $1.x }.prefix(60))
    }

    /// Which choice a spoken phrase means: the label with the most words in common, if any word matches.
    public nonisolated static func handHeard(_ said: String, in choices: [String]) -> String? {
        func words(_ s: String) -> [String] { s.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init) }
        let w = Set(words(said).filter { !["press", "tap", "click", "the", "button", "on", "a"].contains($0) })
        guard !w.isEmpty else { return nil }
        if let exact = choices.first(where: { words($0) == words(said) }) { return exact }
        let scored = choices.map { c -> (String, Double) in
            let cw = Set(words(c)); return (c, cw.isEmpty ? 0 : Double(cw.intersection(w).count) / Double(max(cw.count, w.count)))
        }.filter { $0.1 > 0 }
        return scored.max { $0.1 < $1.1 }?.0
    }

    /// Where a tap lands on the main screen, in screen points.
    public nonisolated static func handPoint(_ x: Double, _ y: Double, bounds: CGRect) -> CGPoint {
        CGPoint(x: bounds.minX + x * bounds.width, y: bounds.minY + y * bounds.height)
    }

    /// What the record says, never the text itself.
    public nonisolated static func handSays(_ a: HandAsk) -> String {
        switch a {
        case .tap: return "tapped the screen from your phone"
        case .type(let t): return "typed \(t.count) character\(t.count == 1 ? "" : "s") from your phone"
        case .key(let k): return "pressed \(k) from your phone"
        case .press(let l): return "pressed \(l.prefix(60)) from your phone"
        }
    }

    /// Does what the phone asked, unless hands off is on. `act` is the real hand, swapped out in tests.
    public func hand(_ a: HandAsk, act: ((HandAsk) -> Void)? = nil) -> (ok: Bool, said: String) {
        if held { return (false, "hands off is on, so I am not touching this Mac") }
        if act == nil, !(CGPreflightPostEventAccess() || AXIsProcessTrusted()) { return (false, "not allowed to press keys yet") }
        if act == nil, case .press(let l) = a {
            let r = Screen.press(title: l, app: nil)
            if !r.ok { return (false, r.said) }
        }
        (act ?? { a in
            switch a {
            case .tap(let x, let y): Screen.click(Door.handPoint(x, y, bounds: CGDisplayBounds(CGMainDisplayID())))
            case .type(let t): Screen.typeKeys(t)
            case .key(let k): if let c = Screen.keyCode(k) { Screen.key(c, with: []) }
            case .press: break
            }
        })(a)
        let t = Date().timeIntervalSince1970
        let ask = DoorAsk(id: "hand-\(Int(t))-\(UUID().uuidString.prefix(4).lowercased())", do: "notice")
        record(ask, DoorAnswer(id: ask.id, ok: true, said: Door.handSays(a), front: nil, words: nil, picture: nil, at: t))
        return (true, "done")
    }

    /// The sayable things on screen now, as JSON for the phone.
    public func handChoicesJSON() -> Data {
        let c = Door.handChoices(Screen.words(app: nil), bounds: CGDisplayBounds(CGMainDisplayID()))
        let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
        return (try? JSONSerialization.data(withJSONObject: ["front": front, "choices": c.map { ["kind": $0.kind, "label": $0.label, "x": $0.x, "y": $0.y] }])) ?? Data("{}".utf8)
    }

    /// The screen right now, small enough for a phone.
    public func handScreen() async -> Data? {
        let f = FileManager.default.temporaryDirectory.appendingPathComponent("hand-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: f) }
        guard await Screen.picture(to: f), let png = try? Data(contentsOf: f) else { return nil }
        return Door.small(png, side: 1400)
    }
}

extension DoorWeb {
    /// The phone page: the screen fills it; tap to press; a box to type; four keys. One thing to do: touch your Mac.
    public static func handPage(mac: String) -> String {
        let name = mac.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        return """
        <!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>\(name)</title>
        <style>body{margin:0;background:#14110f;color:#f3ece4;font:17px/1.4 -apple-system,sans-serif}
        header{padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:8px}h1{font-size:20px;margin:0}
        #say{opacity:.7;font-size:15px}#wrap{position:relative}#s{width:100%;display:block}
        body.say #s{filter:brightness(.35)}.chip{position:absolute;transform:translate(-50%,-50%);font:600 14px -apple-system,sans-serif;
        padding:6px 10px;border-radius:999px;border:0;background:#f0a04b;color:#14110f;white-space:nowrap;max-width:46%;overflow:hidden;text-overflow:ellipsis}
        .chip.field{background:#7cc4ff}body:not(.say) .chip{display:none}
        .bar{display:flex;gap:8px;padding:12px 16px;flex-wrap:wrap}input{flex:1;min-width:0;font:inherit;padding:12px;border-radius:10px;border:0;background:#2c2622;color:#f3ece4}
        button{font:inherit;font-weight:600;padding:12px 16px;border-radius:10px;border:0;background:#f0a04b;color:#14110f}button.k{background:#2c2622;color:#f3ece4}
        #list button{display:block;width:100%;text-align:left;margin:0 0 8px;background:#2c2622;color:#f3ece4}#list button.field{border-left:4px solid #7cc4ff}
        #list{padding:0 16px 24px}body:not(.say) #list{display:none}</style>
        <body class="say">
        <header><h1>\(name)</h1><button class="k" id="mode" type="button">Just the screen</button></header>
        <p id="say" style="padding:0 16px">Say a button's name, or its number</p>
        <div id="wrap"><img id="s" alt="This Mac's screen" src="/hand/screen.jpg"></div>
        <form class="bar" id="v"><input id="heard" placeholder="Say which one" autocomplete="off"><button>Press it</button><button class="k" id="mic" type="button" hidden>Listen</button></form>
        <form class="bar" id="f"><input id="t" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Type here, then Send"><button>Send</button></form>
        <div class="bar"><button class="k" data-k="return">Return</button><button class="k" data-k="tab">Tab</button><button class="k" data-k="delete">Delete</button><button class="k" data-k="escape">Esc</button><button class="k" id="show" type="button">Show text</button></div>
        <div id="list"></div>
        <script>
        const s=document.getElementById('s'),wrap=document.getElementById('wrap'),list=document.getElementById('list'),say=document.getElementById('say'),t=document.getElementById('t');
        let choices=[];
        function tell(w){say.textContent=w}
        async function go(o,w){tell(w||'Working…');try{const r=await fetch('/hand',{method:'POST',headers:{'Content-Type':'application/json','X-Door':'hand'},body:JSON.stringify(o)});const j=await r.json();tell(j.ok?'Done. Say the next one':j.said)}catch(e){tell('Could not reach this Mac')}setTimeout(fresh,700)}
        function pick(c){if(c.kind==='field'){go({do:'tap',x:c.x,y:c.y},'Opening '+c.label);setTimeout(()=>t.focus(),300)}else go({do:'press',label:c.label},'Pressing '+c.label)}
        function draw(){wrap.querySelectorAll('.chip').forEach(e=>e.remove());list.innerHTML='';choices.forEach((c,i)=>{const n=(i+1)+'. '+c.label;
          const b=document.createElement('button');b.className='chip '+c.kind;b.textContent=n;b.style.left=(c.x*100)+'%';b.style.top=(c.y*100)+'%';b.onclick=()=>pick(c);wrap.appendChild(b);
          const l=document.createElement('button');l.className=c.kind;l.textContent=(c.kind==='field'?'Type in: ':'')+c.label;l.setAttribute('aria-label',c.label);l.onclick=()=>pick(c);list.appendChild(l)})}
        async function fresh(){const n=new Image();n.onload=()=>{s.src=n.src};n.src='/hand/screen.jpg?'+Date.now();
          try{const j=await (await fetch('/hand/choices.json?'+Date.now())).json();choices=j.choices||[];draw()}catch(e){}}
        function words(x){return x.toLowerCase().split(/[^a-z0-9]+/).filter(w=>w&&!['press','tap','click','the','button','on','a'].includes(w))}
        const nums={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
        function heard(x){const w=words(x);if(!w.length)return null;const n=w.length===1?(+w[0]||nums[w[0]]):0;if(n&&choices[n-1])return choices[n-1];
          let best=null,score=0;choices.forEach(c=>{const cw=words(c.label);const hit=cw.filter(q=>w.includes(q)).length/Math.max(cw.length,w.length);if(hit>score){score=hit;best=c}});return best}
        document.getElementById('v').addEventListener('submit',e=>{e.preventDefault();const h=document.getElementById('heard');const c=heard(h.value);h.value='';if(c)pick(c);else tell('I did not catch which one. Say it again')});
        const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
        if(SR&&window.isSecureContext){const m=document.getElementById('mic');m.hidden=false;m.onclick=()=>{const r=new SR();r.lang='en-US';r.onresult=e=>{const x=e.results[0][0].transcript;const c=heard(x);if(c)pick(c);else tell('Heard "'+x+'". Say it again')};r.start();tell('Listening…')}}
        setInterval(()=>{if(!document.hidden)fresh()},3000);fresh();
        s.addEventListener('click',e=>{const b=s.getBoundingClientRect();go({do:'tap',x:(e.clientX-b.left)/b.width,y:(e.clientY-b.top)/b.height},'Pressing…')});
        document.getElementById('f').addEventListener('submit',e=>{e.preventDefault();if(!t.value)return;const v=t.value;t.value='';go({do:'type',text:v},'Typing…')});
        document.querySelectorAll('[data-k]').forEach(b=>b.addEventListener('click',()=>go({do:'key',key:b.dataset.k})));
        document.getElementById('show').addEventListener('click',e=>{t.type=t.type==='password'?'text':'password';e.target.textContent=t.type==='password'?'Show text':'Hide text'});
        document.getElementById('mode').addEventListener('click',e=>{document.body.classList.toggle('say');e.target.textContent=document.body.classList.contains('say')?'Just the screen':'Show buttons'});
        </script>
        """
    }

    /// A phone's hand request is only taken as JSON with the door's own header, which a page on another site cannot send without asking first.
    public static func handAllowed(_ r: Request) -> Bool {
        (r.headers["content-type"] ?? "").hasPrefix("application/json") && r.headers["x-door"] == "hand" && r.headers["origin"].map { o in
            r.headers["host"].map { o == "http://\($0)" } ?? false } ?? true
    }
}
