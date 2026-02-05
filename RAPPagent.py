#!/usr/bin/env python3
"""
🦖 openRAPPter — The velociRAPPter in your terminal

A single-file AI agent that runs locally with zero API keys.
The medium IS the message.

Usage:
    python RAPPagent.py                    # Interactive mode
    python RAPPagent.py --task "do X"      # Run a single task
    python RAPPagent.py --evolve 10        # Evolve N iterations
    python RAPPagent.py --daemon           # Run as background daemon

Dependencies:
    - Python 3.10+
    - GitHub Copilot CLI (optional, for LLM features)

No external packages required — runs standalone!
"""

import os
import sys
import json
import time
import hashlib
import subprocess
import argparse
from pathlib import Path
from datetime import datetime
from typing import Any, Callable

# ═══════════════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════════════

VERSION = "1.0.0"
EMOJI = "🦖"
NAME = "openRAPPter"
HOME = Path.home() / ".openrappter"
MEMORY_FILE = HOME / "memory.json"
STATE_FILE = HOME / "state.json"
SKILLS_DIR = HOME / "skills"

# Ensure directories exist
HOME.mkdir(exist_ok=True)
SKILLS_DIR.mkdir(exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════════
# MEMORY SYSTEM
# ═══════════════════════════════════════════════════════════════════════════════

class Memory:
    """Persistent memory store with semantic search."""

    def __init__(self, path: Path = MEMORY_FILE):
        self.path = path
        self.memories: list[dict] = []
        self._load()

    def _load(self) -> None:
        if self.path.exists():
            try:
                self.memories = json.loads(self.path.read_text())
            except json.JSONDecodeError:
                self.memories = []

    def _save(self) -> None:
        self.path.write_text(json.dumps(self.memories, indent=2))

    def add(self, content: str, tags: list[str] | None = None) -> dict:
        """Add a memory entry."""
        entry = {
            "id": hashlib.sha256(f"{content}{time.time()}".encode()).hexdigest()[:12],
            "content": content,
            "tags": tags or [],
            "created": datetime.now().isoformat(),
            "accessed": 0,
        }
        self.memories.append(entry)
        self._save()
        return entry

    def search(self, query: str, limit: int = 5) -> list[dict]:
        """Search memories by content similarity."""
        query_lower = query.lower()
        scored = []
        for mem in self.memories:
            content_lower = mem["content"].lower()
            score = sum(1 for word in query_lower.split() if word in content_lower)
            if score > 0 or query_lower in content_lower:
                scored.append((score + (1 if query_lower in content_lower else 0), mem))
        scored.sort(key=lambda x: -x[0])
        return [m for _, m in scored[:limit]]

    def recall(self, memory_id: str) -> dict | None:
        """Recall a specific memory by ID."""
        for mem in self.memories:
            if mem["id"] == memory_id:
                mem["accessed"] += 1
                self._save()
                return mem
        return None

    def forget(self, memory_id: str) -> bool:
        """Remove a memory by ID."""
        for i, mem in enumerate(self.memories):
            if mem["id"] == memory_id:
                self.memories.pop(i)
                self._save()
                return True
        return False

    def list_all(self) -> list[dict]:
        """List all memories."""
        return self.memories.copy()


# ═══════════════════════════════════════════════════════════════════════════════
# SKILLS SYSTEM
# ═══════════════════════════════════════════════════════════════════════════════

class Skills:
    """Extensible skill system."""

    def __init__(self):
        self._skills: dict[str, Callable] = {}
        self._register_builtins()

    def _register_builtins(self) -> None:
        """Register built-in skills."""

        @self.register("bash", "Execute a shell command")
        def bash(command: str) -> str:
            try:
                result = subprocess.run(
                    command,
                    shell=True,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                output = result.stdout or result.stderr
                return output[:2000] if output else "(no output)"
            except subprocess.TimeoutExpired:
                return "Error: Command timed out"
            except Exception as e:
                return f"Error: {e}"

        @self.register("read", "Read a file's contents")
        def read(path: str) -> str:
            try:
                p = Path(path).expanduser()
                if not p.exists():
                    return f"Error: File not found: {path}"
                content = p.read_text()
                return content[:5000] if len(content) > 5000 else content
            except Exception as e:
                return f"Error: {e}"

        @self.register("write", "Write content to a file")
        def write(path: str, content: str) -> str:
            try:
                p = Path(path).expanduser()
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(content)
                return f"Written {len(content)} bytes to {path}"
            except Exception as e:
                return f"Error: {e}"

        @self.register("list", "List directory contents")
        def list_dir(path: str = ".") -> str:
            try:
                p = Path(path).expanduser()
                if not p.exists():
                    return f"Error: Directory not found: {path}"
                items = list(p.iterdir())[:50]
                return "\n".join(
                    f"{'📁' if i.is_dir() else '📄'} {i.name}" for i in sorted(items)
                )
            except Exception as e:
                return f"Error: {e}"

    def register(self, name: str, description: str) -> Callable:
        """Decorator to register a skill."""

        def decorator(func: Callable) -> Callable:
            func._skill_name = name
            func._skill_desc = description
            self._skills[name] = func
            return func

        return decorator

    def execute(self, name: str, **kwargs) -> str:
        """Execute a skill by name."""
        if name not in self._skills:
            return f"Error: Unknown skill '{name}'. Available: {', '.join(self._skills.keys())}"
        try:
            return self._skills[name](**kwargs)
        except Exception as e:
            return f"Error executing {name}: {e}"

    def list_skills(self) -> list[dict]:
        """List all available skills."""
        return [
            {"name": name, "description": getattr(fn, "_skill_desc", "")}
            for name, fn in self._skills.items()
        ]


# ═══════════════════════════════════════════════════════════════════════════════
# EVOLVER — Autonomous Background Processing
# ═══════════════════════════════════════════════════════════════════════════════

class Evolver:
    """Autonomous evolution engine."""

    def __init__(self, agent: "RAPPagent"):
        self.agent = agent
        self.iteration = 0

    def tick(self) -> dict:
        """Run one evolution tick."""
        self.iteration += 1
        actions = []

        # Memory consolidation
        memories = self.agent.memory.list_all()
        if len(memories) > 100:
            # Keep most accessed
            sorted_mems = sorted(memories, key=lambda m: -m.get("accessed", 0))
            for old_mem in sorted_mems[100:]:
                self.agent.memory.forget(old_mem["id"])
            actions.append(f"Consolidated memories (kept top 100)")

        # Check system health
        health = self._check_health()
        if health["issues"]:
            actions.append(f"Health issues: {', '.join(health['issues'])}")

        # Auto-learning
        cwd = Path.cwd()
        if cwd.exists():
            readme = cwd / "README.md"
            if readme.exists() and not self.agent.memory.search(str(readme)):
                self.agent.memory.add(
                    f"Project context: {readme.read_text()[:500]}",
                    tags=["context", "auto"],
                )
                actions.append("Learned project context from README")

        return {
            "iteration": self.iteration,
            "actions": actions,
            "timestamp": datetime.now().isoformat(),
        }

    def _check_health(self) -> dict:
        """Check system health."""
        issues = []

        # Check disk space
        try:
            import shutil

            total, used, free = shutil.disk_usage("/")
            if free / total < 0.1:
                issues.append("Low disk space")
        except Exception:
            pass

        # Check memory file size
        if MEMORY_FILE.exists() and MEMORY_FILE.stat().st_size > 10_000_000:
            issues.append("Memory file too large")

        return {"issues": issues, "healthy": len(issues) == 0}


# ═══════════════════════════════════════════════════════════════════════════════
# LLM BRIDGE — Connect to GitHub Copilot SDK
# ═══════════════════════════════════════════════════════════════════════════════

class LLMBridge:
    """Bridge to LLM providers (GitHub Copilot SDK)."""

    def __init__(self):
        self.has_copilot = self._check_copilot()

    def _check_copilot(self) -> bool:
        """Check if Copilot CLI is available."""
        try:
            result = subprocess.run(
                ["copilot", "--version"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return result.returncode == 0
        except Exception:
            return False

    def chat(self, message: str, context: str = "") -> str:
        """Send a message and get a response."""
        if not self.has_copilot:
            return self._local_response(message)

        # Use Copilot CLI for response
        try:
            full_prompt = f"{context}\n\nUser: {message}" if context else message
            result = subprocess.run(
                ["copilot", "--message", full_prompt],
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode == 0 and result.stdout:
                return result.stdout.strip()
            return self._local_response(message)
        except Exception as e:
            return self._local_response(message)

    def _local_response(self, message: str) -> str:
        """Fallback local response when no LLM available."""
        msg_lower = message.lower()

        if "hello" in msg_lower or "hi" in msg_lower:
            return f"Hello! I'm {NAME} {EMOJI}. How can I help you today?"

        if "help" in msg_lower:
            return f"""I'm {NAME} {EMOJI}, your local AI assistant.

I can help you with:
• Running shell commands (just ask!)
• Reading and writing files
• Remembering things for later
• Exploring your codebase

Try asking me to do something specific!"""

        if "who" in msg_lower and "you" in msg_lower:
            return f"I'm {NAME} {EMOJI}, a local-first AI agent. No API keys needed!"

        return f"I heard: '{message}'. For full AI responses, install GitHub Copilot CLI."


# ═══════════════════════════════════════════════════════════════════════════════
# MAIN AGENT
# ═══════════════════════════════════════════════════════════════════════════════

class RAPPagent:
    """The main openRAPPter agent."""

    def __init__(self):
        self.memory = Memory()
        self.skills = Skills()
        self.evolver = Evolver(self)
        self.llm = LLMBridge()
        self.state = self._load_state()

    def _load_state(self) -> dict:
        """Load persistent state."""
        if STATE_FILE.exists():
            try:
                return json.loads(STATE_FILE.read_text())
            except Exception:
                pass
        return {"sessions": 0, "last_run": None}

    def _save_state(self) -> None:
        """Save persistent state."""
        self.state["last_run"] = datetime.now().isoformat()
        STATE_FILE.write_text(json.dumps(self.state, indent=2))

    def process(self, user_input: str) -> str:
        """Process user input and generate a response."""
        # Check for skill invocations
        if user_input.startswith("/"):
            return self._handle_command(user_input)

        # Check for tool calls in natural language
        input_lower = user_input.lower()

        if any(kw in input_lower for kw in ["remember", "save", "store"]):
            # Extract what to remember
            content = user_input
            for prefix in ["remember ", "save ", "store ", "remember that "]:
                if input_lower.startswith(prefix):
                    content = user_input[len(prefix):]
                    break
            entry = self.memory.add(content)
            return f"Got it! I'll remember that. (ID: {entry['id']})"

        if any(kw in input_lower for kw in ["recall", "what do you remember", "search memory"]):
            query = user_input
            for prefix in ["recall ", "search memory for ", "what do you remember about "]:
                if input_lower.startswith(prefix):
                    query = user_input[len(prefix):]
                    break
            results = self.memory.search(query)
            if results:
                return "Here's what I remember:\n" + "\n".join(
                    f"• {m['content']}" for m in results
                )
            return "I don't have any memories matching that."

        if any(kw in input_lower for kw in ["run ", "execute ", "$ "]):
            # Extract command
            for prefix in ["run ", "execute ", "$ "]:
                if input_lower.startswith(prefix):
                    cmd = user_input[len(prefix):]
                    return f"Running: {cmd}\n\n{self.skills.execute('bash', command=cmd)}"

        if "read " in input_lower or "show " in input_lower:
            # Extract file path
            for prefix in ["read ", "show ", "cat "]:
                if input_lower.startswith(prefix):
                    path = user_input[len(prefix):].strip()
                    return self.skills.execute("read", path=path)

        if "list " in input_lower or input_lower in ["ls", "dir"]:
            path = "."
            if input_lower.startswith("list "):
                path = user_input[5:].strip() or "."
            return self.skills.execute("list", path=path)

        # Default: use LLM
        context = self._build_context()
        return self.llm.chat(user_input, context)

    def _handle_command(self, cmd: str) -> str:
        """Handle slash commands."""
        parts = cmd[1:].split(maxsplit=1)
        command = parts[0].lower()
        args = parts[1] if len(parts) > 1 else ""

        if command == "help":
            return f"""
{EMOJI} {NAME} Commands:

/help          - Show this help
/skills        - List available skills
/memory        - Show recent memories
/forget <id>   - Forget a memory
/evolve [n]    - Run evolution ticks
/status        - Show agent status
/quit          - Exit
"""

        if command == "skills":
            skills_list = self.skills.list_skills()
            return "Available skills:\n" + "\n".join(
                f"• {s['name']}: {s['description']}" for s in skills_list
            )

        if command == "memory":
            memories = self.memory.list_all()[-10:]
            if not memories:
                return "No memories yet."
            return "Recent memories:\n" + "\n".join(
                f"• [{m['id']}] {m['content'][:50]}..." for m in memories
            )

        if command == "forget":
            if not args:
                return "Usage: /forget <memory_id>"
            if self.memory.forget(args.strip()):
                return f"Forgot memory {args}"
            return f"Memory not found: {args}"

        if command == "evolve":
            n = int(args) if args.isdigit() else 1
            results = []
            for _ in range(n):
                tick = self.evolver.tick()
                results.append(tick)
            return f"Evolved {n} iterations:\n" + "\n".join(
                f"  [{r['iteration']}] {', '.join(r['actions']) or 'No actions'}"
                for r in results
            )

        if command == "status":
            return f"""
{EMOJI} {NAME} Status

Version: {VERSION}
Sessions: {self.state['sessions']}
Last run: {self.state.get('last_run', 'Never')}
Memories: {len(self.memory.list_all())}
Skills: {len(self.skills.list_skills())}
Copilot: {'✅ Available' if self.llm.has_copilot else '❌ Not found'}
"""

        if command in ["quit", "exit", "q"]:
            return "__EXIT__"

        return f"Unknown command: /{command}. Try /help"

    def _build_context(self) -> str:
        """Build context from recent memories."""
        recent = self.memory.list_all()[-5:]
        if not recent:
            return ""
        return "Context from memory:\n" + "\n".join(m["content"] for m in recent)

    def run_interactive(self) -> None:
        """Run interactive chat loop."""
        self.state["sessions"] += 1
        self._save_state()

        print(f"\n{EMOJI} {NAME} v{VERSION}")
        print("─" * 40)
        print("Type /help for commands, /quit to exit\n")

        while True:
            try:
                user_input = input(f"{EMOJI} You: ").strip()
                if not user_input:
                    continue

                response = self.process(user_input)
                if response == "__EXIT__":
                    print(f"\nGoodbye! {EMOJI}")
                    break

                print(f"\n{EMOJI} {NAME}: {response}\n")

            except KeyboardInterrupt:
                print(f"\n\nGoodbye! {EMOJI}")
                break
            except EOFError:
                break

    def run_task(self, task: str) -> str:
        """Run a single task."""
        self.state["sessions"] += 1
        self._save_state()
        return self.process(task)

    def run_daemon(self, interval: int = 60) -> None:
        """Run as background daemon."""
        print(f"{EMOJI} {NAME} daemon started (interval: {interval}s)")
        print("Press Ctrl+C to stop\n")

        while True:
            try:
                tick = self.evolver.tick()
                if tick["actions"]:
                    print(f"[{tick['timestamp']}] {', '.join(tick['actions'])}")
                time.sleep(interval)
            except KeyboardInterrupt:
                print(f"\n{EMOJI} Daemon stopped")
                break


# ═══════════════════════════════════════════════════════════════════════════════
# CLI ENTRY POINT
# ═══════════════════════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(
        description=f"{EMOJI} {NAME} — Local-first AI agent",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Examples:
  python RAPPagent.py                     Interactive mode
  python RAPPagent.py --task "hello"      Run a single task
  python RAPPagent.py --evolve 10         Evolve 10 iterations
  python RAPPagent.py --daemon            Run as daemon
  python RAPPagent.py --status            Show status
""",
    )
    parser.add_argument("--version", "-v", action="version", version=f"{NAME} {VERSION}")
    parser.add_argument("--task", "-t", help="Run a single task")
    parser.add_argument("--evolve", "-e", type=int, metavar="N", help="Run N evolution ticks")
    parser.add_argument("--daemon", "-d", action="store_true", help="Run as daemon")
    parser.add_argument("--interval", type=int, default=60, help="Daemon interval (seconds)")
    parser.add_argument("--status", "-s", action="store_true", help="Show status")

    args = parser.parse_args()

    agent = RAPPagent()

    if args.status:
        print(agent.process("/status"))
    elif args.task:
        result = agent.run_task(args.task)
        print(result)
    elif args.evolve:
        for i in range(args.evolve):
            tick = agent.evolver.tick()
            print(f"[{tick['iteration']}] {', '.join(tick['actions']) or 'No actions'}")
    elif args.daemon:
        agent.run_daemon(args.interval)
    else:
        agent.run_interactive()


if __name__ == "__main__":
    main()
