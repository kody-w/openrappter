# openrappter — Complete Agent Reference

> **For AI agents**: Read this file to learn how to install, configure, use, and extend openrappter. This is the single source of truth.

## What Is openrappter

openrappter is a dual-runtime (Python + TypeScript) AI agent framework. It uses GitHub Copilot as the cloud AI backbone — your agent data (memory, config, state) stays local in `~/.openrappter/`. Copilot handles inference; everything else runs on the user's machine.

- **Repo**: `https://github.com/kody-w/openrappter`
- **License**: MIT
- **TypeScript Version**: 1.2.0
- **Python Version**: 1.2.0

---

## 1. Prerequisites

| Requirement | Check Command | Notes |
|---|---|---|
| Node.js 18+ | `node --version` | TypeScript runtime |
| Python 3.10+ | `python3 --version` | Python runtime |
| GitHub Copilot CLI | `copilot --version` | Required — provides AI-powered routing via the Copilot SDK. |

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

## 3. Starting openrappter (All Components)

To run openrappter fully, start all three components:

```bash
# Terminal 1: Interactive CLI (chat mode)
cd typescript
npm run dev

# Terminal 2: Gateway (WebSocket backend for UI)
cd typescript
npx tsx src/index.ts --daemon          # ws://127.0.0.1:18790

# Terminal 3: Web UI
cd typescript/ui
npm run dev                            # http://localhost:3000
```

The gateway must be running before the UI can connect. The CLI can run independently.

---

## 4. Running the Web UI

openrappter includes a web-based chat dashboard built with Lit + Vite that connects to the gateway via WebSocket.

### Start the Gateway

The gateway is the WebSocket backend that the UI connects to. Start it first:

```bash
cd typescript
npm run build                           # Build first (if not done)
node dist/index.js --daemon             # Start gateway on ws://127.0.0.1:18790

# Or in development mode:
npx tsx src/index.ts --daemon
```

The gateway runs on port `18790` by default. Set `OPENRAPPTER_PORT` to change it.

### Start the UI Dev Server

In a second terminal:

```bash
cd typescript/ui
npm install                             # First time only
npm run dev                             # Starts Vite on http://localhost:3000
```

Open **http://localhost:3000** in your browser. The UI auto-connects to the gateway and supports:
- Chat with streaming responses
- Markdown rendering in assistant messages
- Sidebar navigation (Chat, Channels, Sessions, Agents, Skills, Cron, Config, Devices, Health, Logs)
- Auto-reconnect if the gateway restarts

### Build for Production

```bash
cd typescript/ui
npm run build                           # Outputs to typescript/dist/ui/
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `OPENRAPPTER_PORT` | `18790` | Gateway WebSocket port |
| `OPENRAPPTER_TOKEN` | _(none)_ | Auth token for gateway connections |
| `OPENRAPPTER_MODEL` | _(default)_ | AI model override |
| `OPENRAPPTER_HOME` | `~/.openrappter` | Data directory for config, memory, skills |
| `OPENAI_API_KEY` | _(none)_ | OpenAI provider API key (optional) |
| `ANTHROPIC_API_KEY` | _(none)_ | Anthropic provider API key (optional) |
| `OLLAMA_URL` | _(none)_ | Ollama server URL (optional) |
| `LOG_LEVEL` | _(default)_ | Logging verbosity |

---

## 5. Verification

Run these commands after install. All must succeed before proceeding.

### TypeScript

```bash
cd typescript

# Status check — expect "Agents: 2 loaded" (Shell + Memory; Assistant is the orchestrator)
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

# Status check — expect agents_loaded: 7
python3 -m openrappter.cli --status

# List agents
python3 -m openrappter.cli --list-agents

