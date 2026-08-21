import json
import subprocess
from pathlib import Path

from agents.rar_rapp_learn_new_agent import LearnNewAgent, __manifest__


def test_learn_new_is_the_single_generation_tool():
    agents_dir = Path(__file__).resolve().parents[1] / "agents"
    assert not (agents_dir / "prompt_generator_agent.py").exists()
    assert __manifest__["name"] == "@rapp/learn_new"
    assert __manifest__["version"] == "2.1.0"
    assert "search-fallback" in __manifest__["tags"]


def test_create_result_always_includes_vscode_repair_handoff(
    tmp_path,
    monkeypatch,
):
    agent = LearnNewAgent()
    agent.agents_dir = tmp_path
    monkeypatch.setattr(
        agent,
        "_generate_agent_code",
        lambda *_args, **_kwargs: (
            "import json\n"
            "class ExampleAgent:\n"
            "    pass\n"
        ),
    )
    monkeypatch.setattr(
        agent,
        "_hot_load_agent",
        lambda *_args, **_kwargs: {"success": True},
    )

    result = json.loads(
        agent.perform(
            action="create",
            name="Example",
            description="Handle an unmet library search",
        )
    )

    assert result["status"] == "success"
    assert result["filename"] == "example_agent.py"
    assert "VS Code" in result["need_help"]
    assert "Brain Surgeon" in result["need_help"]
    assert "localhost:7071" in result["repair_prompt"]
    assert "attached Brainstem transcript" in result["repair_prompt"]


def test_generated_source_safely_serializes_description_and_namespace(
    monkeypatch,
):
    agent = LearnNewAgent()
    monkeypatch.setattr(
        agent,
        "_generate_perform_body",
        lambda _description: (
            '        return json.dumps({"status": "success", "result": query})'
        ),
    )
    code = agent._generate_agent_code(
        '"""\nimport builtins\nbuiltins.PWNED = True\n"""',
        "Safe",
        "SafeAgent",
        namespace='evil"; import os; #',
    )
    compile(code, "safe_agent.py", "exec")
    assert '"name": "@rapp/safe"' in code
    assert "builtins.PWNED = True" in code
    assert '"""\\nimport builtins' not in code


def test_generated_nested_indentation_is_preserved(monkeypatch):
    agent = LearnNewAgent()
    completed = subprocess.CompletedProcess(
        args=[],
        returncode=0,
        stdout=(
            "if not query:\n"
            "    return json.dumps({\"status\": \"error\"})\n"
            "return json.dumps({\"status\": \"success\", \"result\": query})"
        ),
        stderr="",
    )
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: completed)
    body = agent._generate_perform_body("validate a query")
    source = "def perform(query):\n" + body + "\n"
    compile(source, "nested.py", "exec")
    assert "            return" in body


def test_failed_smoke_test_does_not_report_success(tmp_path, monkeypatch):
    agent = LearnNewAgent()
    agent.agents_dir = tmp_path
    monkeypatch.setattr(
        agent,
        "_generate_agent_code",
        lambda *_args, **_kwargs: "broken python(",
    )
    result = json.loads(
        agent.perform(
            action="create",
            name="Broken",
            description="Broken generated agent",
        )
    )
    assert result["status"] == "error"
    assert result["hot_loaded"] is False
    assert "smoke test failed" in result["message"].lower()
    assert "repair_prompt" in result
