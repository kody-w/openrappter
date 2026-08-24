"""nanorappter — The lightweight openrappter runtime.

Same agent capabilities, 1/50000th the size.

openrappter: BasicAgent + data sloshing + skills + clawhub + TypeScript + 1.8GB
nanorappter: NanoAgent + emit() + gateway + 1 file + 0 deps

Drop-in compatible with openrappter agents — any NanoAgent can be wrapped
as a BasicAgent and vice versa. But you don't need the framework to run.

Usage:
    from nanorappter import NanoAgent, Gateway

    class MyBot(NanoAgent):
        def perform(self, event, detail):
            return {"reply": "hello"}

    gw = Gateway()
    gw.register("bot", MyBot("bot", "Says hello"))
    print(gw.notify("bot", "greet", {}))

CLI:
    python3 -m nanorappter status          # gateway health
    python3 -m nanorappter serve 9999      # HTTP + JSON-RPC gateway
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

#: Largest POST body the optional HTTP gateway will read, matching the limit
#: the brainstem and the TypeScript gateway both use.
MAX_BODY_BYTES = 2 * 1024 * 1024


class NanoAgent:
    """Base class for all nanorappter agents.

    The entire contract: override perform(event, detail) → dict.
    Optionally use emit() to pass signals to downstream agents.
    """

    def __init__(self, name: str, description: str = "", actions: list[str] | None = None):
        self.name = name
        self.description = description
        self.actions = actions or []
        self._log: list[dict] = []

    @property
    def metadata(self) -> dict:
        """Agent metadata — compatible with openrappter's agent discovery."""
        return {
            "name": self.name,
            "description": self.description,
            "actions": self.actions,
            "runtime": "nanorappter",
        }

    def perform(self, event: str, detail: dict) -> dict:
        """Handle an event. Override this."""
        raise NotImplementedError(f"{self.name} has no perform()")

    def emit(self, **signals: Any) -> dict:
        """Create a data_slush envelope for downstream agents.

        Compatible with openrappter's data sloshing — downstream agents
        receive this in their detail dict when chained.
        """
        return {
            "source": self.name,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "signals": signals,
        }

    def log(self, message: str) -> None:
        """Append to agent activity log (kept in memory, last 100)."""
        entry = {"t": datetime.now(timezone.utc).isoformat(), "msg": message}
        self._log.append(entry)
        if len(self._log) > 100:
            self._log = self._log[-100:]


class Gateway:
    """Routes events to agents. Supports notify, broadcast, chain, and JSON-RPC.

    This is the nanorappter equivalent of openrappter's CLI orchestrator,
    but without the config files, WebSocket servers, or build steps.
    """

    def __init__(self):
        self.agents: dict[str, NanoAgent] = {}

    def register(self, agent_id: str, agent: NanoAgent) -> None:
        """Register an agent."""
        self.agents[agent_id] = agent

    def unregister(self, agent_id: str) -> None:
        """Remove an agent."""
        self.agents.pop(agent_id, None)

    def notify(self, agent_id: str, event: str, detail: dict | None = None) -> dict:
        """Send an event to a specific agent."""
        if agent_id not in self.agents:
            return {"error": f"agent not found: {agent_id}"}
        agent = self.agents[agent_id]
        if agent.actions and event not in agent.actions:
            return {"error": f"{agent_id} doesn't handle '{event}'", "supported": agent.actions}
        try:
            start = time.monotonic()
            result = agent.perform(event, detail or {})
            ms = (time.monotonic() - start) * 1000
            if not isinstance(result, dict):
                result = {"result": result}
            result.setdefault("agent", agent_id)
            result.setdefault("event", event)
            result.setdefault("elapsed_ms", round(ms, 1))
            agent.log(f"{event} → {result.get('status', 'ok')} ({ms:.0f}ms)")
            return result
        except Exception as e:
            agent.log(f"{event} → ERROR: {e}")
            return {"error": str(e), "agent": agent_id, "event": event}

    def broadcast(self, event: str, detail: dict | None = None) -> list[dict]:
        """Send an event to ALL agents that handle it."""
        return [
            self.notify(aid, event, detail)
            for aid, a in self.agents.items()
            if not a.actions or event in a.actions
        ]

    def chain(self, agent_ids: list[str], event: str, detail: dict | None = None) -> dict:
        """Pipeline: each agent's data_slush feeds into the next agent's detail.

        This is the nanorappter equivalent of openrappter's data sloshing,
        but explicit instead of implicit.
        """
        current = detail or {}
        last = {}
        for aid in agent_ids:
            last = self.notify(aid, event, current)
            slush = last.get("data_slush", {})
            if isinstance(slush, dict):
                current = {**current, **slush}
        return last

    def handle_jsonrpc(self, body: dict) -> dict:
        """Handle openrappter-compatible JSON-RPC 2.0 calls.

        Method format: "agent_id.event" (routed) or "event" (broadcast).
        """
        rpc_id = body.get("id", 1)
        method = body.get("method", "")
        params = body.get("params", {})

        parts = method.rsplit(".", 1)
        if len(parts) == 2:
            result = self.notify(parts[0], parts[1], params)
        else:
            result = {"responses": self.broadcast(parts[0], params)}

        return {"jsonrpc": "2.0", "result": result, "id": rpc_id}

    def status(self) -> dict:
        """Gateway health — list all agents, their actions, and recent activity."""
        return {
            "runtime": "nanorappter",
            "agents": {
                aid: {
                    "name": a.name,
                    "description": a.description,
                    "actions": a.actions,
                    "log_entries": len(a._log),
                    "last_activity": a._log[-1]["t"] if a._log else None,
                }
                for aid, a in self.agents.items()
            },
            "total": len(self.agents),
        }


