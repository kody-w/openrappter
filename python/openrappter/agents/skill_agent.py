"""
SkillAgent - Runs raw SKILL.md files natively, without per-skill code generation.

SKILL.md is a generic, cross-tool convention for packaging an agent
capability as Markdown instructions plus an optional ``scripts/`` directory
(e.g. ``[category/]<skill>/SKILL.md``) — used by ClawHub, and by Hermes/Nous
Research under the agentskills.io open standard. This agent discovers,
parses, and executes any such skill directly (in ``~/.openrappter/skills/``
or an explicit path) — no agent file is generated for it.

For turning a skill into its own standalone, hot-loadable agent file
instead, see ``LearnNewAgent``'s ``import_skill`` action.

Self-contained (stdlib only) so this file stays droppable, standalone, into
any bare rapp-installer "brainstem" that provides only ``basic_agent`` — see
``tests/test_brainstem_compliance.py``. Importing another ``openrappter.*``
module (e.g. ``openrappter.clawhub``) here would break that contract, so the
SKILL.md parsing/execution logic is duplicated rather than shared with
``openrappter/clawhub.py``.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

from openrappter.agents.basic_agent import BasicAgent


__manifest__ = {
    "schema": "rapp-agent/1.0",
    "name": "@openrappter/skill",
    "version": "1.0.0",
    "display_name": "Skill",
    "description": "Runs raw SKILL.md files natively — list, inspect, and execute skills (the generic ClawHub/agentskills.io SKILL.md convention) without generating a dedicated agent file for each one.",
    "author": "Kody Wildfeuer",
    "ring": "ga",
    "capabilities": [
        "process-exec"
    ],
    "tags": [
        "openrappter",
        "skill"
    ],
    "category": "meta",
    "quality_tier": "official",
    "requires_env": []
}


def _parse_skill_md(path: Path):
    """Parse a SKILL.md's frontmatter + body with a regex (no YAML
    dependency, so this stays stdlib-only)."""
    try:
        content = path.read_text(encoding='utf-8')
    except OSError:
        return None

    name, description, body = "", "", content
    metadata = {}
    match = re.match(r'^---\s*\n(.*?)\n---\s*\n(.*)$', content, re.DOTALL)
    if match:
        for line in match.group(1).splitlines():
            kv = re.match(r'^(\w+):\s*(.+)$', line)
            if kv:
                key, value = kv.group(1), kv.group(2).strip().strip('"\'')
                metadata[key] = value
                if key == 'name':
                    name = value
                elif key == 'description':
                    description = value
        body = match.group(2)

    if not name:
        heading = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
        if heading:
            name = heading.group(1).strip()
    if not name:
        name = path.parent.name or path.stem

    if not description:
        for para in body.split('\n\n'):
            para = para.strip()
            if para and not para.startswith('#'):
                description = para[:200]
                break

    return {"name": name, "description": description, "content": body, "metadata": metadata, "path": path}


def _resolve_skill_md_path(path: Path):
    """Resolve a path to an actual SKILL.md — either the file itself or a
    directory containing one (`<skill>/SKILL.md`)."""
    if path.is_file():
        return path
    if path.is_dir():
        for candidate in ("SKILL.md", "skill.md"):
            found = path / candidate
            if found.is_file():
                return found
    return None


def _execute_skill_script(scripts_dir: Path, query: str, skill_name: str = ""):
    """Try to execute a script from a skill's ``scripts/`` directory."""
    for interpreter, pattern in ((sys.executable, "*.py"), ("bash", "*.sh")):
        for script in scripts_dir.glob(pattern):
            try:
                result = subprocess.run(
                    [interpreter, str(script), query],
                    capture_output=True, text=True, timeout=30, cwd=scripts_dir.parent,
                )
                return json.dumps({
                    "status": "success" if result.returncode == 0 else "error",
                    "skill": skill_name,
                    "script": script.name,
                    "output": result.stdout or result.stderr,
                    "return_code": result.returncode,
                })
            except Exception:
                continue
    return None


class SkillAgent(BasicAgent):
    def __init__(self, skills_dir: Path = None):
        self.name = 'Skill'
        self.skills_dir = skills_dir or (Path.home() / ".openrappter" / "skills")
        self.metadata = {
            "name": self.name,
            "description": "Runs raw SKILL.md files natively. List available skills, inspect one, or run it (executing its scripts/ if present, otherwise returning its instructions).",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "description": "Action to perform.",
                        "enum": ["run", "list", "info"]
                    },
                    "skill": {
                        "type": "string",
                        "description": "Skill name to look up under the skills directory (e.g. 'pdf' or 'creative/motion-graphics')."
                    },
                    "skill_path": {
                        "type": "string",
                        "description": "Explicit path to a SKILL.md file or a directory containing one. Overrides 'skill' if both are given."
                    },
                    "query": {
                        "type": "string",
                        "description": "Natural language input passed through to the skill's script (if any)."
                    }
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        action = kwargs.get('action', 'run')
        if action == 'list':
            return self._list_skills()

        skill_path = self._resolve_path(kwargs)
        if skill_path is None:
            return json.dumps({
                "status": "error",
                "message": "Provide 'skill_path' (a SKILL.md file or skill directory) or 'skill' (a name under the skills directory)."
            })

        resolved = _resolve_skill_md_path(skill_path)
        if resolved is None:
            return json.dumps({
                "status": "error",
                "message": f"No SKILL.md found at {skill_path}"
            })

        skill = _parse_skill_md(resolved)
        if skill is None:
            return json.dumps({
                "status": "error",
                "message": f"Failed to parse {resolved}"
            })

        has_scripts = (skill["path"].parent / "scripts").exists()

        if action == 'info':
            return json.dumps({
                "status": "success",
                "skill": skill["name"],
                "description": skill["description"],
                "instructions": skill["content"],
                "metadata": skill["metadata"],
                "path": str(skill["path"]),
                "has_scripts": has_scripts
            })

        # action == 'run' (default): execute a matching script if present,
        # otherwise hand back the instructions for the caller to follow.
        query = kwargs.get('query', '')
        if has_scripts:
            scripts_dir = skill["path"].parent / "scripts"
            result = _execute_skill_script(scripts_dir, query, skill["name"])
            if result:
                return result

        return json.dumps({
            "status": "info",
            "skill": skill["name"],
            "description": skill["description"],
            "instructions": skill["content"][:4000],
            "message": f"Skill '{skill['name']}' loaded natively. This skill provides instructions/documentation with no matching script for this input.",
            "has_scripts": has_scripts
        })

    def _resolve_path(self, kwargs) -> Path:
        skill_path = kwargs.get('skill_path', '')
        if skill_path:
            return Path(skill_path).expanduser()

        skill_name = kwargs.get('skill', '')
        if skill_name:
            return self.skills_dir / skill_name

        return None

    def _list_skills(self) -> str:
        """List all SKILL.md files discoverable under the skills directory."""
        skills = []
        if self.skills_dir.exists():
            for skill_md in sorted(self.skills_dir.rglob("SKILL.md")):
                parsed = _parse_skill_md(skill_md)
                if parsed is None:
                    continue
                skills.append({
                    "name": parsed["name"],
                    "description": parsed["description"],
                    "path": str(skill_md),
                    "has_scripts": (skill_md.parent / "scripts").exists()
                })

        return json.dumps({
            "status": "success",
            "skills_dir": str(self.skills_dir),
            "skills": skills,
            "count": len(skills)
        })
