"""Tests for ManageMemoryAgent and ContextMemoryAgent."""

import json
import pytest
from pathlib import Path

from openrappter.agents.manage_memory_agent import ManageMemoryAgent
from openrappter.agents.context_memory_agent import ContextMemoryAgent


# --- ManageMemoryAgent ---

class TestManageMemoryInit:
    def test_name(self):
        agent = ManageMemoryAgent()
        assert agent.name == "ManageMemory"

    def test_metadata_requires_content(self):
        agent = ManageMemoryAgent()
        assert "content" in agent.metadata["parameters"]["required"]


class TestManageMemoryStore:
    @pytest.fixture
    def agent(self, tmp_path):
        a = ManageMemoryAgent()
        a.home = tmp_path
        a.memory_file = tmp_path / "memory.json"
        return a

    def test_store_basic_memory(self, agent):
        result = json.loads(agent.perform(content="Python is great"))
        assert result["status"] == "success"
        assert "memory_id" in result
        assert "Python is great" in result["message"]

    def test_stored_memory_persists(self, agent):
        agent.perform(content="fact one")
        memories = json.loads(agent.memory_file.read_text())
        assert len(memories) == 1
        mem = list(memories.values())[0]
        assert mem["message"] == "fact one"
        assert mem["theme"] == "fact"

    def test_store_with_type_and_tags(self, agent):
        agent.perform(content="prefer vim", memory_type="preference", tags=["editor"])
        memories = json.loads(agent.memory_file.read_text())
        mem = list(memories.values())[0]
        assert mem["theme"] == "preference"
        assert "editor" in mem["tags"]

    def test_store_with_importance(self, agent):
        agent.perform(content="critical info", importance=5)
        memories = json.loads(agent.memory_file.read_text())
        mem = list(memories.values())[0]
        assert mem["importance"] == 5

    def test_store_no_content_error(self, agent):
        result = json.loads(agent.perform())
        assert result["status"] == "error"

    def test_store_uses_query_as_content(self, agent):
        result = json.loads(agent.perform(query="remember this"))
        assert result["status"] == "success"

    def test_multiple_memories_unique_ids(self, agent):
        agent.perform(content="first")
        agent.perform(content="second")
        memories = json.loads(agent.memory_file.read_text())
        assert len(memories) == 2
        ids = list(memories.keys())
        assert ids[0] != ids[1]


class TestManageMemoryRetrieve:
    @pytest.fixture
    def agent(self, sample_memories):
        a = ManageMemoryAgent()
        a.home = sample_memories.parent
        a.memory_file = sample_memories
        return a

    def test_retrieve_by_tags(self, agent):
        result = json.loads(agent.retrieve_by_tags(["typescript"]))
        assert result["status"] == "success"
        assert len(result["memories"]) == 1
        assert "TypeScript" in result["memories"][0]["message"]

    def test_retrieve_by_theme_tag(self, agent):
        result = json.loads(agent.retrieve_by_tags(["preference"]))
        assert len(result["memories"]) == 1

    def test_retrieve_no_match(self, agent):
        result = json.loads(agent.retrieve_by_tags(["nonexistent"]))
        assert result["memories"] == []

    def test_retrieve_recent(self, agent):
        result = json.loads(agent.retrieve_recent(limit=2))
        assert result["status"] == "success"
        assert len(result["memories"]) == 2
        # Most recent first
        assert result["memories"][0]["date"] >= result["memories"][1]["date"]

    def test_delete_memory(self, agent):
        result = json.loads(agent.delete_memory("mem-001"))
        assert result["status"] == "success"
        memories = json.loads(agent.memory_file.read_text())
        assert "mem-001" not in memories

    def test_delete_nonexistent(self, agent):
        result = json.loads(agent.delete_memory("nope"))
        assert result["status"] == "error"


# --- ContextMemoryAgent ---

class TestContextMemoryInit:
    def test_name(self):
        agent = ContextMemoryAgent()
        assert agent.name == "ContextMemory"


class TestContextMemoryRecall:
    @pytest.fixture
    def agent(self, sample_memories):
        a = ContextMemoryAgent()
        a.home = sample_memories.parent
        a.memory_file = sample_memories
        return a

    def test_full_recall(self, agent):
        result = json.loads(agent.perform(full_recall=True))
        assert result["status"] == "success"
        assert len(result["memories"]) == 3

    def test_keyword_filter(self, agent):
        result = json.loads(agent.perform(keywords=["deploy"]))
        assert result["status"] == "success"
        assert len(result["memories"]) >= 1
        assert "deploy" in result["memories"][0]["message"].lower()

    def test_query_extracts_keywords(self, agent):
        result = json.loads(agent.perform(query="deploy command"))
        assert result["status"] == "success"
        assert len(result["memories"]) >= 1

    def test_max_messages_limit(self, agent):
        result = json.loads(agent.perform(full_recall=False, max_messages=1, keywords=["mem"]))
        # Keywords may not match, but limit should be respected
        memories = result.get("memories", [])
        assert len(memories) <= 1

    def test_no_memories_found(self, agent):
        result = json.loads(agent.perform(keywords=["xyznonexistent"]))
        assert result["status"] == "success"

    def test_empty_memory_file(self, tmp_path):
        agent = ContextMemoryAgent()
        agent.memory_file = tmp_path / "empty.json"
        result = json.loads(agent.perform(full_recall=True))
        assert result["status"] == "success"
        assert result["memories"] == []

    def test_default_is_full_recall(self, agent):
        result = json.loads(agent.perform())
        assert len(result["memories"]) == 3


class TestContextMemorySearch:
    @pytest.fixture
    def agent(self, sample_memories):
        a = ContextMemoryAgent()
        a.home = sample_memories.parent
        a.memory_file = sample_memories
        return a

    def test_search_finds_match(self, agent):
        result = json.loads(agent.search("PostgreSQL database"))
        assert result["status"] == "success"
        assert len(result["memories"]) >= 1

    def test_search_no_match(self, agent):
        result = json.loads(agent.search("xyznonexistent"))
        assert result["memories"] == []

    def test_search_respects_limit(self, agent):
        result = json.loads(agent.search("the", limit=1))
        assert len(result["memories"]) <= 1


class TestContextMemoryFormat:
    def test_format_memories(self):
        agent = ContextMemoryAgent()
        memories = [
            {"message": "fact A", "theme": "fact", "date": "2026-01-01", "time": "10:00:00"},
            {"message": "fact B", "theme": "insight"},
        ]
        formatted = agent._format_memories(memories)
        assert "fact A" in formatted
        assert "fact B" in formatted
        assert "Recorded:" in formatted

    def test_format_empty(self):
        agent = ContextMemoryAgent()
        assert agent._format_memories([]) == "No memories found."
