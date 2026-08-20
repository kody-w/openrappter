"""
RappterHub Integration for openrappter

Allows openrappter to search, install, and use agents from RappterHub.
Agents are directories with AGENT.md manifests and implementation files.
"""
from openrappter.paths import openrappter_path
from openrappter.atomic_io import read_json_object, write_json_atomic

import json
import os
import re
import shutil
import subprocess
import sys
import yaml
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field


# Configuration
RAPPTERHUB_DIR = Path.home() / ".rappterhub"
AGENTS_DIR = openrappter_path("agents")
REGISTRY_URL = "https://api.rappterhub.dev"
REGISTRY_GITHUB = "https://github.com/rappterhub/registry"
LOCK_FILE = RAPPTERHUB_DIR / "lock.json"

# An agent reference is `author/name`, and each half names one directory
# segment. Anything else -- a separator, `..`, a leading `/` -- would let the
# installed path land outside the agents directory, where install() deletes
# whatever it finds and git clone writes whatever a remote repository sends.
_SAFE_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def _is_safe_segment(segment: str) -> bool:
    """True if `segment` names exactly one directory inside its parent.

    Deliberately an allow-list. Rejecting `..` is not enough: `Path("/a") /
    "/etc"` is `/etc`, because an absolute right-hand operand discards the
    left one entirely, and `Path("/a") / "/"` is `/`.

    Requiring the first character to be alphanumeric is what rejects `.`,
    `..`, dotfiles, and names that git or a shell would read as a flag.
    """
    return bool(_SAFE_SEGMENT.fullmatch(segment))


def _is_within(base: Path, candidate: Path) -> bool:
    """True if `candidate` is `base` itself or something inside it.

    Resolved on both sides so an intermediate symlink cannot smuggle a path
    back out of `base`. A path that cannot be resolved at all -- an embedded
    null byte raises ValueError, not OSError -- is not within anything.
    """
    try:
        base_resolved = base.resolve()
        candidate_resolved = candidate.resolve()
    except (OSError, ValueError):
        return False
    return (
        candidate_resolved == base_resolved
        or base_resolved in candidate_resolved.parents
    )


@dataclass
class RappterAgent:
    """Represents a parsed AGENT.md manifest."""
    name: str
    version: str
    description: str
    author: str
    runtime: str
    tags: list = field(default_factory=list)
    requires: dict = field(default_factory=dict)
    content: str = ""
    path: Optional[Path] = None

    def to_metadata(self) -> dict:
        """Convert to openrappter agent metadata format."""
        return {
            "name": self.name,
            "description": self.description,
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Query or command for the agent"
                    }
                },
                "required": []
            },
            "source": "rappterhub",
            "version": self.version,
            "author": self.author
        }


class AgentParser:
    """Parses AGENT.md files into RappterAgent objects."""

    FRONTMATTER_PATTERN = re.compile(
        r'^---\s*\n(.*?)\n---\s*\n(.*)$',
        re.DOTALL
    )

    @classmethod
    def parse_file(cls, path: Path) -> Optional[RappterAgent]:
        """Parse an AGENT.md file."""
        if not path.exists():
            return None

        content = path.read_text(encoding='utf-8')
        return cls.parse_content(content, path)

    @classmethod
    def parse_content(cls, content: str, path: Optional[Path] = None) -> Optional[RappterAgent]:
        """Parse AGENT.md content."""
        match = cls.FRONTMATTER_PATTERN.match(content)
        if not match:
            return None

        try:
            frontmatter = yaml.safe_load(match.group(1))
            if not isinstance(frontmatter, dict):
                return None

            body = match.group(2)

            return RappterAgent(
                name=frontmatter.get('name', 'unknown'),
                version=frontmatter.get('version', '0.0.0'),
                description=frontmatter.get('description', ''),
                author=frontmatter.get('author', 'unknown'),
                runtime=frontmatter.get('runtime', 'python'),
                tags=frontmatter.get('tags', []),
                requires=frontmatter.get('requires', {}),
                content=body,
                path=path.parent if path else None
            )
        except yaml.YAMLError:
            return None


