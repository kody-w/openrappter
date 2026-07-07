"""OpenRappter Brainstem — the local-device-first rappter.

A wire-compatible mirror of the RAPP brainstem kernel (kody-w/rapp-installer,
rapp_brainstem/brainstem.py): same routes, same JSON envelopes, same
single-file agent contract, same import shims — so anything trained against a
RAPP brainstem (skills, tools, prompts, agents) works here unchanged. This is
the foundation a user installs on their own device and builds out: drop a
``*_agent.py`` into the agents folder and it is live on the next request.

Kernel-parity surface:
    POST /chat                     {user_input, conversation_history?, session_id?}
    GET  /health                   status, version, agents, model, copilot
    GET  /version
    GET  /agents                   files + loaded agent names
    POST /agents/import            multipart file upload (renamed to *_agent.py)
    GET  /agents/export/<file>     raw agent source
    DELETE /agents/<file>
    GET  /models

Run:  python -m openrappter.brainstem          (PORT env overrides, default 7072;
                                                set PORT=7071 for full drop-in
                                                where a RAPP brainstem would sit)
"""

import glob
import importlib.util
import json
import os
import re
import subprocess
import sys
import types
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from openrappter import __version__


def _http_json(url, headers, payload=None, timeout=60):
    """Stdlib HTTP helper — the brainstem carries zero dependencies."""
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers=headers,
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))

EMOJI = "🦖"
BRAINSTEM_HOME = Path(os.environ.get("OPENRAPPTER_HOME", Path.home() / ".openrappter")) / "brainstem"
AGENTS_PATH = Path(os.environ.get("OPENRAPPTER_BRAINSTEM_AGENTS", BRAINSTEM_HOME / "agents"))
SOUL_PATH = Path(os.environ.get("OPENRAPPTER_SOUL", BRAINSTEM_HOME.parent / "soul.md"))
DEFAULT_PORT = int(os.environ.get("PORT", os.environ.get("OPENRAPPTER_BRAINSTEM_PORT", "7072")))
MODEL = os.environ.get("OPENRAPPTER_MODEL", "claude-sonnet-5")
MAX_TOOL_ROUNDS = 5

# ── Local storage shim (kernel: utils.azure_file_storage → local_storage) ────


