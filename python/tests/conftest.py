"""Shared fixtures for openrappter tests."""

import json
import pytest
from pathlib import Path


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
