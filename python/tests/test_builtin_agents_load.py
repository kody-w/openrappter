"""Every built-in agent must survive discovery.

`AgentRegistry.discover_agents` scans this package's own `agents/` directory,
loads each `*_agent.py`, and instantiates every `BasicAgent` subclass it finds.
A module that raises on import is caught, logged and skipped, so the agent
simply does not exist at runtime while everything else keeps working.

That is what happened to `google_voice_agent.py`. Every `--list-agents` printed

    WARNING: Failed to load .../google_voice_agent.py: No module named 'agents'

and listed 18 agents where TypeScript listed a working `GoogleVoice`, so the
two runtimes disagreed about which agents exist.

The agent was not at fault, and changing it would have been the wrong fix.
`tests/test_google_voice_agent.py` pins an "article VII portability" contract
whose allowed imports are exactly `{json, hashlib, datetime, uuid, agents,
agents.basic_agent}` — the file is deliberately written so the same source runs
in the grail brainstem. Importing `openrappter.agents.basic_agent` instead does
load it here and breaks that contract; I tried exactly that, and that test
failed, which is how the real cause surfaced.

The loader was at fault. It builds a synthetic `agents.` namespace for the
modules it discovers but skips `basic_agent.py`, so the one import a portable
agent is allowed to make resolved to nothing. It now aliases the package's
`basic_agent` into that namespace with `setdefault`, which leaves a real
top-level `agents` package alone if one exists.

A logged warning is not a test. This is the test.
"""

import logging
import sys
from pathlib import Path

import pytest

import openrappter.agents as agents_pkg
from openrappter.cli import AgentRegistry

AGENTS_DIR = Path(agents_pkg.__file__).parent


def agent_files() -> list[str]:
    """The files the registry will try to load, selected the way it selects them."""
    return sorted(
        path.name
        for path in AGENTS_DIR.glob("*_agent.py")
        if not path.name.startswith("_") and path.name != "basic_agent.py"
    )


@pytest.fixture(scope="module")
def discovered() -> dict:
    return AgentRegistry().discover_agents()


def test_finds_a_realistic_number_of_agent_files():
    # Anti-vacuity: a glob that matched nothing would let every assertion below
    # pass by having nothing to load.
    assert len(agent_files()) > 10


def test_discovery_registers_a_realistic_number_of_agents(discovered):
    assert len(discovered) > 10


@pytest.mark.parametrize("filename", agent_files())
def test_no_agent_file_fails_to_load(caplog, filename):
    """Asserted per file rather than on a total.

    A count alone stays healthy when one agent stops loading, because the others
    keep it up — which is exactly how this went unnoticed for so long.

    The property is that discovery raises no failure for the file, not that the
    file is credited with an agent. The loader instantiates every `BasicAgent`
    subclass visible in a module, including ones the module merely imports, so
    `ComputerUse` is recorded against `demo_recorder_agent` — which imports it —
    rather than against its own file. That misattribution is real but separate;
    the agent loads either way.
    """
    with caplog.at_level(logging.WARNING):
        AgentRegistry().discover_agents()

    failures = [
        record.getMessage()
        for record in caplog.records
        if "Failed to load" in record.getMessage() and filename in record.getMessage()
    ]
    assert failures == [], (
        f"{filename} failed to load: {failures}. The loader catches this and "
        "logs a warning, so the agent silently does not exist at runtime."
    )


@pytest.fixture
def clean_agents_namespace():
    """Discovery as production sees it, not as the test session leaves it.

    Several suites — `test_google_voice_agent.py`, `test_brainstem_compliance.py`,
    `test_twin_agent.py` — install a *stub* `agents` / `agents.basic_agent` into
    `sys.modules` at import time to simulate the grail brainstem, and those stubs
    persist for the rest of the run. Under the full suite the loader's
    `setdefault` then finds the stub already present and leaves it, so portable
    agents subclass a different BasicAgent than the registry checks against.

    Nothing installs those stubs in production. Removing them for the duration
    of this test measures the loader rather than the test session, and they are
    put back so the suites that rely on them are unaffected.
    """
    saved = {
        name: sys.modules.pop(name)
        for name in ("agents", "agents.basic_agent")
        if name in sys.modules
    }
    try:
        yield
    finally:
        sys.modules.update(saved)


@pytest.fixture
def discovered_clean(clean_agents_namespace) -> dict:
    return AgentRegistry().discover_agents()


def test_google_voice_is_registered(discovered_clean):
    """The specific regression, named so it cannot be lost in a parametrised list."""
    assert "GoogleVoice" in discovered_clean


def test_portable_agents_can_import_the_namespace_they_are_restricted_to(
    discovered_clean,
):
    """The portability contract allows `agents.basic_agent` and little else, so
    discovery has to make that name resolve. If this breaks, portable agents
    stop loading and the only symptom is a warning."""
    assert "agents.basic_agent" in sys.modules

    from agents.basic_agent import BasicAgent as via_portable_name
    from openrappter.agents.basic_agent import BasicAgent as via_package_name

    assert via_portable_name is via_package_name