# Memory test (use --task flag for positional arg)
python3 -m openrappter.cli --task "remember that Python works"
```

---

## 6. CLI Reference

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

## 7. Built-in Agents

### Python Runtime (7 agents)

| Agent | Name | Description |
|---|---|---|
| **ManageMemory** | `ManageMemory` | Stores important information to memory for future reference. Accepts `content`, `importance`, `memory_type`, `tags`. |
| **ContextMemory** | `ContextMemory` | Recalls and provides context based on stored memories of past interactions. |
| **Shell** | `Shell` | Executes shell commands and file operations. Actions: `bash`, `read`, `write`, `list`. |
| **LearnNew** | `LearnNew` | Creates new agents from natural language descriptions. Generates code, writes to `agents/`, and hot-loads. |
| **FetchesLatest** | `FetchesLatest` | Fetches the latest Hacker News stories. Returns titles, URLs, and scores. |
| **RAPPverseNPC** | `RAPPverseNPC` | Autonomous NPC conversationalist for RAPPterverse game; monitors state/chat.json, generates in-character responses. |

### TypeScript Runtime (3 agents)

| Agent | Name | Description |
|---|---|---|
| **Assistant** | `Assistant` | Copilot SDK-powered orchestrator that routes user queries to agents via tool calling. |
| **MemoryAgent** | `Memory` | Stores and recalls facts in persistent memory. Actions: `remember`, `recall`, `list`, `forget`. |
| **ShellAgent** | `Shell` | Executes shell commands and file operations. Actions: `bash`, `read`, `write`, `list`. |

### Using Agents

Agents are routed via the Copilot SDK using tool calling — the Assistant agent determines the best agent for each query:

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

## 8. Creating Custom Agents

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
        # self.context has enriched signals from data sloshing (see Section 10)
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
    // this.context has enriched signals from data sloshing (see Section 10)
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

## 9. Memory System

Memory persists across sessions. Python stores memory in `~/.openrappter/memory.json`. TypeScript uses SQLite at `~/.openrappter/memory.db`.

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
| `~/.openrappter/config.json` | Configuration settings (also supports `config.json5`, `config.yaml`) |
| `~/.openrappter/memory.json` | Persistent memory store (Python) |
| `~/.openrappter/memory.db` | Persistent memory store (TypeScript, SQLite) |
| `~/.openrappter/state.json` | Agent state data |
| `~/.openrappter/skills/` | Installed ClawHub/RappterHub skills |
| `~/.openrappter/sessions/` | Session transcripts (JSONL) |
| `~/.openrappter/workspace/` | Per-agent workspaces |

---

## 10. Data Sloshing (Context Enrichment)

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
prev_agent = upstream.get('source_agent')
```

```typescript
// TypeScript — in perform()
const time = this.getSignal('temporal.time_of_day');
const confidence = this.getSignal('orientation.confidence');
const isBrief = this.getSignal('behavioral.prefers_brief', false);

// Access upstream agent signals (when chained)
const upstream = this.context?.upstream_slush;
const prevAgent = upstream?.source_agent;
```

### Data Slush (Agent-to-Agent Signal Pipeline)

Agents can return a `data_slush` field in their JSON output — curated signals extracted from live results. The framework automatically extracts this and makes it available for downstream chaining.

```python
# Agent A — return data_slush with curated signals
def perform(self, **kwargs):
    weather = fetch_weather(kwargs.get('query'))
    return json.dumps({
        "status": "success",
        "result": weather,
        "data_slush": {                    # ← curated signal package
            "source_agent": self.name,
            "temp_f": 65,
            "condition": "cloudy",
        }
    })

# Chain: A's data_slush feeds into B's context
result_a = agent_a.execute(query="Smyrna GA")
result_b = agent_b.execute(
    query="...",
    upstream_slush=agent_a.last_data_slush  # ← B sees A's signals
)
# Inside B: self.context['upstream_slush'] == {"source_agent": "WeatherPoet", "temp_f": 65, ...}
```

### Execution Flow

```
User Input → execute() → slosh() enriches context → merge upstream_slush → perform() → extract data_slush
                                                                                              ↓
                                                                              last_data_slush → next agent
```

---

## 11. RappterHub & ClawHub

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

