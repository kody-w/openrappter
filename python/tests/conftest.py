"""Shared fixtures for openrappter tests."""

import json
import sys
import threading
import importlib
import pytest
from pathlib import Path

from openrappter import brainstem

#: Mirrors ``requires-python`` in pyproject.toml. Kept in sync by a test.
MIN_PYTHON = (3, 10)


def unsupported_python_message(version_info, executable="python3", platform=sys.platform):
    """Explain an unsupported interpreter, or return ``None`` when it is fine.

    macOS still ships 3.9 as ``/usr/bin/python3``, so this is the interpreter a
    contributor gets by default. The suite does not merely fail there, it fails
    *misleadingly*: ``GatewayServer.__init__`` constructs an ``asyncio.Lock()``,
    and on 3.9 a Lock binds an event loop at construction, so once any earlier
    test has finished an ``asyncio.run()`` — which clears the current loop — the
    next construction raises

        RuntimeError: There is no current event loop in thread 'MainThread'.

    That reads like a product bug in the gateway. It is not; the loop parameter
    was removed from ``asyncio.Lock`` in 3.10 and the binding became lazy. The
    failure is also order-dependent, so the file passes 31/31 on its own and
    fails only in a full run — which sends you looking for a race that is not
    there. Say what is actually wrong instead.
    """
    if version_info >= MIN_PYTHON:
        return None
    running = ".".join(str(part) for part in version_info[:3])
    wanted = ".".join(str(part) for part in MIN_PYTHON)
    lines = [
        f"openrappter requires Python {wanted}+ and this is {running} ({executable}).",
        "",
        "pyproject.toml declares requires-python = \">=%s\", so pip refuses to" % wanted,
        "install here; running the suite from a source checkout is the one path that",
        "gets this far. It would fail deep inside asyncio with",
        "\"There is no current event loop\", which looks like a gateway bug and is not:",
        f"asyncio.Lock binds a loop at construction before {wanted}.",
    ]
    if platform == "darwin":
        lines += [
            "",
            "macOS ships 3.9 as /usr/bin/python3. Use a newer one, e.g.:",
            "    brew install python@3.12 && python3.12 -m pytest tests/",
        ]
    return "\n".join(lines)


@pytest.fixture(autouse=True)
def no_live_model_generation(monkeypatch, request):
    """Keep agent-creation tests off the network.

    `LearnNewAgent` shells out to the Copilot CLI to write a perform() body.
    These tests exercise the creation mechanics — name derivation, file layout,
    duplicate handling, brainstem compliance — none of which need a model, and
    all of which become slow and non-deterministic if one is called. They only
    ran fast before because the generator was invoking a flag the CLI does not
    have and failing instantly.

    Tests that genuinely want the model path mark themselves `live_model`;
    tests of the generator itself mark themselves `real_generator` and stub the
    subprocess instead.
    """
    if request.node.get_closest_marker("live_model") or request.node.get_closest_marker("real_generator"):
        return
    try:
        from openrappter.agents.learn_new_agent import LearnNewAgent
    except Exception:  # pragma: no cover - module not importable in this env
        return

    def scaffold_only(self, description):
        self.last_generation_was_template = True
        return self._scaffold_perform_body()

    monkeypatch.setattr(LearnNewAgent, "_generate_perform_body", scaffold_only)


def pytest_configure(config):
    message = unsupported_python_message(sys.version_info, sys.executable)
    if message is not None:
        pytest.exit(message, returncode=pytest.ExitCode.USAGE_ERROR)
    config.addinivalue_line(
        "markers", "live_model: test calls a real model and may be slow",
    )
    config.addinivalue_line(
        "markers", "real_generator: test exercises the generator with a stubbed CLI",
    )


@pytest.fixture
def tmp_memory_file(tmp_path):
    """Provide a temporary memory file path."""
    return tmp_path / "memory.json"


@pytest.fixture
def sample_memories(tmp_memory_file):
    """Create a temporary memory file with sample data."""
    memories = {
        "mem-001": {
            "id": "mem-001",
            "message": "User prefers TypeScript over JavaScript",
            "theme": "preference",
            "importance": 4,
            "tags": ["language", "typescript"],
            "date": "2026-02-10",
            "time": "14:30:00",
            "accessed": 2,
        },
        "mem-002": {
            "id": "mem-002",
            "message": "Deploy command is npm run deploy",
            "theme": "fact",
            "importance": 3,
            "tags": ["deploy", "npm"],
            "date": "2026-02-11",
            "time": "09:15:00",
            "accessed": 0,
        },
        "mem-003": {
            "id": "mem-003",
            "message": "Project uses PostgreSQL database for production",
            "theme": "fact",
            "importance": 5,
            "tags": ["database", "production"],
            "date": "2026-02-09",
            "time": "16:00:00",
            "accessed": 1,
        },
    }
    tmp_memory_file.write_text(json.dumps(memories, indent=2))
    return tmp_memory_file


@pytest.fixture()
def server(tmp_path, monkeypatch):
    """A real brainstem on a loopback port, hermetic and torn down after.

    Lives here rather than in `test_openrappter_brainstem.py` because more than
    one module needs it: `test_brainstem_http_framing.py` drives the same server
    with hand-built requests. A second copy would be a second thing to keep in
    step with the fixture it was copied from.
    """
    monkeypatch.setattr(brainstem, "BRAINSTEM_HOME", tmp_path)
    monkeypatch.setattr(brainstem, "AGENTS_PATH", tmp_path / "agents")
    monkeypatch.setattr(brainstem, "SOUL_PATH", tmp_path / "soul.md")
    # Keep tests hermetic: never reach for a real GitHub token
    monkeypatch.setattr(brainstem, "_github_token", lambda: None)
    (tmp_path / "agents").mkdir()

    httpd = brainstem.serve(port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield base
    httpd.shutdown()


@pytest.fixture(autouse=True)
def isolate_agent_memory_store(monkeypatch, tmp_path_factory):
    """Keep the agent memory store out of the developer's real home directory.

    Both memory agents default `memory_file` to `~/.openrappter/memory.json`.
    Tests that care point it somewhere else, so this never mattered while the
    only callers were tests. The iMessage trust context now recalls memory on
    every inbound message and builds its own agent, so an unpatched test reads
    whatever the developer happens to have remembered -- making `familiarity`
    and the projected facts depend on the machine, and reading personal data
    into a test run. Redirect the default; explicit assignment still wins.

    The store lives outside the test's own `tmp_path` because tests that list a
    directory count its entries.
    """
    store = tmp_path_factory.mktemp("agent-memory") / "memory.json"
    store.parent.mkdir(parents=True, exist_ok=True)
    for module, name in (
        ("openrappter.agents.context_memory_agent", "ContextMemoryAgent"),
        ("openrappter.agents.manage_memory_agent", "ManageMemoryAgent"),
    ):
        try:
            cls = getattr(importlib.import_module(module), name)
        except Exception:  # pragma: no cover - module not importable in this env
            continue
        original = cls.__init__

        def patched(self, *args, __original=original, **kwargs):
            __original(self, *args, **kwargs)
            self.home = store.parent
            self.memory_file = store

        monkeypatch.setattr(cls, "__init__", patched)
