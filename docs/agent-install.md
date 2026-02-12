# openrappter — Complete Agent Reference

> **For AI agents**: Read this file to learn how to install, configure, use, and extend openrappter. This is the single source of truth.

## What Is openrappter

openrappter is a dual-runtime (Python + TypeScript) AI agent framework. It uses GitHub Copilot as the cloud AI backbone — your agent data (memory, config, state) stays local in `~/.openrappter/`. Copilot handles inference; everything else runs on the user's machine.

- **Repo**: `https://github.com/kody-w/openrappter`
- **License**: MIT
- **Version**: 1.4.0

---

## 1. Prerequisites

| Requirement | Check Command | Notes |
|---|---|---|
| Node.js 18+ | `node --version` | TypeScript runtime |
| Python 3.10+ | `python3 --version` | Python runtime |
| GitHub Copilot CLI | `copilot --version` | Optional — enables AI-powered routing. Without it, keyword matching fallback is used. |

---

## 2. Installation

### Clone

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter
```

### TypeScript Runtime

```bash
cd typescript
npm install
npm run build
```

### Python Runtime

```bash
cd python
pip install -e .
# If pip version is old or editable mode fails:
pip install .
# Or run directly without installing:
python3 -m openrappter.cli --status
```

---

## 3. Verification

Run these commands after install. All must succeed before proceeding.

### TypeScript

```bash
cd typescript

# Status check — expect "Agents: 2 loaded"
node dist/index.js --status

# Memory store
node dist/index.js "remember that I installed openrappter"

# Memory recall
node dist/index.js "recall openrappter"

# Shell test
node dist/index.js "ls"
```

### Python

```bash
cd python

# Status check — expect "agents_loaded: 5"
python3 -m openrappter.cli --status

# List agents
python3 -m openrappter.cli --list-agents

# Memory test (use --task flag for positional arg)
python3 -m openrappter.cli --task "remember that Python works"
```

---

## 4. CLI Reference

### TypeScript

```bash
node dist/index.js [options] [message]
```

### Python

```bash
openrappter [options]              # If pip-installed
python3 -m openrappter.cli [options]  # Direct
```

### Options

| Option | Description |
|---|---|
| `[message]` | Send a single message (TypeScript only as positional arg) |
| `-t, --task <task>` | Run a task and exit |
| `-s, --status` | Show agent status |
| `--list-agents` | List all discovered agents |
| `--exec <agent> <query>` | Execute a specific agent directly |
| `-e, --evolve <n>` | Run N evolution ticks |
| `-d, --daemon` | Run as background daemon |
| `-v, --version` | Show version |
| `-h, --help` | Show help |
| `onboard` | Run interactive setup wizard (TypeScript) |

### Interactive Mode Slash Commands

| Command | Description |
|---|---|
| `/help` | Show help |
| `/agents` | List available agents |
| `/status` | Show agent status |
| `/quit` | Exit |

---

## 5. Built-in Agents

### Python Runtime (5 agents)

| Agent | Name | Description |
|---|---|---|
| **ManageMemory** | `ManageMemory` | Stores important information to memory for future reference. Accepts `content`, `importance`, `memory_type`, `tags`. |
| **ContextMemory** | `ContextMemory` | Recalls and provides context based on stored memories of past interactions. |
| **Shell** | `Shell` | Executes shell commands and file operations. Actions: `bash`, `read`, `write`, `list`. |
| **LearnNew** | `LearnNew` | Creates new agents from natural language descriptions. Generates code, writes to `agents/`, and hot-loads. |

### TypeScript Runtime (2 agents)

| Agent | Name | Description |
|---|---|---|
| **MemoryAgent** | `Memory` | Stores and recalls facts in persistent memory. Actions: `remember`, `recall`, `list`, `forget`. |
| **ShellAgent** | `Shell` | Executes shell commands and file operations. Actions: `bash`, `read`, `write`, `list`. |

### Using Agents

Agents are matched via keyword patterns in natural language:

```bash
# Memory keywords: remember, store, save, recall, memory, forget
openrappter --task "remember that the deploy command is npm run deploy"
openrappter --task "recall deploy"

# Shell keywords: run, execute, bash, ls, cat, read file, list dir
openrappter --task "ls"
openrappter --task "read README.md"

# Direct agent execution
openrappter --exec Shell "ls -la"
openrappter --exec ManageMemory "save this fact"

# TypeScript equivalents
node dist/index.js "remember my API endpoint is /v2/users"
node dist/index.js --exec Shell "ls"
```

---

## 6. Creating Custom Agents

Agents are auto-discovered by file naming convention. Drop a file in the `agents/` directory and the registry finds it — no manual registration needed.

### Python: `*_agent.py`

Create `python/openrappter/agents/my_agent.py`:

```python
from openrappter.agents.basic_agent import BasicAgent
import json

