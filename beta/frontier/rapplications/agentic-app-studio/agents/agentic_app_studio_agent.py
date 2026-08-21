"""
Agentic App Studio — a Frontier RAPPlication.

The connective tissue for the "Build and Manage Agentic Apps" tech workshop:
pick agent.py files (from the LOCAL Brainstem, from a public RAR catalog, or
both), design a Power Apps **code app** around them, test it on a LOCAL server
against the on-device Brainstem, and — when satisfied — deploy the same app to
a connected Power Platform environment with the pac CLI. One rapplication,
shape-to-ship.

Deterministic engine. Network is used only where the task demands it (RAR
download with sha verification; pac deploy) — designing and local serving work
offline. Refusals name exactly what is missing, never guess.
"""

import json
import os
import re
import shutil
import subprocess
import urllib.request
from datetime import datetime, timezone
from html import escape as _html_escape
from hashlib import sha256

try:
    from agents.basic_agent import BasicAgent
except Exception:  # pragma: no cover
    from basic_agent import BasicAgent

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@frontier/agentic-app-studio",
    "version": "1.0.0",
    "display_name": "Agentic App Studio",
    "description": "Compose agent.py files from the local Brainstem and public RARs into a Power Apps code app: design, test on a local server, then deploy to a connected Power Platform environment.",
    "author": "AIBAST Frontier",
    "tags": ["frontier", "power-apps", "code-apps", "workshop", "agentic-apps"],
    "category": "frontier",
    "quality_tier": "frontier",
    "requires_env": [],
    "dependencies": ["@rapp/basic-agent"],
}

import signal as _signal


def _terminate(pid):
    """Cross-platform terminate: SIGTERM on POSIX, taskkill on Windows."""
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True)
    else:
        os.kill(pid, _signal.SIGTERM)


def _kill_port_hint(port):
    if os.name == "nt":
        return f'run: for /f "tokens=5" %a in (\'netstat -ano ^| findstr :{port}\') do taskkill /PID %a /F'
    return f"lsof -ti tcp:{port} | xargs kill"


HOME = os.path.expanduser(os.environ.get("AGENTIC_APP_HOME", "~/.rapp/agentic-app-studio"))
APPS = os.path.join(HOME, "apps")
STATE_FILE = os.path.join(HOME, "state.json")
LOCAL_AGENTS_DIR = os.path.expanduser(
    os.environ.get("AGENTIC_APP_LOCAL_AGENTS", "~/.brainstem/src/rapp_brainstem/agents"))
DEFAULT_RAR = "https://microsoft.github.io/aibast-agents-library/registry.json"
DEFAULT_BRAINSTEM = "http://127.0.0.1:7071"


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _slug(name):
    return re.sub(r"[^a-z0-9]+", "-", (name or "agentic-app").lower()).strip("-")[:40] or "agentic-app"


def _safe_py_name(filename, fallback_id):
    """A catalog-supplied filename is remote input: basename it, constrain the
    charset, and require .py — otherwise derive a name from the entry id. This
    is what keeps a hostile catalog from writing outside selected/ or agents/."""
    base = os.path.basename(str(filename or ""))
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.py", base):
        base = f"{_slug(fallback_id).replace('-', '_')}_agent.py"
    return base


def _same_agent(a, b):
    return a.get("origin") == b.get("origin") and a.get("id") == b.get("id")


def _unique_filename(st, entry):
    """Keep the friendly name, but if another SELECTED agent already claims this
    filename, disambiguate with a short origin hash so no file is overwritten
    and no state row is silently evicted."""
    base = entry["filename"]
    taken = {x["filename"] for x in st.get("agents", []) if not _same_agent(x, entry)}
    if base not in taken:
        return base
    tag = sha256(entry.get("origin", "").encode()).hexdigest()[:8]
    stem, dot, ext = base.rpartition(".")
    attempt = 1
    while True:
        suffix = tag if attempt == 1 else f"{tag}_{attempt}"
        candidate = f"{stem or base}__{suffix}.{ext}" if dot else f"{base}__{suffix}"
        if candidate not in taken:
            return candidate
        attempt += 1


def _load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {"agents": [], "app": None, "server": None, "deploys": []}


