"""Tests for LearnNewAgent's `import_skill` action and SkillAgent (native SKILL.md execution)."""

import importlib.util
import json
from pathlib import Path

import pytest

from openrappter.agents.learn_new_agent import LearnNewAgent
from openrappter.agents.skill_agent import SkillAgent


def _write_demo_skill(base: Path, with_script: bool = True) -> Path:
    skill_dir = base / "demo-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: DemoEcho\n"
        "description: A demo skill that echoes input.\n"
        "---\n\n"
        "# Demo Echo Skill\n\n"
        "This skill echoes back whatever you send it.\n"
    )
    if with_script:
        scripts_dir = skill_dir / "scripts"
        scripts_dir.mkdir()
        (scripts_dir / "run.py").write_text(
            "import sys, json\n"
            "print(json.dumps({'status': 'success', 'echoed': sys.argv[1] if len(sys.argv) > 1 else ''}))\n"
        )
    return skill_dir


@pytest.fixture
def agent(tmp_path):
    a = LearnNewAgent()
    a.agents_dir = tmp_path / "agents_out"
    a.agents_dir.mkdir()
    return a


class TestImportSkill:
    def test_missing_skill_path_errors(self, agent):
        result = json.loads(agent.perform(action="import_skill"))
        assert result["status"] == "error"

    def test_nonexistent_path_errors(self, agent, tmp_path):
        result = json.loads(agent.perform(action="import_skill", skill_path=str(tmp_path / "nope")))
        assert result["status"] == "error"
        assert "No SKILL.md found" in result["message"]

    def test_generates_loadable_agent_from_skill_dir(self, agent, tmp_path):
        skill_dir = _write_demo_skill(tmp_path)
        result = json.loads(agent.perform(action="import_skill", skill_path=str(skill_dir)))

        assert result["status"] == "success"
        assert result["agent_name"] == "DemoEcho"
        assert result["hot_loaded"] is True
        assert result["implementation"] == "skill_import"

        file_path = Path(result["file_path"])
        assert file_path.exists()

        spec = importlib.util.spec_from_file_location(file_path.stem, file_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls = getattr(module, "DemoEchoAgent")
        instance = cls()
        assert instance.name == "DemoEcho"

        run_result = json.loads(instance.perform(query="hello world"))
        inner = json.loads(run_result["output"])
        assert inner["echoed"] == "hello world"

    def test_accepts_direct_skill_md_path(self, agent, tmp_path):
        skill_dir = _write_demo_skill(tmp_path)
        result = json.loads(
            agent.perform(action="import_skill", skill_path=str(skill_dir / "SKILL.md"), name="Other")
        )
        assert result["status"] == "success"
        assert result["agent_name"] == "Other"

    def test_duplicate_name_errors(self, agent, tmp_path):
        skill_dir = _write_demo_skill(tmp_path)
        first = json.loads(agent.perform(action="import_skill", skill_path=str(skill_dir)))
        assert first["status"] == "success"
        second = json.loads(agent.perform(action="import_skill", skill_path=str(skill_dir)))
        assert second["status"] == "error"
        assert "already exists" in second["message"]

    def test_no_scripts_falls_back_to_instructions(self, agent, tmp_path):
        skill_dir = _write_demo_skill(tmp_path, with_script=False)
        result = json.loads(agent.perform(action="import_skill", skill_path=str(skill_dir)))
        assert result["status"] == "success"

        file_path = Path(result["file_path"])
        spec = importlib.util.spec_from_file_location(file_path.stem, file_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        instance = getattr(module, "DemoEchoAgent")()

        run_result = json.loads(instance.perform(query="anything"))
        assert run_result["status"] == "info"
        assert run_result["has_scripts"] is False
        assert "echoes back" in run_result["instructions"]

    def test_skill_agent_protected_from_deletion_and_listing(self, agent):
        (agent.agents_dir / "skill_agent.py").write_text("# core")
        listed = json.loads(agent.perform(action="list"))
        assert listed["count"] == 0

        deleted = json.loads(agent.perform(action="delete", name="skill"))
        assert deleted["status"] == "error"
        assert "core" in deleted["message"].lower()


class TestSkillAgent:
    def test_list_skills(self, tmp_path):
        _write_demo_skill(tmp_path)
        skill_agent = SkillAgent(skills_dir=tmp_path)
        result = json.loads(skill_agent.perform(action="list"))
        assert result["status"] == "success"
        assert result["count"] == 1
        assert result["skills"][0]["name"] == "DemoEcho"

    def test_run_by_name_executes_script(self, tmp_path):
        _write_demo_skill(tmp_path)
        skill_agent = SkillAgent(skills_dir=tmp_path)
        result = json.loads(skill_agent.perform(action="run", skill="demo-skill", query="hi there"))
        inner = json.loads(result["output"])
        assert inner["echoed"] == "hi there"

    def test_run_by_explicit_path(self, tmp_path):
        skill_dir = _write_demo_skill(tmp_path)
        skill_agent = SkillAgent(skills_dir=tmp_path)
        result = json.loads(skill_agent.perform(action="run", skill_path=str(skill_dir), query="direct"))
        inner = json.loads(result["output"])
        assert inner["echoed"] == "direct"

    def test_info_returns_full_instructions(self, tmp_path):
        _write_demo_skill(tmp_path)
        skill_agent = SkillAgent(skills_dir=tmp_path)
        result = json.loads(skill_agent.perform(action="info", skill="demo-skill"))
        assert result["status"] == "success"
        assert result["skill"] == "DemoEcho"
        assert "echoes back" in result["instructions"]

    def test_run_missing_skill_errors(self, tmp_path):
        skill_agent = SkillAgent(skills_dir=tmp_path)
        result = json.loads(skill_agent.perform(action="run", skill="nope"))
        assert result["status"] == "error"

    def test_run_without_any_identifier_errors(self, tmp_path):
        skill_agent = SkillAgent(skills_dir=tmp_path)
        result = json.loads(skill_agent.perform(action="run"))
        assert result["status"] == "error"