class MyAgent(BasicAgent):
    def __init__(self):
        self.name = 'MyAgent'
        self.metadata = {
            "name": self.name,
            "description": "Describe what this agent does",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "User input"}
                },
                "required": []
            }
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        query = kwargs.get('query', '')
        # self.context has enriched signals from data sloshing (see Section 8)
        return json.dumps({"status": "success", "result": query})
```

### TypeScript: `*Agent.ts`

Create `typescript/src/agents/MyAgent.ts`:

```typescript
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class MyAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'MyAgent',
      description: 'Describe what this agent does',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'User input' }
        },
        required: []
      }
    };
    super('MyAgent', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = kwargs.query as string;
    // this.context has enriched signals from data sloshing (see Section 8)
    return JSON.stringify({ status: 'success', result: query });
  }
}
```

After creating, rebuild TypeScript (`npm run build`) — Python agents are hot-loaded automatically.

### Agent Contract Rules

1. **Extend `BasicAgent`** — do not implement from scratch
2. **Implement `perform()`** — this is called by the orchestrator after context enrichment
3. **Return JSON string** — always `{"status": "success|error", ...}`
4. **Metadata format** — OpenAI tools format with `name`, `description`, `parameters`
5. **File naming** — `*_agent.py` (Python) or `*Agent.ts` (TypeScript) for auto-discovery

### Generating Agents at Runtime (Python)

The `LearnNew` agent can create agents from natural language:

```bash
openrappter --exec LearnNew "create an agent that fetches weather data"
# Generates code, writes to agents/, hot-loads, installs dependencies if needed
```

---

## 7. Memory System

Memory persists across sessions in `~/.openrappter/memory.json`.

### Store

```bash
# Python
openrappter --task "remember that the database is PostgreSQL"

# TypeScript
node dist/index.js "remember that the database is PostgreSQL"
```

### Recall

```bash
openrappter --task "recall database"
node dist/index.js "recall database"
```

### Forget

```bash
node dist/index.js "forget database"
```

### Memory Entry Structure

```json
{
  "mem_1707100000000": {
    "message": "the database is PostgreSQL",
    "theme": "general",
    "timestamp": "2025-02-05T10:00:00.000Z"
  }
}
```

### Data Locations

| File | Purpose |
|---|---|
| `~/.openrappter/config.json` | Configuration settings |
| `~/.openrappter/memory.json` | Persistent memory store |
| `~/.openrappter/state.json` | Agent state data |
| `~/.openrappter/skills/` | Installed ClawHub/RappterHub skills |

---

## 8. Data Sloshing (Context Enrichment)

Every agent call is automatically enriched with contextual signals before `perform()` runs. Agents never execute "blind." Access via `self.context` (Python) or `this.context` (TypeScript).

### Signal Categories

| Signal | Keys | Description |
|---|---|---|
| **Temporal** | `time_of_day`, `day_of_week`, `is_weekend`, `quarter`, `fiscal`, `likely_activity`, `is_urgent_period` | Time awareness |
| **Query Signals** | `specificity`, `hints`, `word_count`, `is_question`, `has_id_pattern` | What the user is asking |
| **Memory Echoes** | `message`, `theme`, `relevance` | Relevant past interactions |
| **Behavioral** | `prefers_brief`, `technical_level`, `frequent_entities` | User patterns |
| **Orientation** | `confidence`, `approach`, `hints`, `response_style` | Synthesized action guidance |
| **Upstream Slush** | `source_agent`, plus agent-declared signals | Live data from the previous agent in a chain |

### Accessing Signals

```python
# Python — in perform()
time = self.get_signal('temporal.time_of_day')
confidence = self.get_signal('orientation.confidence')
is_brief = self.get_signal('behavioral.prefers_brief', False)

# Access upstream agent signals (when chained)
upstream = self.context.get('upstream_slush', {})
```

```typescript
// TypeScript — in perform()
const time = this.getSignal('temporal.time_of_day');
const confidence = this.getSignal('orientation.confidence');
const isBrief = this.getSignal('behavioral.prefers_brief', false);

// Access upstream agent signals (when chained)
const upstream = this.context?.upstream_slush;
```

### Data Slush (Agent-to-Agent Signal Pipeline)

Agents can return a `data_slush` field in their JSON output — curated signals extracted from live results. The framework extracts this after `perform()` and stores it on `last_data_slush` (Python) / `lastDataSlush` (TypeScript). To chain agents, pass it as `upstream_slush` to the next `execute()` call.

```python
# Agent A returns curated signals
return json.dumps({
    "status": "success",
    "result": "...",
    "data_slush": {"source_agent": self.name, "temp_f": 65, "mood": "calm"}
})

# Chain: feed A's output into B
result_b = agent_b.execute(query="...", upstream_slush=agent_a.last_data_slush)
# B's self.context['upstream_slush'] == {"source_agent": "...", "temp_f": 65, ...}
```

### Execution Flow

```
User Input → execute() → slosh() enriches context → merge upstream_slush → perform() → extract data_slush
```

---

## 9. RappterHub & ClawHub

### RappterHub (native registry)

```bash
# Search agents
openrappter rappterhub search "git automation"

