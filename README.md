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

## Install in One Line

```bash
# Works everywhere. Installs everything. You're welcome. 🦖
curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash
```

Works on macOS, Linux & WSL. Installs Node.js (if needed), clones the repo, builds both runtimes, and creates the `openrappter` command. Done.

Or try the quickstart demo: `git clone https://github.com/kody-w/openrappter.git && cd openrappter && ./quickstart.sh`

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
curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash

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
| **Background Daemon** | Runs persistently via launchd — cron jobs, Telegram bot, and gateway always alive |
| **Cron Scheduling** | Built-in cron with agent executor — schedule any agent to run on any schedule |
| **Dream Mode** | Memory consolidation agent — deduplicates, prunes stale facts, logs what it cleaned |
| **Soul Templates** | 10 prebuilt personas (coder, researcher, ops, narrator, oracle, etc.) — summon with one call |
| **Self-Updating** | Checks GitHub for new releases, updates with one command |
| **30-Day Onboarding** | Daily tip notifications that teach one feature per day with a command to try |
| **Dino Tamagotchi** | Animated 🦖 menu bar icon that looks around, reacts to pokes, and reflects system state |

## macOS Menu Bar Companion

A native Swift menu bar app with an animated 🦖 tamagotchi icon.

**Two ways to get started — same result:**

| Path | For | How |
|------|-----|-----|
| **Menu bar app** | Non-technical users | Install DMG → click 🦖 → visual wizard |
| **Terminal** | Developers | `curl install` → `openrappter onboard` |

### The Dino Tamagotchi 🦖

Your menu bar gets a pet dinosaur that:
- **Looks around** randomly (👀🦖 or 🦖👀) every ~8 seconds
- **Reacts to pokes** — click it and it shows happiness (🦖✨ → 🦖💚)
- **Gets excited** after 5+ pokes (🦖🎉 → 🦖⚡ → 🦖🔥)
- **Sleeps** when disconnected (🦖💤)
- **Thinks** when processing requests (🦖💭)

### Visual Onboarding

First-time users see a step-by-step setup wizard right in the menu bar panel — no terminal required:

1. **Welcome** — meet your dino
2. **GitHub auth** — device code flow (opens browser)
3. **Telegram** — optional bot connection
4. **Auto-start** — daemon launches, launchd installs, cron jobs activate
5. **Done** — transitions to chat, first tip notification fires

### Install via Homebrew

```bash
brew tap kody-w/tap
brew install --cask openrappter-bar
```

### Install via DMG

1. Download the latest DMG from [Releases](https://github.com/kody-w/openrappter/releases?q=bar)
2. Open the DMG and drag **OpenRappter Bar** to Applications
3. **First launch:** Right-click the app → Open, then click "Open" in the Gatekeeper dialog
4. The app appears in your menu bar and auto-connects to `localhost:18790`

> **Note:** The app is currently unsigned. macOS will block it on first launch — the right-click → Open step bypasses this once.

### Release a new version

```bash
git tag v1.0.1-bar && git push origin v1.0.1-bar
```

This triggers the CI workflow to build a universal binary (Apple Silicon + Intel), package a DMG, and create a GitHub Release.

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
| `Dream` | Memory consolidation — deduplicates entries, prunes stale facts, logs what it cleaned |
| `MorningBrief` | Daily briefing pipeline — chains Web (weather), calendar, Memory (priorities), TTS |
| `DailyTip` | 30-day onboarding drip — sends native notification with one feature tip per day |
| `Update` | Self-update — checks GitHub for new releases, pulls and rebuilds |
| `Browser` | Headless browser automation for web scraping, testing, and interaction |
| `CodeReview` | Deterministic heuristic code review — checks for bugs, security, and style |
| `Cron` | Manage scheduled jobs — add, remove, enable/disable recurring agent tasks |
| `Git` | Git repository operations — status, diff, log, branch management |
| `HackerNews` | Fetch top Hacker News stories |
| `Image` | Analyze and process images from URLs |
| `LearnNew` | Generate new agents from natural language descriptions at runtime |
| `Message` | Multi-channel messaging — Telegram, Slack, Discord, and more |
| `Ouroboros` | Self-evolving agent — reads its own source, generates improved versions across 5 generations |
| `Pipeline` | Declarative multi-agent pipeline runner with data_slush threading |
| `SelfHealingCron` | Autonomous health check agent with auto-restart and alerting |
| `Sessions` | Chat session management — list, retrieve, switch conversations |
| `TTS` | Text-to-speech synthesis with multiple voice options |
| `Watchmaker` | Agent ecosystem manager — evaluates quality, A/B tests, promotes winners |
| `Web` | Fetch web pages and search the web with SSRF protection |

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

## Soul Templates

Prebuilt rappter personas you can summon with one call. Each template defines which agents are included, a system prompt personality, and an emoji.

| Template | Emoji | Category | Personality |
|----------|-------|----------|-------------|
| `assistant` | 🦖 | general | Default — full agent access |
| `coder` | 💻 | development | Senior engineer — writes code, ships PRs |
| `reviewer` | 🔍 | development | Code review specialist — finds bugs |
| `researcher` | 🔬 | research | Searches, reads, synthesizes findings |
| `analyst` | 📊 | research | Turns raw data into insights |
| `ops` | 🛠 | operations | Monitors, heals, deploys, alerts |
| `scheduler` | ⏱ | operations | Automates everything that repeats |
| `narrator` | 🎙 | creative | Voice-first — speaks all responses via TTS |
| `oracle` | 🔮 | creative | Meta-AI that evolves and improves agents |
| `companion` | 💬 | creative | Warm conversational AI that remembers everything |

```bash
# Via gateway RPC
{ "method": "rappter.load-template", "params": { "templateId": "coder" } }
{ "method": "rappter.templates", "params": { "category": "research" } }
```

## Background Daemon & Cron

openrappter runs as a persistent background daemon via macOS launchd (or systemd on Linux). The daemon keeps the gateway alive, runs cron jobs, and maintains Telegram/channel connections.

```bash
# Start manually
openrappter --daemon

# Auto-starts on login after onboard (via launchd)
# Cron jobs in ~/.openrappter/cron.json fire automatically
```

### Built-in Cron Jobs

After onboarding, these are pre-configured:

| Job | Schedule | Agent | What it does |
|-----|----------|-------|-------------|
| `daily-tip` | 9am daily | DailyTip | Sends a native notification teaching one feature |
| `dream-mode` | 3am daily | Dream | Consolidates memory — dedup, prune stale |
| `morning-brief` | 8am daily | MorningBrief | Weather + calendar + priorities spoken via TTS |

## Self-Updating

openrappter can check for and install updates from the public repo.

```bash
# Check for updates
openrappter --exec Update "check"

# Install update (git pull + rebuild)
openrappter --exec Update "update"

# View changelog
openrappter --exec Update "changelog"
```

## 30-Day Onboarding Tips

After setup, you receive one native notification per day at 9am teaching a new feature:

- **Week 1:** Basics — chat, memory, shell, status, agents, web search
- **Week 2:** Power features — code review, cron, TTS, dream mode, Hacker News, dashboard
- **Week 3:** Customization — LearnNew, soul templates, pipelines, self-healing, marketplace
- **Week 4:** Advanced — Watchmaker evolution, data sloshing, channels, browser, skills

Each notification is **clickable** — opens the OpenRappter Bar app (or web dashboard) so you can try the feature immediately.

```bash
# Preview all tips
openrappter --exec DailyTip "preview"

# Send a specific day's tip
openrappter --exec DailyTip "15"
```

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
