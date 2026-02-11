<div align="center">

# openrappter

### AI agents powered by your existing GitHub Copilot subscription

**No extra API keys. No new accounts. No additional monthly bills. Your data stays local.**

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3b82f6.svg)](https://python.org)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-22c55e.svg)](https://nodejs.org)
[![RappterHub](https://img.shields.io/badge/RappterHub-Agents-a855f7.svg)](https://github.com/rappterhub/rappterhub)

[GitHub](https://github.com/kody-w/openrappter) | [Documentation](./docs) | [Skills Reference](./skills.md) | [Architecture](./docs/architecture.html) | [RappterHub](https://github.com/rappterhub/rappterhub)

---

</div>

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
| **Persistent Memory** | Remembers facts, preferences, and context across sessions |
| **Dual Runtime** | Same agent contract in Python (7 agents) and TypeScript (3 agents) |
| **Data Sloshing** | Automatic context enrichment (temporal, memory, behavioral signals) before every action |
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
| `FetchesLatest` | Fetch latest Hacker News stories |
| `RAPPverseNPC` | Autonomous NPC conversationalist for RAPPterverse game |

### TypeScript Runtime

| Agent | Description |
|-------|-------------|
| `Assistant` | Copilot SDK-powered orchestrator — routes queries to agents via tool calling |
| `Shell` | Execute bash commands, read/write files, list directories |
| `Memory` | Store and recall facts — remember, recall, list, forget |

## Creating Custom Agents

Agents are auto-discovered by file naming convention. No registration needed.

### Python — `python/openrappter/agents/my_agent.py`

```python
from openrappter.agents.basic_agent import BasicAgent
import json

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
        # self.context has enriched signals from data sloshing
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
    // this.context has enriched signals from data sloshing
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

```python
# Access in perform()
time = self.get_signal('temporal.time_of_day')
confidence = self.get_signal('orientation.confidence')
```

## Architecture

```
User Input → Agent Registry → Copilot SDK Routing (tool calling)
                                        ↓
                               Data Sloshing (context enrichment)
                                        ↓
                               Agent.perform() executes
                                   ↓           ↓
                            GitHub Copilot   ~/.openrappter/
                            (cloud AI)       (local data)
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