class LocalStorageManager:
    """Kernel-compatible storage surface backed by a local JSON file."""

    def __init__(self, *args, **kwargs):
        self._path = BRAINSTEM_HOME / "memory.json"
        self._context = None

    def _file(self):
        name = f"memory_{self._context}.json" if self._context else "memory.json"
        return BRAINSTEM_HOME / name

    def read_json(self, *args, **kwargs):
        try:
            return json.loads(self._file().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def write_json(self, data, *args, **kwargs):
        BRAINSTEM_HOME.mkdir(parents=True, exist_ok=True)
        self._file().write_text(json.dumps(data, indent=2), encoding="utf-8")

    def set_memory_context(self, context=None, *args, **kwargs):
        self._context = context

    def ensure_directory_exists(self, *args, **kwargs):
        BRAINSTEM_HOME.mkdir(parents=True, exist_ok=True)


# ── Shims — identical import surface to the RAPP kernel ──────────────────────

_shims_registered = False


def register_shims():
    """RAPP-authored agents import `agents.basic_agent` or `basic_agent`;
    both resolve to OpenRappter's BasicAgent, mirroring how the RAPP kernel
    shims `openrappter.agents.basic_agent` to ITS BasicAgent."""
    global _shims_registered
    if _shims_registered:
        return
    from openrappter.agents.basic_agent import BasicAgent

    ba_mod = types.ModuleType("basic_agent")
    ba_mod.BasicAgent = BasicAgent
    sys.modules.setdefault("basic_agent", ba_mod)

    agents_mod = types.ModuleType("agents")
    agents_mod.__path__ = [str(AGENTS_PATH)]
    sys.modules.setdefault("agents", agents_mod)
    sub = types.ModuleType("agents.basic_agent")
    sub.BasicAgent = BasicAgent
    sys.modules.setdefault("agents.basic_agent", sub)
    sys.modules["agents"].basic_agent = sub

    utils_mod = types.ModuleType("utils")
    utils_mod.__path__ = []
    sys.modules.setdefault("utils", utils_mod)
    afs = types.ModuleType("utils.azure_file_storage")
    afs.AzureFileStorageManager = LocalStorageManager
    sys.modules.setdefault("utils.azure_file_storage", afs)
    utils_mod.azure_file_storage = afs

    _shims_registered = True


# ── Agent loading — the kernel's exact contract ──────────────────────────────


def _load_agent_from_file(filepath):
    """Kernel contract: load classes with a `perform` attr, zero-arg
    instantiation, register by instance.name. Errors fail the file, not the server."""
    agents = {}
    register_shims()
    try:
        mod_name = f"agent_{os.path.basename(filepath).replace('.', '_')}_{abs(hash(filepath))}"
        spec = importlib.util.spec_from_file_location(mod_name, filepath)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for attr in dir(mod):
            cls = getattr(mod, attr)
            if (
                isinstance(cls, type)
                and hasattr(cls, "perform")
                and attr not in ("BasicAgent", "object")
                and not attr.startswith("_")
            ):
                instance = cls()
                agents[instance.name] = instance
    except Exception as e:  # noqa: BLE001 — a broken drop-in must not kill the server
        print(f"[openrappter-brainstem] Failed to load {filepath}: {e}")
    return agents


def load_agents():
    """Packaged OpenRappter agents form the default pool; user drop-ins in the
    brainstem agents dir override by name (hot-loaded on every request)."""
    agents = {}
    packaged = Path(__file__).parent / "agents"
    for source_dir in (packaged, AGENTS_PATH):
        for filepath in sorted(glob.glob(str(source_dir / "*_agent.py"))):
            if os.path.basename(filepath) == "basic_agent.py":
                continue
            agents.update(_load_agent_from_file(filepath))
    return agents


def to_tool(agent):
    return {
        "type": "function",
        "function": {
            "name": agent.name,
            "description": agent.metadata.get("description", ""),
            "parameters": agent.metadata.get("parameters", {"type": "object", "properties": {}}),
        },
    }


# ── Soul ──────────────────────────────────────────────────────────────────────


def load_soul():
    try:
        return SOUL_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return "You are OpenRappter, a helpful local-first AI assistant."


# ── Copilot (same handshake the RAPP kernel uses) ────────────────────────────

_copilot_cache = {"token": None, "endpoint": None}


def _github_token():
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        return token.strip()
    try:
        out = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10)
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def copilot_session():
    """Exchange a GitHub token for a Copilot API token + endpoint.
    Auth-header prefix and endpoint discovery match the RAPP kernel."""
    if _copilot_cache["token"]:
        return _copilot_cache
    gh = _github_token()
    if not gh:
        return None
    prefix = "token" if gh.startswith("ghu_") else "Bearer"
    try:
        status, data = _http_json(
            "https://api.github.com/copilot_internal/v2/token",
            headers={
                "Authorization": f"{prefix} {gh}",
                "Editor-Version": "vscode/1.95.0",
                "Editor-Plugin-Version": "copilot/1.0.0",
                "User-Agent": "GitHubCopilotChat/0.22.2024",
            },
            timeout=15,
        )
    except (urllib.error.URLError, ValueError, OSError):
        return None
    if status != 200:
        return None
    _copilot_cache["token"] = data.get("token")
    _copilot_cache["endpoint"] = (data.get("endpoints") or {}).get("api", "https://api.githubcopilot.com")
    return _copilot_cache


