"""nanorappter example agents — drop-in replacements for openrappter agents.

Same capabilities, 1/10th the code. Each agent is ~30-50 lines.

Usage:
    from nanorappter.examples import create_demo_gateway
    gw = create_demo_gateway()
    gw.notify("echo", "ping", {"message": "hello"})
    gw.notify("memory", "store", {"key": "mood", "value": "curious"})
    gw.notify("shell", "run", {"command": "echo hello world"})
    gw.chain(["shell", "memory", "echo"], "ping", {"message": "chained"})
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from . import NanoAgent, Gateway


class EchoAgent(NanoAgent):
    """Echoes back whatever you send. The hello-world of agents."""

    def __init__(self):
        super().__init__("echo", "Echoes events back", ["ping", "echo"])

    def perform(self, event: str, detail: dict) -> dict:
        self.log(f"echo: {detail.get('message', '')[:50]}")
        return {
            "status": "ok",
            "echo": detail,
            "data_slush": self.emit(echoed=True, original_event=event),
        }


class MemoryAgent(NanoAgent):
    """Stores and retrieves facts. File-backed, persistent across restarts.

    Replaces openrappter's ManageMemory + ContextMemory (413 + 200 LOC)
    with 40 lines. Same capability: store facts, recall by key.
    """

    def __init__(self, memory_file: str = "~/.nanorappter/memory.json"):
        super().__init__("memory", "Stores and recalls facts", ["store", "recall", "list"])
        self._file = Path(memory_file).expanduser()
        self._file.parent.mkdir(parents=True, exist_ok=True)

    def perform(self, event: str, detail: dict) -> dict:
        mem = self._load()

        if event == "store":
            key = detail.get("key", "")
            value = detail.get("value", "")
            if not key:
                return {"status": "error", "message": "key required"}
            mem[key] = {"value": value, "stored_at": self.emit()["timestamp"]}
            self._save(mem)
            self.log(f"stored: {key}")
            return {"status": "ok", "key": key, "data_slush": self.emit(stored_key=key)}

        elif event == "recall":
            key = detail.get("key", "")
            entry = mem.get(key)
            if not entry:
                return {"status": "not_found", "key": key}
            return {"status": "ok", "key": key, "value": entry["value"],
                    "data_slush": self.emit(recalled_key=key, value=entry["value"])}

        elif event == "list":
            return {"status": "ok", "count": len(mem),
                    "keys": list(mem.keys())[:50]}

        return {"status": "error", "message": f"unknown: {event}"}

    def _load(self) -> dict:
        if self._file.exists():
            return json.loads(self._file.read_text())
        return {}

    def _save(self, data: dict) -> None:
        self._file.write_text(json.dumps(data, indent=2))


class ShellAgent(NanoAgent):
    """Executes shell commands and returns output.

    Replaces openrappter's ShellAgent (150 LOC) with 25 lines.
    Safety: 10s timeout, stderr captured, exit code reported.
    """

    def __init__(self):
        super().__init__("shell", "Runs shell commands", ["run"])

    def perform(self, event: str, detail: dict) -> dict:
        cmd = detail.get("command", "")
        if not cmd:
            return {"status": "error", "message": "command required"}
        try:
            r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
            self.log(f"ran: {cmd[:40]} → rc={r.returncode}")
            return {
                "status": "ok" if r.returncode == 0 else "error",
                "stdout": r.stdout[:2000],
                "stderr": r.stderr[:500] if r.stderr else "",
                "exit_code": r.returncode,
                "data_slush": self.emit(command=cmd, exit_code=r.returncode),
            }
        except subprocess.TimeoutExpired:
            return {"status": "timeout", "command": cmd}
        except Exception as e:
            return {"status": "error", "message": str(e)}


def create_demo_gateway() -> Gateway:
    """Create a gateway with the 3 example agents."""
    gw = Gateway()
    gw.register("echo", EchoAgent())
    gw.register("memory", MemoryAgent())
    gw.register("shell", ShellAgent())
    return gw


if __name__ == "__main__":
    import sys
    gw = create_demo_gateway()

    if len(sys.argv) < 2 or sys.argv[1] == "demo":
        print("nanorappter demo — 3 agents, 0 dependencies\n")
        print(json.dumps(gw.notify("echo", "ping", {"message": "hello from nanorappter"}), indent=2))
        print()
        print(json.dumps(gw.notify("memory", "store", {"key": "demo", "value": "it works"}), indent=2))
        print()
        print(json.dumps(gw.notify("memory", "recall", {"key": "demo"}), indent=2))
        print()
        print(json.dumps(gw.notify("shell", "run", {"command": "echo nanorappter is alive"}), indent=2))
        print()
        print("Chain (shell → memory → echo):")
        print(json.dumps(gw.chain(["shell", "memory", "echo"], "ping", {"message": "chained", "command": "date", "key": "chain_test", "value": "passed"}), indent=2))
    elif sys.argv[1] == "serve":
        from . import serve
        serve(gw, int(sys.argv[2]) if len(sys.argv) > 2 else 9999)
    else:
        print("Usage: python3 -m nanorappter.examples [demo|serve PORT]")
