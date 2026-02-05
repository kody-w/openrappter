"""
ClawHub Integration for openrappter

Allows openrappter to search, install, and use ClawHub skills.
Skills are SKILL.md files with YAML frontmatter that get wrapped as openrappter agents.
"""

import json
import os
import re
import subprocess
import yaml
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field


# Default skills directory
SKILLS_DIR = Path.home() / ".openrappter" / "skills"


@dataclass
class ClawHubSkill:
    """Represents a parsed ClawHub SKILL.md"""
    name: str
    description: str
    content: str  # Full markdown content
    metadata: dict = field(default_factory=dict)
    path: Optional[Path] = None

    def to_agent_metadata(self) -> dict:
        """Convert to openrappter agent metadata format."""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Natural language query or command for the skill"
                    },
                    "action": {
                        "type": "string",
                        "description": "Specific action to perform (if supported by skill)"
                    }
                },
                "required": []
            },
            "source": "clawhub",
            "skill_metadata": self.metadata
        }


class SkillParser:
    """Parses SKILL.md files into ClawHubSkill objects."""

    FRONTMATTER_PATTERN = re.compile(
        r'^---\s*\n(.*?)\n---\s*\n(.*)$',
        re.DOTALL
    )

    # Alternative: some skills use just key: value at the top
    INLINE_METADATA_PATTERN = re.compile(
        r'^(name|description|metadata):\s*(.+)$',
        re.MULTILINE
    )

    @classmethod
    def parse_file(cls, path: Path) -> Optional[ClawHubSkill]:
        """Parse a SKILL.md file."""
        if not path.exists():
            return None

        content = path.read_text(encoding='utf-8')
        return cls.parse_content(content, path)

    @classmethod
    def parse_content(cls, content: str, path: Optional[Path] = None) -> Optional[ClawHubSkill]:
        """Parse SKILL.md content."""
        name = "unknown"
        description = ""
        metadata = {}
        body = content

        # Try YAML frontmatter first
        match = cls.FRONTMATTER_PATTERN.match(content)
        if match:
            try:
                frontmatter = yaml.safe_load(match.group(1))
                if isinstance(frontmatter, dict):
                    name = frontmatter.get('name', name)
                    description = frontmatter.get('description', '')
                    # Parse nested metadata JSON if present
                    if 'metadata' in frontmatter:
                        if isinstance(frontmatter['metadata'], str):
                            try:
                                metadata = json.loads(frontmatter['metadata'])
                            except json.JSONDecodeError:
                                metadata = {'raw': frontmatter['metadata']}
                        else:
                            metadata = frontmatter['metadata']
                body = match.group(2)
            except yaml.YAMLError:
                pass
        else:
            # Try inline metadata format (key: value at top)
            lines = content.split('\n')
            body_start = 0
            for i, line in enumerate(lines):
                inline_match = cls.INLINE_METADATA_PATTERN.match(line)
                if inline_match:
                    key, value = inline_match.groups()
                    if key == 'name':
                        name = value.strip()
                    elif key == 'description':
                        description = value.strip()
                    elif key == 'metadata':
                        try:
                            metadata = json.loads(value.strip())
                        except json.JSONDecodeError:
                            metadata = {'raw': value.strip()}
                    body_start = i + 1
                elif line.strip() and not line.startswith('#'):
                    break
            body = '\n'.join(lines[body_start:])

        # Derive name from path if not found
        if name == "unknown" and path:
            name = path.parent.name or path.stem

        # Extract description from first paragraph if not in frontmatter
        if not description and body:
            # Find first non-heading paragraph
            for para in body.split('\n\n'):
                para = para.strip()
                if para and not para.startswith('#'):
                    description = para[:200]
                    break

        return ClawHubSkill(
            name=name,
            description=description,
            content=body,
            metadata=metadata,
            path=path
        )


class ClawHubSkillAgent:
    """
    Wraps a ClawHub skill as an openrappter agent.
    Provides the standard agent interface (metadata, execute, perform).
    """

    def __init__(self, skill: ClawHubSkill):
        self.skill = skill
        self.name = skill.name
        self.metadata = skill.to_agent_metadata()
        self.context = {}

    def execute(self, **kwargs) -> str:
        """Execute the skill with context enrichment."""
        # Basic context (skills don't have full data sloshing)
        self.context = {
            'source': 'clawhub',
            'skill_name': self.skill.name
        }
        return self.perform(**kwargs)

    def perform(self, **kwargs) -> str:
        """
        Perform the skill action.

        ClawHub skills are primarily documentation/instructions.
        This method returns the skill content and attempts to execute
        any scripts if they exist.
        """
        query = kwargs.get('query', '')
        action = kwargs.get('action', '')

        # Check for executable scripts in the skill directory
        if self.skill.path:
            scripts_dir = self.skill.path.parent / "scripts"
            if scripts_dir.exists():
                # Try to find and run a matching script
                result = self._try_execute_script(scripts_dir, action or query)
                if result:
                    return result

        # Return skill documentation/instructions
        return json.dumps({
            "status": "info",
            "skill": self.skill.name,
            "description": self.skill.description,
            "instructions": self.skill.content[:2000],
            "message": f"Skill '{self.skill.name}' loaded. This skill provides instructions/documentation.",
            "has_scripts": bool(self.skill.path and (self.skill.path.parent / "scripts").exists())
        })

    def _try_execute_script(self, scripts_dir: Path, query: str) -> Optional[str]:
        """Try to execute a script from the skill's scripts directory."""
        # Look for common script patterns
        for script in scripts_dir.glob("*.py"):
            try:
                result = subprocess.run(
                    ["python", str(script), query],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    cwd=scripts_dir.parent
                )
                return json.dumps({
                    "status": "success" if result.returncode == 0 else "error",
                    "skill": self.skill.name,
                    "script": script.name,
                    "output": result.stdout or result.stderr,
                    "return_code": result.returncode
                })
            except Exception as e:
                continue

        for script in scripts_dir.glob("*.sh"):
            try:
                result = subprocess.run(
                    ["bash", str(script), query],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    cwd=scripts_dir.parent
                )
                return json.dumps({
                    "status": "success" if result.returncode == 0 else "error",
                    "skill": self.skill.name,
                    "script": script.name,
                    "output": result.stdout or result.stderr,
                    "return_code": result.returncode
                })
            except Exception as e:
                continue

        return None