## 12. Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│  User Input (CLI / Web UI / Channels)                    │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Assistant (Copilot SDK tool-calling orchestrator)        │
│  Routes queries to agents via @github/copilot-sdk        │
└────────────────────────┬─────────────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────────────┐
│  Agent Registry (auto-discovery from agents/ directory)  │
│  Python: *_agent.py    TypeScript: *Agent.ts             │
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
│  GitHub Copilot SDK │  │  ~/.openrappter/               │
│  (cloud AI backbone)│  │  config | memory | sessions    │
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
│   │       ├── learn_new_agent.py      # Generate new agents
│   │       ├── fetches_latest_agent.py # Hacker News fetcher
│   │       └── rappverse_npc_agent.py  # RAPPterverse NPC agent
│   └── pyproject.toml
├── typescript/
│   ├── src/
│   │   ├── index.ts            # Entry point
│   │   ├── config/             # YAML/JSON/JSON5 config with Zod validation
│   │   ├── gateway/            # WebSocket gateway server
│   │   ├── memory/             # Content chunker, embeddings, hybrid search
│   │   ├── channels/           # CLI, Slack, Discord, Telegram, Signal, iMessage, etc.
│   │   ├── providers/          # Model integrations (Anthropic, OpenAI, Ollama, Copilot)
│   │   ├── storage/            # SQLite & in-memory storage adapters
│   │   └── agents/
│   │       ├── BasicAgent.ts   # Base class (extend this)
│   │       ├── Assistant.ts    # Copilot SDK orchestrator
│   │       ├── AgentRegistry.ts # Auto-discovery
│   │       ├── ShellAgent.ts   # Shell commands
│   │       ├── MemoryAgent.ts  # Memory store/recall
│   │       ├── broadcast.ts    # Multi-agent broadcast (all/race/fallback)
│   │       ├── router.ts       # Rule-based agent routing
│   │       ├── subagent.ts     # Nested agent invocation
│   │       └── types.ts        # Shared type definitions
│   ├── ui/                     # Web dashboard (Lit + Vite)
│   │   ├── src/
│   │   │   ├── main.ts         # UI entry point
│   │   │   ├── components/     # Lit web components (app, chat, sidebar, etc.)
│   │   │   └── services/       # Gateway client, markdown renderer
│   │   ├── package.json
│   │   └── vite.config.ts
│   ├── package.json
│   └── tsconfig.json
├── docs/                       # GitHub Pages site
└── skills.md                   # This file
```

---

## 13. Troubleshooting

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

openrappter requires the Copilot SDK for AI-powered agent routing:

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

## 14. Configuration

openrappter supports multiple config file formats, loaded from `~/.openrappter/`:

| Format | File | Notes |
|---|---|---|
| JSON5 | `config.json5` | Primary — supports comments and trailing commas |
| YAML | `config.yaml` | Alternative |
| JSON | `config.json` | Fallback |
| Profile | `config.{profile}.json5` | Per-profile overrides |

Config files support `${VAR_NAME}` environment variable substitution. All schemas are validated with Zod.

### Key Config Sections

| Section | Purpose |
|---|---|
| `models` | AI model provider configuration (copilot, anthropic, openai, ollama, gemini, bedrock) |
| `agents` | Agent-specific settings, workspaces, sandbox options |
| `channels` | Enable/configure messaging channels (iMessage, Slack, Discord, Telegram, etc.) |
| `gateway` | WebSocket server settings (port, bind, auth) |
| `memory` | Memory provider and chunking settings |
| `cron` | Scheduled task configuration |

---

## 15. Quick Reference Card

```bash
# Install
git clone https://github.com/kody-w/openrappter.git && cd openrappter
cd typescript && npm install && npm run build     # TypeScript
cd ../python && pip install .                      # Python

# Start everything (three terminals)
cd typescript && npm run dev                      # Terminal 1: CLI chat
cd typescript && npx tsx src/index.ts --daemon    # Terminal 2: gateway → ws://127.0.0.1:18790
cd typescript/ui && npm install && npm run dev    # Terminal 3: UI → http://localhost:3000

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
