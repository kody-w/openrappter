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
    """Optional HTTP server. GET = status, POST = notify or JSON-RPC."""
    from http.server import HTTPServer, BaseHTTPRequestHandler

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(gateway.status(), indent=2).encode())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)))) if int(self.headers.get("Content-Length", 0)) else {}
            if body.get("jsonrpc"):
                result = gateway.handle_jsonrpc(body)
            else:
                result = gateway.notify(body.get("agent_id", ""), body.get("event", ""), body.get("detail", {}))
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def log_message(self, *a): pass

    server = HTTPServer(("127.0.0.1", port), H)
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