def llm_chat(messages, tools):
    session = copilot_session()
    if not session:
        raise RuntimeError("Copilot not authenticated — set GITHUB_TOKEN or run `gh auth login`")
    try:
        status, data = _http_json(
            f"{session['endpoint']}/chat/completions",
            headers={
                "Authorization": f"Bearer {session['token']}",
                "Editor-Version": "vscode/1.95.0",
                "Editor-Plugin-Version": "copilot/1.0.0",
                "User-Agent": "GitHubCopilotChat/0.22.2024",
                "Copilot-Integration-Id": "vscode-chat",
                "Content-Type": "application/json",
            },
            payload={"model": MODEL, "messages": messages, "tools": tools or None, "max_tokens": 2000},
            timeout=120,
        )
    except urllib.error.HTTPError as e:
        if e.code == 401:
            _copilot_cache["token"] = None  # force re-exchange next call
            raise RuntimeError("Copilot token expired") from e
        raise RuntimeError(f"Copilot chat failed: HTTP {e.code}") from e
    if status != 200:
        raise RuntimeError(f"Copilot chat failed: HTTP {status}")
    return data["choices"][0]["message"]


def run_chat(user_input, history, session_id):
    """The kernel's /chat tool loop: soul + agents-as-tools + tool_call rounds."""
    agents = load_agents()
    tools = [to_tool(a) for a in agents.values()]
    messages = [{"role": "system", "content": load_soul()}]
    messages.extend(h for h in history if isinstance(h, dict) and h.get("role") in ("user", "assistant"))
    messages.append({"role": "user", "content": user_input})

    agent_logs = []
    for _ in range(MAX_TOOL_ROUNDS):
        reply = llm_chat(messages, tools)
        calls = reply.get("tool_calls")
        if not calls:
            return {
                "response": reply.get("content", ""),
                "agent_logs": "\n".join(agent_logs),
                "model": MODEL,
                "session_id": session_id,
            }
        messages.append(reply)
        for call in calls:
            name = call["function"]["name"]
            try:
                kwargs = json.loads(call["function"].get("arguments") or "{}")
            except ValueError:
                kwargs = {}
            agent = agents.get(name)
            if agent is None:
                result = json.dumps({"status": "error", "message": f"Unknown agent: {name}"})
            else:
                try:
                    result = str(agent.perform(**kwargs))
                except Exception as e:  # noqa: BLE001
                    result = json.dumps({"status": "error", "message": str(e)})
            agent_logs.append(f"[{name}] {result}")
            messages.append({"role": "tool", "tool_call_id": call.get("id", name), "content": result})

    return {
        "response": "Tool loop limit reached.",
        "agent_logs": "\n".join(agent_logs),
        "model": MODEL,
        "session_id": session_id,
    }


# ── HTTP server (stdlib — the wire is the contract, not the framework) ───────