def serve(gateway: Gateway, port: int = 9999) -> None:
    """Optional loopback HTTP server.

    GET status is cross-origin readable. POST notify/JSON-RPC requires JSON and
    either a non-browser client or an exact loopback same-origin browser.
    """
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

    class H(BaseHTTPRequestHandler):
        # A caller that claims bytes and never sends them would otherwise hold
        # its thread open forever.
        timeout = 30

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(gateway.status(), indent=2).encode())

        def _write_origin(self) -> str | None:
            """Exact loopback same-origin browser authority, or no browser origin."""
            origin = self.headers.get("Origin")
            if origin is None:
                return None
            try:
                parsed_origin = urlsplit(origin)
                parsed_host = urlsplit(f"http://{self.headers.get('Host', '')}")
                origin_host = (parsed_origin.hostname or "").lower()
                request_host = (parsed_host.hostname or "").lower()
                loopback_hosts = {"127.0.0.1", "::1", "localhost"}
                origin_port = parsed_origin.port or 80
                request_port = parsed_host.port or 80
            except ValueError:
                return None
            if (
                parsed_origin.scheme != "http"
                or parsed_origin.username is not None
                or parsed_origin.password is not None
                or parsed_origin.path not in ("", "/")
                or parsed_origin.query
                or parsed_origin.fragment
                or origin_host not in loopback_hosts
                or request_host not in loopback_hosts
                or origin_host != request_host
                or origin_port != request_port
            ):
                return None
            return origin

        def _content_length(self) -> int:
            """Declared body size, or -1 if the header cannot be trusted.

            Anything non-numeric or negative is -1. Negative matters most:
            rfile.read(-1) means "read until EOF", so a caller could hold the
            socket open and block indefinitely.
            """
            raw = self.headers.get("Content-Length", "")
            if not raw:
                return 0
            try:
                length = int(raw)
            except (TypeError, ValueError):
                return -1
            return length if length >= 0 else -1

        def _is_json_request(self) -> bool:
            content_type = self.headers.get("Content-Type", "")
            media_type = content_type.split(";", 1)[0].strip().lower()
            return media_type == "application/json"

        def _refuse(
            self, status: int, message: str, allowed_origin: str | None = None
        ) -> None:
            payload = json.dumps({"error": message}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            if allowed_origin is not None:
                self.send_header("Access-Control-Allow-Origin", allowed_origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(payload)

        def _discard_body(self, length: int) -> None:
            """Read and throw away an oversized body before refusing it.

            Answering the moment the limit is known ends the response while the
            caller is still uploading, and it gets a connection reset instead of
            a readable error.
            """
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)

        def do_POST(self):
            request_origin = self.headers.get("Origin")
            allowed_origin = self._write_origin()
            if request_origin is not None and allowed_origin is None:
                self._refuse(403, "cross-origin agent invocation refused")
                return
            length = self._content_length()
            if length < 0:
                self._refuse(400, "invalid Content-Length", allowed_origin)
                return
            if length > MAX_BODY_BYTES:
                # Only a body that is about to arrive anyway is worth draining,
                # and only so the refusal is readable rather than a reset. A
                # caller claiming far more than the cap is refused at once: it
                # has already been told no, and reading megabytes to be polite
                # about it just hands it the time instead of the memory.
                if length <= MAX_BODY_BYTES * 8:
                    self._discard_body(length)
                self._refuse(
                    413,
                    f"request body too large (limit {MAX_BODY_BYTES} bytes)",
                    allowed_origin,
                )
                return
            if not self._is_json_request():
                self._refuse(415, "Content-Type must be application/json", allowed_origin)
                return
            try:
                body = json.loads(self.rfile.read(length)) if length else {}
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._refuse(400, "invalid JSON body", allowed_origin)
                return
            if not isinstance(body, dict):
                self._refuse(400, "body must be a JSON object", allowed_origin)
                return
            if body.get("jsonrpc"):
                result = gateway.handle_jsonrpc(body)
            else:
                result = gateway.notify(body.get("agent_id", ""), body.get("event", ""), body.get("detail", {}))
            payload = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            if allowed_origin is not None:
                self.send_header("Access-Control-Allow-Origin", allowed_origin)
                self.send_header("Vary", "Origin")
            self.end_headers()
            self.wfile.write(payload)

        def do_OPTIONS(self):
            requested_method = self.headers.get(
                "Access-Control-Request-Method", ""
            ).upper()
            if requested_method == "POST":
                allowed_origin = self._write_origin()
                if allowed_origin is None:
                    self._refuse(403, "cross-origin agent invocation refused")
                    return
                self.send_response(204)
                self.send_header("Access-Control-Allow-Origin", allowed_origin)
                self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Vary", "Origin")
                self.end_headers()
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.end_headers()

        def log_message(self, *a): pass

    # Threading, because one caller must not be able to stall every other one:
    # a single-threaded server blocks its accept loop for the whole of a slow
    # request.
    server = ThreadingHTTPServer(("127.0.0.1", port), H)
    server.daemon_threads = True
    print(f"nanorappter gateway → http://localhost:{port}  ({len(gateway.agents)} agents)")
    server.serve_forever()


# ── Compatibility layer: wrap NanoAgent as openrappter BasicAgent ────────
def as_basic_agent(nano: NanoAgent):
    """Wrap a NanoAgent so it works in the openrappter framework.

    Returns an object with execute() and perform() matching BasicAgent's contract.
    """
    class Wrapped:
        def __init__(self):
            self.name = nano.name
            self.metadata = nano.metadata

        def execute(self, **kwargs):
            event = kwargs.pop("action", kwargs.pop("event", "default"))
            return nano.perform(event, kwargs)

        def perform(self, **kwargs):
            return self.execute(**kwargs)

        def slosh(self, data):
            return data

        def slush_out(self):
            return nano.emit()

    return Wrapped()


# ── CLI entrypoint ──────────────────────────────────────────────────────
def _main():
    import sys
    args = sys.argv[1:]
    gw = Gateway()

    if not args or args[0] == "help":
        print("nanorappter — the lightweight openrappter runtime")
        print()
        print("  python3 -m nanorappter status       # gateway health")
        print("  python3 -m nanorappter serve [PORT]  # HTTP + JSON-RPC server")
        print()
        print("In code:")
        print("  from nanorappter import NanoAgent, Gateway")
        print("  class MyBot(NanoAgent): ...")
        print("  gw = Gateway(); gw.register('bot', MyBot('bot'))")
    elif args[0] == "status":
        print(json.dumps(gw.status(), indent=2))
    elif args[0] == "serve":
        port = int(args[1]) if len(args) > 1 else 9999
        serve(gw, port)
    else:
        print(f"Unknown: {args[0]}. Try: nanorappter help")


if __name__ == "__main__":
    _main()
