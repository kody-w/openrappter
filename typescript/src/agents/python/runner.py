#!/usr/bin/env python3
"""
Run a single-file Python agent for the TypeScript daemon.

The daemon is Node; agents dropped on it are frequently Python, because that is
what the grail brainstem and the RAR catalog produce. Rather than ask people to
port an agent before they can use it, this bridges the two: Node spawns this
script, this script loads the agent the same way the brainstem does, and the
result comes back as JSON on stdout.

Two modes:

  introspect <file>       -> {"status":"ok","agents":[{name,description,parameters}]}
  run <file> <AgentName>  -> {"status":"ok","result":"..."}   (kwargs as JSON on stdin)

Everything that is not the payload goes to stderr, because stdout is a protocol
here and a stray print() from inside an agent would corrupt it.
"""

import importlib.util
import inspect
import io
import json
import os
import sys
import types

# Never reuse compiled bytecode for a dropped agent.
#
# CPython caches .pyc next to the source and validates it by (mtime, size). Two
# edits of the same agent that differ only in a same-length string — "Version
# one." to "Version two." — written inside one filesystem timestamp tick look
# identical to that check, so the OLD code is silently re-executed. Editing an
# agent and re-dropping it would appear to do nothing, and the reason would be
# invisible. Turn the cache off and invalidate before every load.
sys.dont_write_bytecode = True

# ── The compatibility shim ────────────────────────────────────────────────────
#
# Agents in this ecosystem are written against three different import paths:
#
#   from agents.basic_agent import BasicAgent              (grail brainstem, RAR)
#   from openrappter.agents.basic_agent import BasicAgent  (openrappter python)
#   from basic_agent import BasicAgent                     (bare, single-file)
#
# A dropped agent should work whichever one it uses, so all three are registered
# in sys.modules pointing at the same shim class BEFORE the file is executed.
# Installing the real package is not an option: the daemon is Node, and the
# whole promise is that the drop works immediately.


class BasicAgent:
    """Minimal stand-in for the base class agents expect to inherit."""

    def __init__(self, name=None, metadata=None):
        if name is not None:
            self.name = name
        if metadata is not None:
            self.metadata = metadata
        if not hasattr(self, "name"):
            self.name = type(self).__name__
        if not hasattr(self, "metadata"):
            self.metadata = {"name": self.name, "description": "", "parameters": {}}
        # Sloshed context. The daemon does its own enrichment, so this is an
        # empty dict rather than a fake — an agent reading it gets nothing,
        # which is true, instead of plausible-looking invented signals.
        self.context = {}

    def perform(self, **kwargs):
        raise NotImplementedError("Agent must implement perform()")

    def execute(self, **kwargs):
        return self.perform(**kwargs)

    def get_signal(self, key, default=None):
        node = self.context
        for part in str(key).split("."):
            if not isinstance(node, dict) or part not in node:
                return default
            node = node[part]
        return node


def _install_shim():
    for mod_name in ("agents", "openrappter", "openrappter.agents"):
        if mod_name not in sys.modules:
            pkg = types.ModuleType(mod_name)
            pkg.__path__ = []
            sys.modules[mod_name] = pkg

    shim = types.ModuleType("basic_agent")
    shim.BasicAgent = BasicAgent
    for alias in ("basic_agent", "agents.basic_agent", "openrappter.agents.basic_agent"):
        sys.modules.setdefault(alias, shim)
    sys.modules["agents"].basic_agent = shim
    sys.modules["openrappter.agents"].basic_agent = shim


def _load(path):
    """Execute the agent file and return every BasicAgent subclass it defines."""
    _install_shim()
    # Drop any cached finder state for this path before loading.
    importlib.invalidate_caches()
    spec = importlib.util.spec_from_file_location("_dropped_agent", path)
    if spec is None or spec.loader is None:
        raise ImportError("not an importable Python module")
    module = importlib.util.module_from_spec(spec)

    # An agent that prints at import time would otherwise land in stdout and
    # corrupt the JSON protocol. Capture it and let it out on stderr.
    captured = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = captured
    try:
        spec.loader.exec_module(module)
    finally:
        sys.stdout = real_stdout
        noise = captured.getvalue()
        if noise:
            sys.stderr.write(noise)

    found = []
    for _, obj in inspect.getmembers(module, inspect.isclass):
        if obj is BasicAgent:
            continue
        if issubclass(obj, BasicAgent) and obj.__module__ == module.__name__:
            found.append(obj)
    return found


def _describe(cls):
    instance = cls()
    meta = getattr(instance, "metadata", {}) or {}
    name = meta.get("name") or getattr(instance, "name", cls.__name__)
    description = meta.get("description") or (inspect.getdoc(cls) or "").strip()
    params = meta.get("parameters") or {"type": "object", "properties": {}, "required": []}
    return {"name": name, "description": description, "parameters": params}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"status": "error", "error": "usage: runner.py <introspect|run> <file> [agent]"}))
        return 2

    mode, path = sys.argv[1], sys.argv[2]
    if not os.path.isfile(path):
        print(json.dumps({"status": "error", "error": f"no such file: {path}"}))
        return 1

    try:
        classes = _load(path)
    except Exception as exc:
        print(json.dumps({"status": "error", "error": f"{type(exc).__name__}: {exc}"}))
        return 1

    if not classes:
        print(json.dumps({
            "status": "error",
            "error": "no BasicAgent subclass found - this file is not an agent",
        }))
        return 1

    if mode == "introspect":
        described = []
        for cls in classes:
            try:
                described.append(_describe(cls))
            except Exception as exc:
                print(json.dumps({
                    "status": "error",
                    "error": f"{cls.__name__} could not be constructed: {type(exc).__name__}: {exc}",
                }))
                return 1
        print(json.dumps({"status": "ok", "agents": described}))
        return 0

    if mode == "run":
        wanted = sys.argv[3] if len(sys.argv) > 3 else None
        raw = sys.stdin.read().strip()
        kwargs = json.loads(raw) if raw else {}

        target = None
        for cls in classes:
            try:
                if wanted is None or _describe(cls)["name"] == wanted:
                    target = cls
                    break
            except Exception:
                continue
        if target is None:
            print(json.dumps({"status": "error", "error": f"agent not found in file: {wanted}"}))
            return 1

        try:
            instance = target()
            captured = io.StringIO()
            real_stdout = sys.stdout
            sys.stdout = captured
            try:
                result = instance.perform(**kwargs)
            finally:
                sys.stdout = real_stdout
                noise = captured.getvalue()
                if noise:
                    sys.stderr.write(noise)
        except Exception as exc:
            print(json.dumps({"status": "error", "error": f"{type(exc).__name__}: {exc}"}))
            return 1

        if not isinstance(result, str):
            result = json.dumps(result)
        print(json.dumps({"status": "ok", "result": result}))
        return 0

    print(json.dumps({"status": "error", "error": f"unknown mode: {mode}"}))
    return 2


if __name__ == "__main__":
    sys.exit(main())