class ClawHubClient:
    """
    Client for interacting with ClawHub registry.
    Provides search, install, and list functionality.
    """

    def __init__(self, skills_dir: Path = None):
        self.skills_dir = skills_dir or SKILLS_DIR
        self.skills_dir.mkdir(parents=True, exist_ok=True)
        self._lock_file = self.skills_dir / ".clawhub" / "lock.json"

    def _load_lock(self) -> dict:
        """Load the lock file tracking installed skills."""
        if self._lock_file.exists():
            try:
                return json.loads(self._lock_file.read_text())
            except json.JSONDecodeError:
                pass
        return {"installed": {}}

    def _save_lock(self, lock: dict):
        """Save the lock file."""
        self._lock_file.parent.mkdir(parents=True, exist_ok=True)
        self._lock_file.write_text(json.dumps(lock, indent=2))

    def search(self, query: str) -> list[dict]:
        """
        Search for skills using clawhub CLI.
        Falls back to local search if CLI unavailable.
        """
        # Try using clawhub CLI
        try:
            result = subprocess.run(
                ["npx", "clawhub@latest", "search", query],
                capture_output=True,
                text=True,
                timeout=30
            )
            if result.returncode == 0 and result.stdout:
                # Parse CLI output (format varies)
                skills = []
                for line in result.stdout.strip().split('\n'):
                    if line.strip():
                        # Attempt to parse as JSON or extract name
                        try:
                            skills.append(json.loads(line))
                        except json.JSONDecodeError:
                            # Parse text format: "name - description"
                            parts = line.split(' - ', 1)
                            if len(parts) == 2:
                                skills.append({
                                    "name": parts[0].strip(),
                                    "description": parts[1].strip()
                                })
                return skills
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

        # Fallback: search installed skills
        return self.list_installed(filter_query=query)

    def install(self, skill_slug: str) -> dict:
        """
        Install a skill from ClawHub.
        Uses npx clawhub install if available.
        """
        try:
            result = subprocess.run(
                ["npx", "clawhub@latest", "install", skill_slug, "--dir", str(self.skills_dir)],
                capture_output=True,
                text=True,
                timeout=120
            )

            if result.returncode == 0:
                # Update lock file
                lock = self._load_lock()
                lock["installed"][skill_slug] = {
                    "version": "latest",
                    "installed_at": str(Path.cwd())
                }
                self._save_lock(lock)

                return {
                    "status": "success",
                    "message": f"Installed skill: {skill_slug}",
                    "output": result.stdout
                }
            else:
                return {
                    "status": "error",
                    "message": f"Failed to install {skill_slug}",
                    "error": result.stderr or result.stdout
                }
        except FileNotFoundError:
            return {
                "status": "error",
                "message": "clawhub CLI not found. Install with: npm install -g clawhub"
            }
        except subprocess.TimeoutExpired:
            return {
                "status": "error",
                "message": "Installation timed out"
            }

    def list_installed(self, filter_query: str = None) -> list[dict]:
        """List all installed skills."""
        skills = []

        if not self.skills_dir.exists():
            return skills

        # Scan for SKILL.md files
        for skill_md in self.skills_dir.rglob("SKILL.md"):
            skill = SkillParser.parse_file(skill_md)
            if skill:
                if filter_query:
                    query_lower = filter_query.lower()
                    if query_lower not in skill.name.lower() and query_lower not in skill.description.lower():
                        continue
                skills.append({
                    "name": skill.name,
                    "description": skill.description,
                    "path": str(skill_md.parent)
                })

        return skills

    def load_skill(self, skill_name: str) -> Optional[ClawHubSkillAgent]:
        """Load an installed skill as an agent."""
        for skill_md in self.skills_dir.rglob("SKILL.md"):
            skill = SkillParser.parse_file(skill_md)
            if skill and skill.name.lower() == skill_name.lower():
                return ClawHubSkillAgent(skill)
        return None

    def load_all_skills(self) -> list[ClawHubSkillAgent]:
        """Load all installed skills as agents."""
        agents = []
        for skill_md in self.skills_dir.rglob("SKILL.md"):
            skill = SkillParser.parse_file(skill_md)
            if skill:
                agents.append(ClawHubSkillAgent(skill))
        return agents


# Convenience functions for CLI usage
_client = None

def get_client() -> ClawHubClient:
    """Get or create the global ClawHub client."""
    global _client
    if _client is None:
        _client = ClawHubClient()
    return _client


def clawhub_search(query: str) -> str:
    """Search ClawHub for skills."""
    client = get_client()
    results = client.search(query)
    return json.dumps({
        "status": "success",
        "query": query,
        "results": results,
        "count": len(results)
    }, indent=2)


def clawhub_install(skill_slug: str) -> str:
    """Install a skill from ClawHub."""
    client = get_client()
    result = client.install(skill_slug)
    return json.dumps(result, indent=2)


def clawhub_list() -> str:
    """List installed ClawHub skills."""
    client = get_client()
    skills = client.list_installed()
    return json.dumps({
        "status": "success",
        "skills": skills,
        "count": len(skills),
        "skills_dir": str(client.skills_dir)
    }, indent=2)
