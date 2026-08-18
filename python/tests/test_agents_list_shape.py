"""`agents.list` answers with a shape, and that shape must not drift.

The two runtimes disagree about what `agents.list` returns. TypeScript sends
``[{ id, type, description }]``; this runtime sends
``[{ name, description, parameters, module, file, source }]``. Exactly one key
overlaps, and TypeScript's ``id`` is this runtime's ``name``, so a client
written against either cannot read the other.

Which shape should be canonical is an open product question (#198) with real
callers on both sides, and nothing here decides it. What these tests do is stop
the shapes drifting *further* apart while it is decided: today's payload is
pinned exactly, so adding or removing a key is a deliberate act rather than
something that happens quietly.

`contracts/gateway-rpc-parity.json` says in its own words that it pins method
names "and nothing about what they answer with". This is the missing half for
the one shared method where that distinction has consequences.
"""

from __future__ import annotations

import sys

import pytest

from openrappter.cli import AgentRegistry


EXPECTED_KEYS = {"name", "description", "parameters", "module", "file", "source"}


@pytest.fixture
def clean_agents_namespace():
    """Remove the stub `agents` modules other suites leave in `sys.modules`.

    `test_google_voice_agent.py`, `test_brainstem_compliance.py` and
    `test_twin_agent.py` install a stub `agents` / `agents.basic_agent` at
    import time to simulate the grail brainstem, and those stubs persist for the
    rest of the run. The loader's `setdefault` then finds one already present
    and leaves it, so the probe below subclasses a different `BasicAgent` than
    the registry checks against and is never discovered.

    These tests found that the hard way: all four passed alone and three failed
    under the full suite. The one that failed first was the anti-vacuity check,
    which is the only reason the shape assertions did not quietly pass over an
    empty listing.
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
def registry(tmp_path, clean_agents_namespace):
    """A registry over a directory holding one minimal agent."""
    agent_dir = tmp_path / "agents"
    agent_dir.mkdir()
    (agent_dir / "shape_probe_agent.py").write_text(
        '''
from agents.basic_agent import BasicAgent

__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@test/shape-probe",
    "version": "1.0.0",
    "description": "Pins the agents.list payload shape.",
    "capabilities": [],
}


class ShapeProbeAgent(BasicAgent):
    def __init__(self):
        super().__init__("ShapeProbe", {
            "name": "ShapeProbe",
            "description": "Pins the agents.list payload shape.",
            "parameters": {},
        })

    def perform(self, **kwargs):
        return "ok"
''',
        encoding="utf-8",
    )
    return AgentRegistry(str(agent_dir))


def test_the_registry_finds_the_probe(registry):
    # Anti-vacuity: every assertion below is about an entry, so an empty
    # listing would make them all pass by having nothing to check.
    names = [a["name"] for a in registry.list_agents()]
    assert "ShapeProbe" in names, names


def test_every_entry_carries_exactly_the_documented_keys(registry):
    for entry in registry.list_agents():
        assert set(entry) == EXPECTED_KEYS, (
            f"agents.list entry for {entry.get('name')!r} changed shape: "
            f"{sorted(set(entry) ^ EXPECTED_KEYS)} differs. This payload is one "
            "half of a cross-runtime divergence under discussion in #198 — "
            "changing it is fine, changing it silently is not."
        )


def test_the_key_typescript_calls_id_is_called_name_here(registry):
    # The rename is the divergence's sharpest edge: both runtimes answer the
    # same method with a differently-named identifier, so a client reading
    # `id` gets nothing rather than an error.
    entry = next(a for a in registry.list_agents() if a["name"] == "ShapeProbe")
    assert "name" in entry
    assert "id" not in entry


def test_description_is_the_only_key_the_two_runtimes_share(registry):
    typescript_keys = {"id", "type", "description"}
    entry = next(a for a in registry.list_agents() if a["name"] == "ShapeProbe")
    assert set(entry) & typescript_keys == {"description"}
