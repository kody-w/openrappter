"""LearnNewAgent must say which of the two things it produced.

The Python runtime had never generated an agent body: it shelled out to
`copilot --message`, which is not a flag the CLI has, and a bare `except: pass`
swallowed the failure. Every "created" agent was the echo scaffold, reported as
a plain success. These tests pin both halves — that a scaffold is labelled a
scaffold, and that a real generation is labelled generated.
"""

import json
import pathlib

import pytest

from openrappter.agents.learn_new_agent import LearnNewAgent


def _agent(tmp_path):
    agent = LearnNewAgent()
    agent.agents_dir = pathlib.Path(tmp_path)
    return agent


class TestImplementationHonesty:
    def test_scaffold_is_labelled_a_scaffold(self, tmp_path):
        # The autouse conftest fixture keeps the model out of this.
        agent = _agent(tmp_path)
        result = json.loads(agent.perform(action="create", description="echo things"))
        assert result["status"] == "success"
        assert result["implementation"] == "scaffold"
        assert "echoes its input" in result["warning"]

    def test_generation_is_labelled_generated_and_carries_no_warning(self, tmp_path, monkeypatch):
        def fake_body(self, description):
            self.last_generation_was_template = False
            return '        return json.dumps({"status": "success", "zscore": 63})'

        monkeypatch.setattr(LearnNewAgent, "_generate_perform_body", fake_body)
        agent = _agent(tmp_path)
        result = json.loads(agent.perform(action="create", description="score z"))
        assert result["implementation"] == "generated"
        assert "warning" not in result

    @pytest.mark.real_generator
    def test_a_body_that_never_returns_is_not_an_implementation(self, tmp_path, monkeypatch):
        """A body with no `return` yields an agent whose perform() gives None."""
        agent = _agent(tmp_path)
        body = _body_via_fake_cli(agent, monkeypatch, "        x = 1")
        assert agent.last_generation_was_template is True
        assert "Default implementation" in body

    @pytest.mark.real_generator
    def test_syntactically_broken_output_is_refused(self, tmp_path, monkeypatch):
        """Writing this would put an agent on disk that fails at hot-load."""
        agent = _agent(tmp_path)
        body = _body_via_fake_cli(agent, monkeypatch, "        return json.dumps({")
        assert agent.last_generation_was_template is True
        assert "Default implementation" in body

    @pytest.mark.real_generator
    def test_usable_output_is_accepted(self, tmp_path, monkeypatch):
        agent = _agent(tmp_path)
        body = _body_via_fake_cli(
            agent, monkeypatch, '        return json.dumps({"status": "success"})',
        )
        assert agent.last_generation_was_template is False
        assert "Default implementation" not in body

    @pytest.mark.real_generator
    def test_missing_cli_falls_back_without_raising(self, tmp_path, monkeypatch):
        import subprocess

        def boom(*args, **kwargs):
            raise FileNotFoundError("copilot")

        monkeypatch.setattr(subprocess, "run", boom)
        agent = _agent(tmp_path)
        body = agent._generate_perform_body("anything")
        assert agent.last_generation_was_template is True
        assert "Default implementation" in body


def _body_via_fake_cli(agent, monkeypatch, stdout):
    """Drive the real generator with a stubbed CLI process."""
    import subprocess

    class Result:
        returncode = 0

    result = Result()
    result.stdout = stdout
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: result)
    return agent._generate_perform_body("some description")