class RappterHubClient:
    """
    Client for interacting with RappterHub registry.
    Provides search, install, and list functionality.
    """

    def __init__(self):
        self.agents_dir = AGENTS_DIR
        self.agents_dir.mkdir(parents=True, exist_ok=True)
        RAPPTERHUB_DIR.mkdir(parents=True, exist_ok=True)

    def _load_lock(self) -> dict:
        """Load the lock file tracking installed agents."""
        return read_json_object(
            LOCK_FILE, {"installed": {}, "version": 1}, object_fields=("installed",)
        )

    def _save_lock(self, lock: dict):
        """Save the lock file."""
        write_json_atomic(LOCK_FILE, lock)

    def search(self, query: str) -> list[dict]:
        """Search for agents in the registry."""
        try:
            import requests
            response = requests.get(
                f"{REGISTRY_URL}/search",
                params={"q": query, "limit": 20},
                timeout=10
            )
            if response.status_code == 200:
                return response.json().get("agents", [])
        except Exception:
            pass

        # Fallback: search locally
        return self.list_installed(filter_query=query)

    def install(self, agent_ref: str, force: bool = False) -> dict:
        """Install an agent from the registry."""
        # Parse agent reference
        if "/" in agent_ref and not agent_ref.startswith("http"):
            author, name = agent_ref.split("/", 1)
            if not _is_safe_segment(author) or not _is_safe_segment(name):
                return {
                    "status": "error",
                    "message": f"Invalid agent reference: {agent_ref}. Use format: author/name"
                }
            source = f"{REGISTRY_GITHUB}/raw/main/agents/{author}/{name}"
        elif agent_ref.startswith("http"):
            source = agent_ref
            name = agent_ref.rstrip("/").split("/")[-1]
            if not _is_safe_segment(name):
                return {
                    "status": "error",
                    "message": f"Cannot derive a safe agent name from URL: {agent_ref}"
                }
            author = "unknown"
        else:
            return {
                "status": "error",
                "message": f"Invalid agent reference: {agent_ref}. Use format: author/name"
            }

        # Check if already installed
        lock = self._load_lock()
        if agent_ref in lock["installed"] and not force:
            return {
                "status": "info",
                "message": f"Agent '{agent_ref}' is already installed. Use force=True to reinstall."
            }

        target_dir = self.agents_dir / name

        # Belt and braces: the name is already validated, but nothing that
        # deletes a directory tree should trust a single check.
        if not _is_within(self.agents_dir, target_dir):
            return {
                "status": "error",
                "message": f"Refusing to install outside the agents directory: {target_dir}"
            }

        try:
            if target_dir.exists():
                shutil.rmtree(target_dir)

            # Try git clone
            result = subprocess.run(
                ["git", "clone", "--depth", "1", source, str(target_dir)],
                capture_output=True,
                text=True,
                timeout=60
            )

            if result.returncode != 0:
                # Try direct download
                self._download_agent(source, target_dir)

        except Exception as e:
            return {
                "status": "error",
                "message": f"Failed to install: {str(e)}"
            }

        # Validate
        agent_md = target_dir / "AGENT.md"
        if not agent_md.exists():
            shutil.rmtree(target_dir, ignore_errors=True)
            return {
                "status": "error",
                "message": "Invalid agent: Missing AGENT.md"
            }

        manifest = AgentParser.parse_file(agent_md)
        if not manifest:
            shutil.rmtree(target_dir, ignore_errors=True)
            return {
                "status": "error",
                "message": "Invalid agent: Could not parse AGENT.md"
            }

        # Update lock file
        lock["installed"][agent_ref] = {
            "name": manifest.name,
            "version": manifest.version,
            "path": str(target_dir),
            "author": manifest.author
        }
        self._save_lock(lock)

        # Install dependencies
        self._install_dependencies(target_dir, manifest)

        return {
            "status": "success",
            "message": f"Installed {manifest.name} v{manifest.version}",
            "path": str(target_dir)
        }

    def _download_agent(self, source: str, target_dir: Path):
        """Download agent files directly."""
        import requests

        target_dir.mkdir(parents=True, exist_ok=True)
        files = ["AGENT.md", "agent.py", "agent.ts", "requirements.txt"]
        downloaded = False

        for filename in files:
            url = f"{source}/{filename}"
            try:
                response = requests.get(url, timeout=10)
                if response.status_code == 200:
                    (target_dir / filename).write_text(response.text)
                    downloaded = True
            except Exception:
                pass

        if not downloaded:
            raise Exception("Failed to download agent files")

    def _install_dependencies(self, agent_dir: Path, manifest: RappterAgent):
        """Install agent dependencies."""
        if manifest.runtime in ("python", "both"):
            requirements = agent_dir / "requirements.txt"
            if requirements.exists():
                subprocess.run(
                    [sys.executable, "-m", "pip", "install", "-q", "-r", str(requirements)],
                    capture_output=True
                )

    def list_installed(self, filter_query: str = None) -> list[dict]:
        """List installed agents."""
        agents = []

        for agent_dir in self.agents_dir.iterdir():
            if not agent_dir.is_dir():
                continue

            agent_md = agent_dir / "AGENT.md"
            if not agent_md.exists():
                continue

            manifest = AgentParser.parse_file(agent_md)
            if not manifest:
                continue

            if filter_query:
                query_lower = filter_query.lower()
                if (query_lower not in manifest.name.lower() and
                    query_lower not in manifest.description.lower() and
                    not any(query_lower in tag.lower() for tag in manifest.tags)):
                    continue

            agents.append({
                "name": manifest.name,
                "version": manifest.version,
                "description": manifest.description,
                "author": manifest.author,
                "path": str(agent_dir)
            })

        return agents

    def uninstall(self, agent_name: str) -> dict:
        """Uninstall an agent."""
        lock = self._load_lock()

        # Find agent
        found_ref = None
        for ref, info in lock.get("installed", {}).items():
            if info.get("name") == agent_name or ref == agent_name:
                found_ref = ref
                break

        if not found_ref:
            return {
                "status": "error",
                "message": f"Agent '{agent_name}' not found"
            }

        info = lock["installed"][found_ref]
        agent_path = Path(info.get("path", ""))

        # The lock file is just a file on disk, and an install from before
        # this path was validated could have recorded somewhere arbitrary.
        # Never delete a tree because a JSON field said so.
        if not _is_within(self.agents_dir, agent_path):
            return {
                "status": "error",
                "message": (
                    f"Refusing to remove '{agent_path}': it is outside the agents "
                    f"directory. Delete it by hand if you trust it."
                )
            }

        if agent_path.exists():
            shutil.rmtree(agent_path)

        del lock["installed"][found_ref]
        self._save_lock(lock)

        return {
            "status": "success",
            "message": f"Uninstalled {agent_name}"
        }

    def load_agent(self, agent_name: str):
        """Load an installed agent dynamically."""
        for agent_dir in self.agents_dir.iterdir():
            if not agent_dir.is_dir():
                continue

            agent_md = agent_dir / "AGENT.md"
            if not agent_md.exists():
                continue

            manifest = AgentParser.parse_file(agent_md)
            if manifest and manifest.name.lower() == agent_name.lower():
                # Load the Python module
                agent_py = agent_dir / "agent.py"
                if agent_py.exists():
                    import importlib.util
                    spec = importlib.util.spec_from_file_location(
                        f"rappterhub.{manifest.name}",
                        agent_py
                    )
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)

                    # Find agent class
                    for name, obj in vars(module).items():
                        if (isinstance(obj, type) and
                            hasattr(obj, 'perform') and
                            name.endswith('Agent') and
                            name != 'BasicAgent'):
                            return obj()
        return None


# Convenience functions
_client = None


def get_client() -> RappterHubClient:
    """Get or create the global RappterHub client."""
    global _client
    if _client is None:
        _client = RappterHubClient()
    return _client


def rappterhub_search(query: str) -> str:
    """Search RappterHub for agents."""
    client = get_client()
    results = client.search(query)
    return json.dumps({
        "status": "success",
        "query": query,
        "results": results,
        "count": len(results)
    }, indent=2)


def rappterhub_install(agent_ref: str, force: bool = False) -> str:
    """Install an agent from RappterHub."""
    client = get_client()
    result = client.install(agent_ref, force)
    return json.dumps(result, indent=2)


def rappterhub_list() -> str:
    """List installed RappterHub agents."""
    client = get_client()
    agents = client.list_installed()
    return json.dumps({
        "status": "success",
        "agents": agents,
        "count": len(agents),
        "agents_dir": str(client.agents_dir)
    }, indent=2)


def rappterhub_uninstall(agent_name: str) -> str:
    """Uninstall an agent."""
    client = get_client()
    result = client.uninstall(agent_name)
    return json.dumps(result, indent=2)
