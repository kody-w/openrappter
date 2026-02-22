"""Tests for CLI argument parsing and agent discovery."""

import json
import sys
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock


# --- Version consistency ---

class TestVersion:
    def test_package_version(self):
        from openrappter import __version__
        assert __version__ == "1.8.0"

    def test_cli_version_matches(self):
        """Verify cli.py version matches package version."""
        from openrappter import __version__
        # Read the version from cli.py source to avoid importing the full CLI
        cli_path = Path(__file__).parent.parent / "openrappter" / "cli.py"
        content = cli_path.read_text()
        assert f'self.version = "{__version__}"' in content


# --- Agent discovery ---

class TestAgentDiscovery:
    def test_all_core_agents_importable(self):
        from openrappter.agents.basic_agent import BasicAgent
        from openrappter.agents.shell_agent import ShellAgent
        from openrappter.agents.manage_memory_agent import ManageMemoryAgent
        from openrappter.agents.context_memory_agent import ContextMemoryAgent
        from openrappter.agents.learn_new_agent import LearnNewAgent
        assert True

    def test_core_agents_instantiate(self):
        from openrappter.agents.shell_agent import ShellAgent
        from openrappter.agents.manage_memory_agent import ManageMemoryAgent
        from openrappter.agents.context_memory_agent import ContextMemoryAgent
        from openrappter.agents.learn_new_agent import LearnNewAgent

        agents = [ShellAgent(), ManageMemoryAgent(), ContextMemoryAgent(), LearnNewAgent()]
        names = [a.name for a in agents]
        assert "Shell" in names
        assert "ManageMemory" in names
        assert "ContextMemory" in names
        assert "LearnNew" in names

    def test_agents_have_valid_metadata(self):
        from openrappter.agents.shell_agent import ShellAgent
        from openrappter.agents.manage_memory_agent import ManageMemoryAgent
        from openrappter.agents.context_memory_agent import ContextMemoryAgent
        from openrappter.agents.learn_new_agent import LearnNewAgent

        for AgentClass in [ShellAgent, ManageMemoryAgent, ContextMemoryAgent, LearnNewAgent]:
            agent = AgentClass()
            meta = agent.metadata
            assert "name" in meta
            assert "description" in meta
            assert "parameters" in meta
            assert meta["parameters"]["type"] == "object"
            assert "properties" in meta["parameters"]

    def test_agent_files_follow_naming_convention(self):
        """All agent files in agents/ should be *_agent.py or known exceptions."""
        # Some modules (broadcast, router, subagent) are multi-agent utility
        # files that don't follow the single-agent naming convention.
        exceptions = {"broadcast.py", "router.py", "subagent.py", "chain.py", "graph.py", "tracer.py"}
        agents_dir = Path(__file__).parent.parent / "openrappter" / "agents"
        py_files = [f.name for f in agents_dir.glob("*.py") if f.name != "__init__.py"]
        for name in py_files:
            if name in exceptions:
                continue
            assert name.endswith("_agent.py"), f"{name} doesn't follow *_agent.py convention"


# --- BasicAgent contract ---

class TestAgentContract:
    def test_all_agents_inherit_basic_agent(self):
        from openrappter.agents.basic_agent import BasicAgent
        from openrappter.agents.shell_agent import ShellAgent
        from openrappter.agents.manage_memory_agent import ManageMemoryAgent
        from openrappter.agents.context_memory_agent import ContextMemoryAgent
        from openrappter.agents.learn_new_agent import LearnNewAgent

        for AgentClass in [ShellAgent, ManageMemoryAgent, ContextMemoryAgent, LearnNewAgent]:
            assert issubclass(AgentClass, BasicAgent)

    def test_all_agents_have_perform(self):
        from openrappter.agents.shell_agent import ShellAgent
        from openrappter.agents.manage_memory_agent import ManageMemoryAgent
        from openrappter.agents.context_memory_agent import ContextMemoryAgent
        from openrappter.agents.learn_new_agent import LearnNewAgent

        for AgentClass in [ShellAgent, ManageMemoryAgent, ContextMemoryAgent, LearnNewAgent]:
            agent = AgentClass()
            assert hasattr(agent, "perform")
            assert callable(agent.perform)

    def test_all_agents_have_execute(self):
        from openrappter.agents.shell_agent import ShellAgent
        from openrappter.agents.manage_memory_agent import ManageMemoryAgent
        from openrappter.agents.context_memory_agent import ContextMemoryAgent
        from openrappter.agents.learn_new_agent import LearnNewAgent

        for AgentClass in [ShellAgent, ManageMemoryAgent, ContextMemoryAgent, LearnNewAgent]:
            agent = AgentClass()
            assert hasattr(agent, "execute")
            assert callable(agent.execute)

    def test_perform_returns_json_string(self):
        from openrappter.agents.shell_agent import ShellAgent

        agent = ShellAgent()
        result = agent.perform(action="bash", command="echo hi")
        parsed = json.loads(result)
        assert "status" in parsed