def _save_state(st):
    os.makedirs(HOME, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(st, fh, indent=2)
    os.replace(tmp, STATE_FILE)


def _is_allowed_store_source_url(url):
    if not isinstance(url, str) or re.search(r"\s", url):
        return False
    return bool(
        re.fullmatch(r"https://.+", url)
        or re.fullmatch(r"http://(?:127\.0\.0\.1|localhost)(?::\d+)?/.*", url)
    )


def _require_store_source_url(url, label):
    if not _is_allowed_store_source_url(url):
        raise ValueError(f"REFUSED: {label} must use HTTPS or loopback HTTP.")
    return url


def _network_opener():
    opener = urllib.request.OpenerDirector()
    opener.add_handler(urllib.request.HTTPHandler())
    opener.add_handler(urllib.request.HTTPSHandler())
    return opener


_NETWORK_OPENER = _network_opener()


def _fetch(url, as_bytes=False, timeout=30):
    safe_url = _require_store_source_url(url, "RAR URL")
    req = urllib.request.Request(safe_url, headers={"User-Agent": "agentic-app-studio"})
    with _NETWORK_OPENER.open(req, timeout=timeout) as r:
        if not 200 <= r.status < 300:
            raise ValueError(f"RAR fetch failed with HTTP {r.status}.")
        data = r.read()
    return data if as_bytes else json.loads(data.decode("utf-8"))


def _rar_entries(rar_url):
    """Both RAR catalog shapes → [{id, name, url, sha256, filename}] (pins required)."""
    safe_rar_url = _require_store_source_url(rar_url, "RAR catalog URL")
    data = _fetch(safe_rar_url)
    out = []
    if isinstance(data, dict) and isinstance(data.get("rapplications"), list):
        for e in data["rapplications"]:
            if e.get("singleton_url") and re.fullmatch(r"[0-9a-f]{64}", e.get("singleton_sha256") or ""):
                source_url = _require_store_source_url(
                    e["singleton_url"], f"RAR entry {e['id']} singleton_url")
                out.append({"id": e["id"], "name": e.get("name") or e["id"], "url": source_url,
                            "sha256": e["singleton_sha256"], "filename": e.get("singleton_filename") or f"{e['id']}_agent.py"})
    elif isinstance(data, dict) and isinstance(data.get("agents"), list):
        base = "https://raw.githubusercontent.com/microsoft/aibast-agents-library/main/" \
            if "aibast-agents-library" in safe_rar_url else safe_rar_url.rsplit("/", 1)[0] + "/"
        for a in data["agents"]:
            if a.get("_file") and re.fullmatch(r"[0-9a-f]{64}", a.get("_sha256") or ""):
                source_url = base + "/".join(urllib.request.quote(p) for p in a["_file"].split("/"))
                source_url = _require_store_source_url(
                    source_url, f"RAR entry {a.get('name') or a['_file']} source URL")
                out.append({"id": (a.get("name") or "").split("/")[-1] or a["_file"],
                            "name": a.get("display_name") or a.get("name"),
                            "url": source_url,
                            "sha256": a["_sha256"],
                            "filename": a.get("_install_filename") or a["_file"].split("/")[-1]})
    else:
        raise ValueError(f"{rar_url} is not a RAR catalog I understand (need rapplications[] or agents[] with sha pins).")
    return out


class AgenticAppStudioAgent(BasicAgent):
    def __init__(self):
        self.name = "AgenticAppStudio"
        self.metadata = {
            "name": self.name,
            "description": ("Build and manage an agentic Power Apps code app end to end. Actions: list_agents, "
                            "add_agent (local Brainstem or a public RAR), design_app, serve (local test server), "
                            "stop_server, deploy (pac CLI to a connected Power Platform environment), status."),
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string",
                               "enum": ["list_agents", "add_agent", "design_app", "serve", "stop_server", "deploy", "status"]},
                    "source": {"type": "string", "enum": ["local", "rar"],
                               "description": "add_agent: where the agent comes from."},
                    "name": {"type": "string", "description": "add_agent: local filename/agent name, or RAR entry id."},
                    "rar_url": {"type": "string", "description": "Optional RAR catalog URL (defaults to the AIBAST RAR)."},
                    "app_name": {"type": "string", "description": "design_app: display name of the code app."},
                    "brainstem_url": {"type": "string", "description": "design_app: Brainstem /chat endpoint the app talks to (default local)."},
                    "port": {"type": "integer", "description": "serve: local port (default 8930)."},
                    "environment_url": {"type": "string", "description": "deploy: Power Platform environment URL (e.g. https://org.crm.dynamics.com)."},
                },
                "required": ["action"],
            },
        }
        super().__init__(name=self.name, metadata=self.metadata)

    # ---- plumbing ----------------------------------------------------------
    def _publish(self, st):
        try:
            agents_dir = os.path.dirname(os.path.abspath(__file__))
            body = "# agentic app studio live state - inert, read-only for the local UI\n" + json.dumps(st, ensure_ascii=False)
            tmp = os.path.join(agents_dir, "studio_live_state.py.tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(body)
            os.replace(tmp, os.path.join(agents_dir, "studio_live_state.py"))
        except Exception:
            pass

    def perform(self, **kw):
        action = (kw.get("action") or "").strip()
        try:
            handler = {"list_agents": self._list, "add_agent": self._add, "design_app": self._design,
                       "serve": self._serve, "stop_server": self._stop, "deploy": self._deploy,
                       "status": self._status}.get(action)
            if handler is None:
                return ("Unknown action. I can: list_agents, add_agent, design_app, serve, stop_server, "
                        "deploy, status.")
            result = handler(kw)
            self._publish(_load_state() | {"at": _now()})
            return result
        except ValueError as e:
            return str(e)
        except Exception as e:
            return f"AgenticAppStudio error: {type(e).__name__}: {e}"

    # ---- actions -----------------------------------------------------------
    def _list(self, a):
        lines = []
        local = []
        if os.path.isdir(LOCAL_AGENTS_DIR):
            local = sorted(f for f in os.listdir(LOCAL_AGENTS_DIR)
                           if f.endswith("_agent.py") and f != "basic_agent.py")
        lines.append(f"LOCAL Brainstem ({LOCAL_AGENTS_DIR}): {len(local)} agent(s)")
        lines += [f"  - {f}" for f in local[:25]]
        rar_url = (a.get("rar_url") or DEFAULT_RAR).strip()
        try:
            entries = _rar_entries(rar_url)
            lines.append(f"RAR {rar_url}: {len(entries)} pinned agent(s)")
            lines += [f"  - {e['id']} ({e['name']})" for e in entries[:25]]
        except Exception as e:
            lines.append(f"RAR {rar_url}: unavailable ({e})")
        st = _load_state()
        lines.append(f"Selected so far: {[x['id'] for x in st['agents']] or 'none'} — add with action=add_agent.")
        return "\n".join(lines)

    def _add(self, a):
        source, name = (a.get("source") or "").strip(), (a.get("name") or "").strip()
        if source not in ("local", "rar") or not name:
            return ("add_agent needs source ('local' for this machine's Brainstem, 'rar' for a public "
                    "catalog) and name (the filename/agent name, or the RAR entry id).")
        st = _load_state()
        os.makedirs(os.path.join(HOME, "selected"), exist_ok=True)
        if source == "local":
            cand = [f for f in os.listdir(LOCAL_AGENTS_DIR)
                    if f.endswith("_agent.py") and name.lower() in f.lower()] if os.path.isdir(LOCAL_AGENTS_DIR) else []
            if len(cand) != 1:
                return (f"'{name}' matches {len(cand)} local agent file(s) "
                        f"({', '.join(cand[:6]) or 'none'}) in {LOCAL_AGENTS_DIR} — give me a unique name.")
            src = os.path.join(LOCAL_AGENTS_DIR, cand[0])
            data = open(src, "rb").read()
            entry = {"id": cand[0][:-3], "filename": _safe_py_name(cand[0], cand[0][:-3]),
                     "origin": f"local:{src}", "sha256": sha256(data).hexdigest()}
            entry["filename"] = _unique_filename(st, entry)
        else:
            rar_url = (a.get("rar_url") or DEFAULT_RAR).strip()
            matches = [e for e in _rar_entries(rar_url) if e["id"].lower() == name.lower()]
            if not matches:
                return f"No RAR entry '{name}' in {rar_url}. Use action=list_agents to see the ids."
            e = matches[0]
            source_url = _require_store_source_url(e["url"], f"RAR entry {e['id']} singleton_url")
            data = _fetch(source_url, as_bytes=True)
            digest = sha256(data).hexdigest()
            if digest != e["sha256"]:
                return (f"REFUSED: {e['id']} downloaded bytes do not match the catalog singleton_sha256 "
                        "— not adding an unverified agent.")
            entry = {"id": e["id"], "filename": _safe_py_name(e["filename"], e["id"]),
                     "origin": f"rar:{e['url']}", "sha256": digest}
            entry["filename"] = _unique_filename(st, entry)
        with open(os.path.join(HOME, "selected", entry["filename"]), "wb") as fh:
            fh.write(data)
        # Dedup by real identity (origin+id), not by filename — two agents whose
        # basenames collide are distinct and both must survive.
        st["agents"] = [x for x in st["agents"] if not _same_agent(x, entry)] + [entry]
        _save_state(st)
        return (f"Added {entry['id']} ({source}, sha {entry['sha256'][:12]}…). "
                f"{len(st['agents'])} agent(s) selected. design_app when ready.")

    def _design(self, a):
        st = _load_state()
        if not st["agents"]:
            return "No agents selected yet — add at least one with action=add_agent (local or rar), then design_app."
        name = (a.get("app_name") or "Agentic Workshop App").strip()
        slug = _slug(name)
        endpoint = (a.get("brainstem_url") or DEFAULT_BRAINSTEM).rstrip("/")
        root = os.path.join(APPS, slug)
        os.makedirs(os.path.join(root, "app"), exist_ok=True)
        os.makedirs(os.path.join(root, "src"), exist_ok=True)
        os.makedirs(os.path.join(root, "agents"), exist_ok=True)
        for x in st["agents"]:
            shutil.copy2(os.path.join(HOME, "selected", x["filename"]), os.path.join(root, "agents", x["filename"]))
        config = {"appName": name, "brainstemUrl": endpoint, "proxyChat": True,
                  "agents": [{"id": x["id"], "filename": x["filename"], "sha256": x["sha256"], "origin": x["origin"]}
                             for x in st["agents"]],
                  "designedAt": _now()}
        with open(os.path.join(root, "app", "app-config.json"), "w", encoding="utf-8") as fh:
            json.dump(config, fh, indent=2)
        with open(os.path.join(root, "app", "index.html"), "w", encoding="utf-8") as fh:
            fh.write(LOCAL_APP_HTML.replace("__APP_NAME__", _html_escape(name)))
        with open(os.path.join(root, "app", "serve.py"), "w", encoding="utf-8") as fh:
            fh.write(LOCAL_SERVER_PY)
        for rel, content in code_app_scaffold(name, slug).items():
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w", encoding="utf-8") as fh:
                fh.write(content)
        st["app"] = {"name": name, "slug": slug, "root": root, "endpoint": endpoint, "designedAt": config["designedAt"]}
        _save_state(st)
        return (f"Designed '{name}' at {root} with {len(st['agents'])} agent(s).\n"
                f"- Local test app: app/index.html (serve it with action=serve — talks to {endpoint}/chat)\n"
                f"- Power Apps code app scaffold: src/ + package.json + vite.config.ts + DEPLOY.md\n"
                f"- Agent provenance (sha-pinned copies): agents/\n"
                f"Test locally first; deploy when satisfied.")

    def _serve(self, a):
        st = _load_state()
        if not st.get("app"):
            return "Nothing to serve — design_app first."
        if st.get("server") and st["server"].get("pid"):
            try:
                os.kill(st["server"]["pid"], 0)
                return f"Already serving at {st['server']['url']} (pid {st['server']['pid']}). stop_server to stop."
            except OSError:
                pass
        port = int(a.get("port") or 8930)
        app_dir = os.path.join(st["app"]["root"], "app")
        # A stale listener on the port would serve files that LOOK right — probe
        # for our proxy marker and refuse a port owned by anything else.
        try:
            marker = _fetch(f"http://127.0.0.1:{port}/__proxy__", timeout=3)
            if marker.get("proxy") == "agentic-app-studio":
                st["server"] = {"pid": None, "port": port, "url": f"http://127.0.0.1:{port}/", "startedAt": _now()}
                _save_state(st)
                return f"A studio proxy is already serving on port {port} — reusing it."
        except Exception:
            import socket
            probe = socket.socket()
            try:
                probe.bind(("127.0.0.1", port))
                probe.close()
            except OSError:
                return (f"REFUSED: port {port} is occupied by something that is not this studio's proxy. "
                        f"Stop it ({_kill_port_hint(port)}) or serve with a different port.")
        # serve.py = static files + a server-side /chat proxy to the Brainstem, so
        # the app's browser requests stay SAME-ORIGIN (the kernel's foreign-browser
        # guard rightly refuses cross-origin browser calls).
        proc = subprocess.Popen(["python3", "serve.py", str(port), st["app"]["endpoint"]],
                                cwd=app_dir, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                start_new_session=(os.name != "nt"),
                                creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0))
        url = f"http://127.0.0.1:{port}/"
        for _ in range(20):
            try:
                if _fetch(url + "__proxy__").get("proxy") == "agentic-app-studio":
                    break
            except Exception:
                import time; time.sleep(0.25)
        else:
            proc.terminate()
            return f"Local server did not answer on port {port} — is something else bound there?"
        st["server"] = {"pid": proc.pid, "port": port, "url": url, "startedAt": _now()}
        _save_state(st)
        return (f"'{st['app']['name']}' is running locally at {url} (pid {proc.pid}, this device only). "
                f"Open it, chat with your agents through {st['app']['endpoint']}/chat, and when satisfied run action=deploy.")

    def _stop(self, a):
        st = _load_state()
        srv = st.get("server")
        if not srv or not srv.get("pid"):
            return "No local server is recorded as running."
        try:
            _terminate(srv["pid"])
            msg = f"Stopped the local server (pid {srv['pid']})."
        except OSError:
            msg = "The recorded server was already gone."
        st["server"] = None
        _save_state(st)
        return msg

    def _deploy(self, a):
        st = _load_state()
        if not st.get("app"):
            return "Nothing to deploy — design_app first, test it locally with serve, then deploy."
        pac = shutil.which("pac") or (os.path.expanduser("~/.dotnet/tools/pac")
                                      if os.path.exists(os.path.expanduser("~/.dotnet/tools/pac")) else None)
        if not pac:
            return ("REFUSED: the Power Platform CLI (pac) is not installed. Install it "
                    "(https://aka.ms/PowerAppsCLI or `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`), "
                    "then `pac auth create --environment <url>` and run deploy again. Nothing was sent anywhere.")
        auth = subprocess.run([pac, "auth", "list"], capture_output=True, text=True, timeout=60)
        if auth.returncode != 0 or "No profiles" in (auth.stdout + auth.stderr):
            env_hint = a.get("environment_url") or "<your-environment-url>"
            return (f"REFUSED: pac has no authenticated profile. Run `pac auth create --environment {env_hint}` "
                    "(interactive sign-in), then deploy again. Nothing was sent anywhere.")
        root = st["app"]["root"]
        log_path = os.path.join(root, "deploy.log")
        steps = []
        if not os.path.exists(os.path.join(root, "power.config.json")):
            steps.append([pac, "code", "init", "--displayName", st["app"]["name"]])
        steps.append(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"])
        steps.append(["npm", "run", "build"])          # pac code push needs ./dist to exist
        steps.append([pac, "code", "push"])
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(f"\n==== deploy {_now()} ====\n")
            for cmd in steps:
                log.write("$ " + " ".join(cmd) + "\n")
                r = subprocess.run(cmd, cwd=root, capture_output=True, text=True, timeout=900)
                log.write(r.stdout + r.stderr)
                # pac can exit 0 while failing (e.g. "Build path ./dist does not
                # exist") — treat its own error text as failure too.
                failed_text = ("does not exist" in (r.stdout + r.stderr)) or ("Error:" in (r.stdout + r.stderr)) if cmd[0] == pac else False
                if r.returncode != 0 or failed_text:
                    tail = ((r.stderr or "") + (r.stdout or "")).strip().splitlines()[-6:]
                    st["deploys"].append({"at": _now(), "ok": False, "step": " ".join(cmd)})
                    _save_state(st)
                    return ("Deploy stopped at `" + " ".join(cmd) + "` (exit " + str(r.returncode) + "):\n"
                            + "\n".join(tail) + f"\nFull log: {log_path}. Fix that step and run deploy again.")
        url_match = None
        try:
            tail_text = open(log_path, encoding="utf-8").read()[-6000:]
            m = re.findall(r"https://\S*powerapps\S*", tail_text)
            url_match = m[-1].rstrip(".,)") if m else None
        except Exception:
            pass
        # Trust nothing: the app must actually be listed in the environment.
        listed = subprocess.run([pac, "code", "list"], cwd=root, capture_output=True, text=True, timeout=120)
        if st["app"]["name"].lower() not in (listed.stdout or "").lower():
            st["deploys"].append({"at": _now(), "ok": False, "step": "verify: pac code list"})
            _save_state(st)
            return ("Deploy ran but VERIFICATION FAILED: '" + st["app"]["name"] + "' is not in `pac code list` "
                    f"for the connected environment. Log: {log_path} — read it before trusting anything.")
        st["deploys"].append({"at": _now(), "ok": True, "url": url_match, "verified": "pac code list"})
        _save_state(st)
        return ("Deployed AND VERIFIED '" + st["app"]["name"] + "' in the connected environment (pac code list). "
                + (f"App: {url_match}. " if url_match else "") + f"Log: {log_path}.")

    def _status(self, a):
        st = _load_state()
        app = st.get("app")
        srv = st.get("server")
        return json.dumps({
            "agents_selected": [x["id"] for x in st["agents"]],
            "app": app and {"name": app["name"], "root": app["root"], "endpoint": app["endpoint"]},
            "local_server": srv and srv.get("url"),
            "deploys": st.get("deploys", [])[-3:],
            "device_home": HOME,
        }, indent=2)


# ---- generated artifacts ----------------------------------------------------
LOCAL_APP_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__APP_NAME__</title>
<style>
:root{--ground:#0d1117;--panel:#161b22;--raised:#1c1e23;--border:#26282d;--t1:#e6edf3;--t2:#c8c9cc;--t3:#8b8f98;--blue:#58a6ff;--action:#3d7cf0}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--ground);color:var(--t1);font:13.5px Inter,ui-sans-serif,system-ui,sans-serif;display:flex;flex-direction:column;height:100vh}
header{padding:12px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center}
header h1{font-size:15px}header .tag{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--blue);border:1px solid #2b4a7a;background:#0f1a2b;border-radius:6px;padding:2px 7px}
main{flex:1;display:flex;min-height:0}
aside{width:230px;border-right:1px solid var(--border);padding:12px;overflow:auto}
aside h2{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--t3);margin-bottom:8px}
aside .a{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:12px;color:var(--t2)}
#log{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:78%;padding:9px 12px;border-radius:11px;font-size:13px;white-space:pre-wrap}
.you{align-self:flex-end;background:linear-gradient(180deg,#3d7cf0,#356fe0);color:#fff;border-bottom-right-radius:4px}
.bot{align-self:flex-start;background:var(--raised);border:1px solid #2a2d33;border-bottom-left-radius:4px;color:var(--t2)}
form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border)}
input{flex:1;background:var(--raised);border:1px solid #30363d;border-radius:9px;color:var(--t1);padding:10px 12px;font:inherit}
button{font:600 13px Inter,system-ui,sans-serif;padding:10px 18px;border-radius:9px;border:none;background:var(--action);color:#fff;cursor:pointer}
footer{font-size:10.5px;color:var(--t3);padding:6px 16px;border-top:1px solid var(--border)}
</style></head><body>
<header><h1>__APP_NAME__</h1><span class="tag">local test · code app preview</span></header>
<main><aside><h2>Agents on board</h2><div id="roster">loading…</div></aside>
<div style="flex:1;display:flex;flex-direction:column;min-width:0"><div id="log"></div>
<form id="f"><input id="q" placeholder="Ask your agents…" autocomplete="off"><button>Send</button></form></div></main>
<footer>Runs against your local Brainstem. Deployed builds point at the endpoint in app-config.json.</footer>
<script>
// ── AgenticDrive: the app's own automation bus. The rapplication that
// generated this app (or any parent embedding it in an iframe) can drive it:
//   parent → app : postMessage({type:"agentic-drive", id, cmd:"ask", text}) | {cmd:"status"}
//   app → parent : postMessage({type:"agentic-event", id, event, ...})
// Only the embedding parent may drive: a message is ignored unless it came from
// that window AND from its origin, and replies go to that origin, never "*".
// Every command answers exactly once carrying the id it was given — including
// failures and unknown commands — so a dropped command is visible, not silent.
// Also exposed as window.AgenticDrive for direct automation. Explicit and
// visible by design — an agentic app should be drivable, not scraped.
let cfg={brainstemUrl:"http://127.0.0.1:7071",agents:[]};
fetch("app-config.json").then(r=>r.json()).then(c=>{cfg=c;
  // Catalog-supplied strings are DATA: build the roster with textContent only.
  const roster=document.getElementById("roster");roster.textContent=c.agents.length?"":"none";
  for(const a of c.agents){const d=document.createElement("div");d.className="a";
    const n=document.createElement("div");n.textContent=a.id;
    const sh=document.createElement("span");sh.style.cssText="color:#6e7681;font-size:10px";
    sh.textContent=(a.sha256||"").slice(0,12)+"…";
    d.append(n,sh);roster.appendChild(d);}});
const log=document.getElementById("log");
function add(cls,text){const d=document.createElement("div");d.className="msg "+cls;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d;}
async function ask(q,id){
  add("you",q);const w=add("bot","…");emit({event:"asked",text:q},id);
  const chatUrl=cfg.proxyChat?"chat":cfg.brainstemUrl.replace(/\\/$/,"")+"/chat";
  try{const r=await fetch(chatUrl,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user_input:q,user_guid:"agentic-app"})});
    const d=await r.json();w.textContent=d.response||d.error||("HTTP "+r.status);
    emit({event:"answered",text:w.textContent},id);}
  catch(err){w.textContent="Brainstem unreachable at "+cfg.brainstemUrl+" — is it running? ("+err.message+")";
    emit({event:"error",text:w.textContent},id);}}
const PARENT_ORIGIN=(()=>{try{const a=location.ancestorOrigins;if(a&&a.length)return a[0];}catch(e){}
  try{if(document.referrer)return new URL(document.referrer).origin;}catch(e){}return null;})();
function emit(m,id){try{if(parent===window||!PARENT_ORIGIN)return;
  const p=Object.assign({type:"agentic-event",app:cfg.appName},m);if(id!==undefined&&id!==null)p.id=id;
  parent.postMessage(p,PARENT_ORIGIN);}catch(e){}}
window.AgenticDrive={ask,status:()=>({app:cfg.appName,agents:cfg.agents.map(a=>a.id),messages:log.children.length})};
window.addEventListener("message",e=>{const m=e.data;if(!m||m.type!=="agentic-drive")return;
  if(e.source!==parent)return;
  if(PARENT_ORIGIN&&e.origin!==PARENT_ORIGIN)return;
  const id=m.id;
  try{
    if(m.cmd==="ask"&&m.text){document.getElementById("q").value=m.text;ask(m.text,id);document.getElementById("q").value="";}
    else if(m.cmd==="status")emit(Object.assign({event:"status"},window.AgenticDrive.status()),id);
    else emit({event:"error",text:"unknown command: "+String(m.cmd)},id);
  }catch(err){emit({event:"error",text:String((err&&err.message)||err)},id);}});
document.getElementById("f").addEventListener("submit",e=>{e.preventDefault();
  const q=document.getElementById("q").value.trim();if(!q)return;document.getElementById("q").value="";ask(q);});
emit({event:"ready"});
</script></body></html>
"""


LOCAL_SERVER_PY = """#!/usr/bin/env python3
\"\"\"Local test server for the generated agentic app: static files + a
server-side /chat proxy to the configured Brainstem. The proxy keeps the
browser same-origin; the kernel sees a local non-browser request.\"\"\"
import json, sys, urllib.request
from http.server import HTTPServer, SimpleHTTPRequestHandler

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8930
BRAINSTEM = (sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:7071").rstrip("/")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/__proxy__"):
            out = json.dumps({"proxy": "agentic-app-studio", "brainstem": BRAINSTEM}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        super().do_GET()

    def do_POST(self):
        if self.path.rstrip("/") != "/chat":
            self.send_error(404); return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        try:
            req = urllib.request.Request(BRAINSTEM + "/chat", data=body,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                out = r.read(); code = r.status
        except urllib.error.HTTPError as e:
            out = e.read(); code = e.code
        except Exception as e:
            out = json.dumps({"error": f"Brainstem unreachable at {BRAINSTEM}: {e}"}).encode(); code = 502
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
"""


def code_app_scaffold(name, slug):
    """Power Apps code-app project files (vite + react-ts + Power SDK wiring)."""
    name = str(name)
    html_name = _html_escape(name)
    js_name = json.dumps(name)
    markdown_name = _html_escape(json.dumps(name))
    return {
        "package.json": json.dumps({
            "name": slug, "private": True, "version": "0.1.0", "type": "module",
            "scripts": {"dev": "vite", "build": "tsc -b && vite build", "preview": "vite preview"},
            "dependencies": {"react": "18.3.1", "react-dom": "18.3.1"},
            "devDependencies": {"@types/react": "18.3.3", "@types/react-dom": "18.3.0",
                                 "@vitejs/plugin-react": "4.3.1", "typescript": "5.5.3", "vite": "5.4.0"},
        }, indent=2) + "\n",
        "vite.config.ts": ("import { defineConfig } from \"vite\";\nimport react from \"@vitejs/plugin-react\";\n"
                            "export default defineConfig({ plugins: [react()], base: \"./\", server: { port: 3000 } });\n"),
        "tsconfig.json": json.dumps({"compilerOptions": {"target": "ES2020", "lib": ["ES2020", "DOM"], "jsx": "react-jsx",
                                                          "module": "ESNext", "moduleResolution": "bundler", "strict": True,
                                                          "skipLibCheck": True, "noEmit": True}, "include": ["src"]}, indent=2) + "\n",
        "index.html": ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"/>"
                        f"<title>{html_name}</title></head><body><div id=\"root\"></div>"
                        "<script type=\"module\" src=\"/src/main.tsx\"></script></body></html>\n"),
        "src/main.tsx": ("import React from \"react\";\nimport { createRoot } from \"react-dom/client\";\n"
                          "import App from \"./App\";\nimport PowerProvider from \"./PowerProvider\";\n"
                          "createRoot(document.getElementById(\"root\")!).render(\n"
                          "  <React.StrictMode><PowerProvider><App /></PowerProvider></React.StrictMode>,\n);\n"),
        "src/PowerProvider.tsx": ("// Wires the app into the Power Apps code-apps host when deployed; a no-op shell\n"
                                    "// locally so the SAME app runs on the local server and in Power Apps.\n"
                                    "import { ReactNode } from \"react\";\n"
                                    "export default function PowerProvider({ children }: { children: ReactNode }) {\n"
                                    "  return <>{children}</>;\n}\n"),
        "src/App.tsx": (f"""// Agentic chat over the configured Brainstem endpoint.
// Locally that is the on-device Brainstem; a deployed build must point at a
// reachable endpoint (set brainstemUrl in app/app-config.json before push).
import {{ useEffect, useState }} from "react";
type Msg = {{ who: "you" | "bot"; text: string }};
const APP_NAME = {js_name};
export default function App() {{
  const [cfg, setCfg] = useState<{{ brainstemUrl: string; agents: {{ id: string }}[] }}>({{ brainstemUrl: "http://127.0.0.1:7071", agents: [] }});
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {{ fetch("../app/app-config.json").then(r => r.json()).then(setCfg).catch(() => {{}}); }}, []);
  async function send() {{
    if (!q.trim()) return;
    const mine = q; setQ(""); setMsgs(m => [...m, {{ who: "you", text: mine }}]);
    try {{
      const r = await fetch(cfg.brainstemUrl.replace(/\\/$/, "") + "/chat", {{ method: "POST",
        headers: {{ "Content-Type": "application/json" }},
        body: JSON.stringify({{ user_input: mine, user_guid: "agentic-app" }}) }});
      const d = await r.json();
      setMsgs(m => [...m, {{ who: "bot", text: d.response || d.error || ("HTTP " + r.status) }}]);
    }} catch (e) {{
      setMsgs(m => [...m, {{ who: "bot", text: "Brainstem unreachable at " + cfg.brainstemUrl }}]);
    }}
  }}
  return (<div style={{{{ fontFamily: "Segoe UI, sans-serif", maxWidth: 720, margin: "0 auto", padding: 16 }}}}>
    <h1>{{APP_NAME}}</h1>
    <p>{{cfg.agents.length}} agent(s) on board.</p>
    <div style={{{{ minHeight: 320, border: "1px solid #ddd", borderRadius: 8, padding: 12 }}}}>
      {{msgs.map((m, i) => <p key={{i}}><b>{{m.who}}:</b> {{m.text}}</p>)}}
    </div>
    <input value={{q}} onChange={{e => setQ(e.target.value)}} onKeyDown={{e => e.key === "Enter" && send()}}
      placeholder="Ask your agents…" style={{{{ width: "80%", padding: 8 }}}} />
    <button onClick={{send}} style={{{{ padding: 8 }}}}>Send</button>
  </div>);
}}
"""),
        "DEPLOY.md": (f"""# Deploying <code>{markdown_name}</code> to Power Platform

Local test first: `serve` in the Studio (static preview in app/), or `npm install && npm run dev`
here for the real code-app dev loop on http://localhost:3000.

Deploy (the Studio's `deploy` action runs exactly this):
1. `pac auth create --environment <https://yourorg.crm.dynamics.com>` — once per environment.
2. `pac code init --displayName "DISPLAY_NAME"` — first deploy only; replace `DISPLAY_NAME`
   with the display name shown above (creates power.config.json).
3. `npm install --ignore-scripts --no-audit --no-fund`
4. `npm run build`
5. `pac code push` — publishes the code app to the connected environment.

Dependency lifecycle scripts are disabled during deploy by design because npm runs on a
tenant-authenticated host. For full dependency-tree reproducibility, commit the generated
`package-lock.json` alongside this scaffold.

A deployed build cannot reach `127.0.0.1` — point `app/app-config.json` `brainstemUrl` at a
reachable Brainstem (e.g. the Azure Functions tier) before pushing, or the app will say so honestly.
"""),
    }