class BrainstemHandler(BaseHTTPRequestHandler):
    server_version = f"OpenRappterBrainstem/{__version__}"

    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # quiet request logging
        pass

    # ── GET ──
    def do_GET(self):
        if self.path == "/health":
            agents = load_agents()
            self._send(200, {
                "status": "ok",
                "version": __version__,
                "agents": sorted(agents.keys()),
                "brainstem_dir": str(BRAINSTEM_HOME),
                "soul": str(SOUL_PATH),
                "model": MODEL,
                "copilot": "✓" if copilot_session() else "✗",
            })
        elif self.path == "/version":
            self._send(200, {"version": __version__})
        elif self.path == "/models":
            self._send(200, {"models": [MODEL], "active": MODEL})
        elif self.path == "/agents":
            results = []
            packaged = Path(__file__).parent / "agents"
            for source_dir in (packaged, AGENTS_PATH):
                for f in sorted(glob.glob(str(source_dir / "*.py"))):
                    filename = os.path.basename(f)
                    if filename.startswith("__") or filename == "basic_agent.py":
                        continue
                    results.append({"filename": filename, "agents": sorted(_load_agent_from_file(f).keys())})
            self._send(200, {"files": results})
        elif self.path.startswith("/agents/export/"):
            filename = os.path.basename(self.path[len("/agents/export/"):])
            for source_dir in (AGENTS_PATH, Path(__file__).parent / "agents"):
                target = source_dir / filename
                if target.is_file():
                    body = target.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/x-python")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
            self._send(404, {"error": f"Agent file not found: {filename}"})
        elif self.path == "/":
            self._send(200, {"name": "OpenRappter Brainstem", "version": __version__,
                             "docs": "POST /chat · GET /health /agents · POST /agents/import"})
        else:
            self._send(404, {"error": "Not found"})

    # ── POST ──
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if self.path == "/chat":
            try:
                data = json.loads(raw or b"{}")
            except ValueError:
                data = None
            if not isinstance(data, dict):
                return self._send(400, {"error": "Request body must be a JSON object"})
            user_input = (data.get("user_input") or "").strip() if isinstance(data.get("user_input"), str) else ""
            if not user_input:
                return self._send(400, {"error": "user_input is required"})
            history = data.get("conversation_history") if isinstance(data.get("conversation_history"), list) else []
            session_id = data.get("session_id") or str(uuid.uuid4())
            try:
                return self._send(200, run_chat(user_input, history, session_id))
            except Exception as e:  # noqa: BLE001
                return self._send(503, {"error": str(e), "session_id": session_id})

        if self.path == "/agents/import":
            content_type = self.headers.get("Content-Type", "")
            match = re.search(r'filename="([^"]+)"', raw.decode("utf-8", errors="replace"))
            if "multipart/form-data" not in content_type or not match:
                return self._send(400, {"error": "No file uploaded"})
            filename = os.path.basename(match.group(1))
            if not filename.endswith(".py"):
                return self._send(400, {"error": "Only .py files are supported"})
            # Extract the file part's body (between the first blank line after
            # the filename header and the closing boundary)
            boundary = content_type.split("boundary=")[-1].encode()
            part = raw.split(b'filename="' + match.group(1).encode() + b'"', 1)[1]
            body = part.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n--" + boundary, 1)[0]
            if not filename.endswith("_agent.py"):
                filename = filename[:-3] + "_agent.py"
            AGENTS_PATH.mkdir(parents=True, exist_ok=True)
            (AGENTS_PATH / filename).write_bytes(body)
            loaded = _load_agent_from_file(str(AGENTS_PATH / filename))
            if not loaded:
                return self._send(200, {"error": f"Saved {filename}, but it did not load as an agent — check the file for errors."})
            return self._send(200, {"status": "ok", "message": f"Agent {filename} imported successfully."})

        self._send(404, {"error": "Not found"})

    # ── DELETE ──
    def do_DELETE(self):
        if self.path.startswith("/agents/"):
            filename = os.path.basename(self.path[len("/agents/"):])
            target = AGENTS_PATH / filename
            if target.is_file():
                target.unlink()
                return self._send(200, {"status": "ok", "message": f"Deleted {filename}"})
            return self._send(404, {"error": f"Agent file not found: {filename} (packaged agents cannot be deleted)"})
        self._send(404, {"error": "Not found"})


class BrainstemServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer.server_bind calls socket.getfqdn(), a reverse-DNS lookup
        # that can hang ~30s per bind on macOS. The brainstem doesn't need an
        # FQDN — bind the socket and record the address directly.
        import socketserver

        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port


def serve(port=DEFAULT_PORT, host=os.environ.get("OPENRAPPTER_BRAINSTEM_HOST", "127.0.0.1")):
    BRAINSTEM_HOME.mkdir(parents=True, exist_ok=True)
    AGENTS_PATH.mkdir(parents=True, exist_ok=True)
    server = BrainstemServer((host, port), BrainstemHandler)
    agents = load_agents()
    print(f"\n{EMOJI} OpenRappter Brainstem v{__version__} on http://localhost:{server.server_address[1]}")
    print(f"   Agents dir: {AGENTS_PATH} (drop *_agent.py — live on next request)")
    print(f"   Soul:       {SOUL_PATH}")
    print(f"   Model:      {MODEL}")
    print(f"   Copilot:    {'✓ authenticated' if copilot_session() else '✗ set GITHUB_TOKEN or gh auth login'}")
    for name in sorted(agents):
        print(f"[openrappter-brainstem] Agent loaded: {name}")
    print(f"[openrappter-brainstem] {len(agents)} agent(s) ready.")
    return server


def main():
    server = serve()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[openrappter-brainstem] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