# Install an agent
openrappter rappterhub install kody-w/git-helper

# List installed
openrappter rappterhub list

# Uninstall
openrappter rappterhub uninstall kody-w/git-helper
```

### ClawHub (compatibility layer)

openrappter is compatible with ClawHub skills from OpenClaw:

```bash
openrappter clawhub search "productivity"
openrappter clawhub install author/skill-name
openrappter clawhub list
```

Installed skills are loaded from `~/.openrappter/skills/` and prefixed with `skill:` in the agent registry.

---

## 10. Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  User Input (CLI / Interactive)                          │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Agent Registry (auto-discovery from agents/ directory)  │
│  Python: *_agent.py    TypeScript: *Agent.ts             │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Keyword Matching / Copilot Routing                      │
│  Selects best agent based on user intent                 │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Data Sloshing (context enrichment layer)                │
│  Temporal + Memory + Behavioral + Query signals          │
│  + upstream data_slush from previous agent               │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Agent.perform() — executes with enriched context        │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌─────────────────────┐  ┌────────────────────────────────┐
│  GitHub Copilot     │  │  ~/.openrappter/               │
│  (cloud AI backbone)│  │  config.json | memory.json     │
│  Inference layer    │  │  Local-first data storage      │
└─────────────────────┘  └────────────────────────────────┘
```

### Directory Structure

```
openrappter/
├── python/
│   ├── openrappter/
│   │   ├── cli.py              # Entry point & orchestrator
│   │   ├── clawhub.py          # ClawHub compatibility
│   │   ├── rappterhub.py       # RappterHub client
│   │   └── agents/
│   │       ├── basic_agent.py          # Base class (extend this)
│   │       ├── shell_agent.py          # Shell commands
│   │       ├── manage_memory_agent.py  # Store memories
│   │       ├── context_memory_agent.py # Recall memories
│   │       └── learn_new_agent.py      # Generate new agents
│   └── pyproject.toml
├── typescript/
│   ├── src/
│   │   ├── index.ts            # Entry point
│   │   └── agents/
│   │       ├── BasicAgent.ts   # Base class (extend this)
│   │       ├── AgentRegistry.ts # Auto-discovery
│   │       ├── ShellAgent.ts   # Shell commands
│   │       ├── MemoryAgent.ts  # Memory store/recall
│   │       └── types.ts        # Shared type definitions
│   ├── package.json
│   └── tsconfig.json
├── docs/                       # GitHub Pages site
└── skills.md                   # This file
```

---

## 11. Troubleshooting

### TypeScript Build Errors

```bash
cd typescript
rm -rf node_modules dist
npm install
npm run build
```

### Python Import Errors

```bash
cd python
pip install -e .
# If editable mode fails (old pip):
pip install .
# Or run directly:
python3 -m openrappter.cli --status
```

### Python Version Too Low

The `pyproject.toml` requires `>=3.10`. If system Python is older, use Homebrew or pyenv:

```bash
# macOS
brew install python@3.11
/opt/homebrew/bin/python3.11 -m pip install .

# Or use pyenv
pyenv install 3.11
pyenv local 3.11
```

### Copilot CLI Not Found

openrappter works without Copilot CLI using keyword matching fallback. For full AI routing:

```bash
npm install -g @githubnext/github-copilot-cli
github-copilot-cli auth
```

### Memory File Issues

```bash
# Reset memory
rm ~/.openrappter/memory.json

# Reset all config
rm -rf ~/.openrappter
```

---

## 12. Quick Reference Card

```bash
# Install
git clone https://github.com/kody-w/openrappter.git && cd openrappter
cd typescript && npm install && npm run build     # TypeScript
cd ../python && pip install .                      # Python

# Status
node dist/index.js --status                       # TypeScript
python3 -m openrappter.cli --status               # Python

# Use
node dist/index.js "remember X"                   # Store memory
node dist/index.js "recall X"                     # Recall memory
node dist/index.js "ls"                           # Shell command
openrappter --task "remember X"                   # Python memory
openrappter --exec Shell "ls"                     # Python shell
openrappter --list-agents                         # List agents

# Create agents
# Python: add *_agent.py to python/openrappter/agents/
# TypeScript: add *Agent.ts to typescript/src/agents/, rebuild

# RappterHub
openrappter rappterhub search "topic"
openrappter rappterhub install author/agent
```

---

**Agent Notes:**
- Both runtimes can be installed independently — pick the user's preferred language
- TypeScript must be rebuilt after adding new agents (`npm run build`)
- Python agents are hot-loaded automatically
- All agent data is local-first in `~/.openrappter/`
- Copilot provides cloud AI inference — no separate API keys needed
- This skill should complete in under 5 minutes
