"""Shared fixtures for openrappter tests."""

import json
import pytest
from pathlib import Path


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
