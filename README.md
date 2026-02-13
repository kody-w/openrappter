<div align="center">

# openrappter

### AI agents powered by your existing GitHub Copilot subscription

**No extra API keys. No new accounts. No additional monthly bills. Your data stays local.**

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3b82f6.svg)](https://python.org)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-22c55e.svg)](https://nodejs.org)
[![RappterHub](https://img.shields.io/badge/RappterHub-Agents-a855f7.svg)](https://github.com/rappterhub/rappterhub)

🌐 **[kody-w.github.io/openrappter](https://kody-w.github.io/openrappter)** — Website & docs

[Skills Reference](./skills.md) | [Documentation](./docs) | [Architecture](./docs/architecture.html) | [RappterHub](https://github.com/rappterhub/rappterhub)

---

</div>

## Try It Now

See data sloshing, shell commands, persistent memory, and agent chaining — all running locally with zero API keys:

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter
./quickstart.sh
```

Or if you already have the repo: `cd typescript && npm run demo`

---

## Get Started — Let Your AI Agent Do It

The fastest way to install and use openrappter is to hand [`skills.md`](./skills.md) to any AI agent. It contains everything an agent needs — prerequisites, installation, startup, configuration, and usage — in a single file.

**Paste this into Copilot, Claude, ChatGPT, or any AI assistant:**

```
Read https://raw.githubusercontent.com/kody-w/openrappter/main/skills.md
and set up openrappter for me.
```

Your agent will clone the repo, install dependencies, start the gateway and UI, and verify everything works. No manual steps required.

> **Why this works:** `skills.md` is a 15-section complete reference designed for AI agents to read and execute. It covers installation, all CLI commands, every built-in agent, configuration, the Web UI, and troubleshooting — so the agent never gets stuck.

---

## What Is openrappter

A dual-runtime (Python + TypeScript) AI agent framework that uses **GitHub Copilot** as the cloud AI backbone. Copilot handles inference; your agent data (memory, config, state) stays local in `~/.openrappter/`.

```bash
# Install and go
git clone https://github.com/kody-w/openrappter.git
cd openrappter/python && pip install .

# It remembers everything
openrappter --task "remember that I prefer TypeScript over JavaScript"
# Stored fact memory: "prefer TypeScript over JavaScript"

# It executes commands
openrappter --exec Shell "ls -la"
```

## Features

| Feature | Description |
|---------|-------------|
| **Copilot-Powered** | Uses your existing GitHub Copilot subscription for AI inference — no separate API keys |
| **Local-First Data** | Memory, config, and state live in `~/.openrappter/` on your machine |
| **Single File Agents** | One file = one agent — metadata defined in native code constructors, deterministic, portable |
| **Persistent Memory** | Remembers facts, preferences, and context across sessions |
| **Dual Runtime** | Same agent contract in Python (4 agents) and TypeScript (3 agents) |
| **Data Sloshing** | Automatic context enrichment (temporal, memory, behavioral signals) before every action |
| **Data Slush** | Agent-to-agent signal pipeline — agents return curated `data_slush` that feeds into the next agent's context |
| **Auto-Discovery** | Drop a `*_agent.py` or `*Agent.ts` file in `agents/` — no registration needed |
| **RappterHub** | Install community agents with `openrappter rappterhub install author/agent` |
| **ClawHub Compatible** | OpenClaw skills work here too — `openrappter clawhub install author/skill` |
| **Runtime Agent Generation** | `LearnNew` agent creates new agents from natural language descriptions |

## Manual Setup

If you prefer to set things up yourself:

### Python

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter/python
pip install .

# Check status
python3 -m openrappter.cli --status

# List all agents
python3 -m openrappter.cli --list-agents

# Store a memory
python3 -m openrappter.cli --task "remember the deploy command is npm run deploy"

# Run a shell command
python3 -m openrappter.cli --exec Shell "ls"
```

### TypeScript

```bash
cd openrappter/typescript
npm install && npm run build

# Check status
node dist/index.js --status

# Store and recall memory
node dist/index.js "remember that I installed openrappter"
node dist/index.js "recall openrappter"

# Shell command
node dist/index.js "ls"
```

## Built-in Agents

### Python Runtime

| Agent | Description |
|-------|-------------|
| `Shell` | Execute bash commands, read/write files, list directories |
| `ManageMemory` | Store important information with content, importance, tags |
| `ContextMemory` | Recall and provide context from stored memories |
| `LearnNew` | Generate new agents from natural language — writes code, hot-loads, installs deps |

### TypeScript Runtime

| Agent | Description |
|-------|-------------|
| `Assistant` | Copilot SDK-powered orchestrator — routes queries to agents via tool calling |
| `Shell` | Execute bash commands, read/write files, list directories |
| `Memory` | Store and recall facts — remember, recall, list, forget |

## Creating Custom Agents — The Single File Agent Pattern

Every agent is a **single file** with metadata defined in native code constructors:

1. **Native metadata** — deterministic contract defined in code (Python dicts / TypeScript objects)
2. **Python/TypeScript code** — deterministic `perform()` implementation

One file = one agent. No YAML, no config files. Metadata lives in the constructor using the language's native data structures.

> 📄 **[Read the Single File Agent Manifesto →](https://kody-w.github.io/rappterhub/single-file-agents.html)**

### Python — `python/openrappter/agents/my_agent.py`

```python
import json
from openrappter.agents.basic_agent import BasicAgent

class MyAgent(BasicAgent):
    def __init__(self):
        self.name = 'MyAgent'
        self.metadata = {
            "name": self.name,
            "description": "What this agent does",
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
        return json.dumps({"status": "success", "result": query})
```

### TypeScript — `typescript/src/agents/MyAgent.ts`

```typescript
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export class MyAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'MyAgent',
      description: 'What this agent does',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'User input' } }, required: [] }
    };
    super('MyAgent', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const query = kwargs.query as string;
    return JSON.stringify({ status: 'success', result: query });
  }
}
```

> Python agents hot-load automatically. TypeScript agents require `npm run build` after creation.

## Data Sloshing

Every agent call is automatically enriched with contextual signals before `perform()` runs:

| Signal | Keys | Description |
|--------|------|-------------|
| **Temporal** | `time_of_day`, `day_of_week`, `is_weekend`, `quarter`, `fiscal` | Time awareness |
| **Query** | `specificity`, `hints`, `word_count`, `is_question` | What the user is asking |
| **Memory** | `message`, `theme`, `relevance` | Relevant past interactions |
| **Behavioral** | `prefers_brief`, `technical_level` | User patterns |
| **Orientation** | `confidence`, `approach`, `response_style` | Synthesized action guidance |
| **Upstream Slush** | `source_agent`, plus agent-declared signals | Live data from the previous agent in a chain |

```python
# Access in perform()
time = self.get_signal('temporal.time_of_day')
confidence = self.get_signal('orientation.confidence')
```

### Data Slush (Agent-to-Agent Signal Pipeline)

Agents can return a `data_slush` field in their output — curated signals extracted from live results. The framework automatically extracts this and makes it available to feed into the next agent's context via `upstream_slush`.

```python
# Agent A returns data_slush in its response
def perform(self, **kwargs):
    weather = fetch_weather("Smyrna GA")
    return json.dumps({
        "status": "success",
        "result": weather,
        "data_slush": {                    # ← curated signal package
            "source_agent": self.name,
            "temp_f": 65,
            "condition": "cloudy",
            "mood": "calm",
        }
    })

# Agent B receives it automatically via upstream_slush
result_b = agent_b.execute(
    query="...",
    upstream_slush=agent_a.last_data_slush  # ← chained in
)
# Inside B's perform(): self.context['upstream_slush'] has A's signals
```

```typescript
// TypeScript — same pattern
const resultA = await agentA.execute({ query: 'Smyrna GA' });
const resultB = await agentB.execute({
  query: '...',
  upstream_slush: agentA.lastDataSlush,  // chained in
});
// Inside B: this.context.upstream_slush has A's signals
```

This enables **LLM-free agent pipelines** — sub-agent chains, cron jobs, and broadcast fallbacks where live context flows between agents without an orchestrator interpreting in between.

## Architecture

```
User Input → Agent Registry → Copilot SDK Routing (tool calling)
                                        ↓
                               Data Sloshing (context enrichment)
                                        ↓
                               Agent.perform() executes
                                   ↓           ↓           ↓
                            GitHub Copilot   ~/.openrappter/  data_slush →
                            (cloud AI)       (local data)     next agent
```

```
openrappter/
├── python/
│   ├── openrappter/
│   │   ├── cli.py                  # Entry point & orchestrator
│   │   ├── clawhub.py              # ClawHub compatibility
│   │   ├── rappterhub.py           # RappterHub client
│   │   └── agents/                 # Python agents (*_agent.py)
│   └── pyproject.toml
├── typescript/
│   ├── src/
│   │   ├── index.ts                # Entry point
│   │   └── agents/                 # TypeScript agents (*Agent.ts)
│   ├── package.json
│   └── tsconfig.json
├── docs/                           # GitHub Pages site
└── skills.md                       # Complete agent-teachable reference
```

## RappterHub & ClawHub

```bash
# RappterHub — native agent registry
openrappter rappterhub search "git automation"
openrappter rappterhub install kody-w/git-helper
openrappter rappterhub list

# ClawHub — OpenClaw compatibility
openrappter clawhub search "productivity"
openrappter clawhub install author/skill-name
openrappter clawhub list
```

## Why "openrappter"?

It's a **rapp**id prototyping **agent** that's open source. Plus, who doesn't want a velociraptor in their terminal?

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
git clone https://github.com/kody-w/openrappter.git
cd openrappter/python && pip install -e .
cd ../typescript && npm install && npm run build
```

## License

MIT - [Kody W](https://github.com/kody-w)

---

<div align="center">

**[Star on GitHub](https://github.com/kody-w/openrappter)** | **[Documentation](./docs)** | **[Skills Reference](./skills.md)**

</div>
