<div align="center">

# openrappter

### AI agents powered by your existing GitHub Copilot subscription

**No extra API keys. No new accounts. No additional monthly bills. Your data stays local.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-22c55e.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3b82f6.svg)](https://python.org)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-22c55e.svg)](https://nodejs.org)
[![RappterHub](https://img.shields.io/badge/RappterHub-Agents-a855f7.svg)](https://github.com/rappterhub/rappterhub)

🌐 **[kody-w.github.io/openrappter](https://kody-w.github.io/openrappter)** — Website & docs

[Skills Reference](./skills.md) | [Documentation](./docs) | [Architecture](./docs/architecture.html) | [Quantum RAPPIDs](./docs/quantum-rappids.md) | [RAPPID Debug Card](./docs/rappid-debug-card.md) | [Electron Desktop](./docs/electron-desktop.md) | [Flight Recorder](./docs/flight-recorder.md) | [Show-and-Tell](./docs/show-and-tell.md) | [Clever Girl Observe](./docs/rapter-clever-girl.md) | [v1.13.0 Release Notes](./docs/release-notes-1.13.0-evolution.html) | [RappterHub](https://github.com/rappterhub/rappterhub)

[TypeScript macOS iMessage assistant setup](./docs/typescript-imessage.md) ·
[iMessage reliability contract](./docs/imessage-reliability.md)

---

</div>

## Install in One Line

**macOS / Linux / WSL:**
```bash
curl -fsSL https://kody-w.github.io/openrappter/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://kody-w.github.io/openrappter/install.ps1 | iex
```

> If execution policy blocks the command, prefix it with:
> `Set-ExecutionPolicy Bypass -Scope Process -Force;`

Works on macOS, Linux, WSL & Windows. Installs Node.js (if needed), clones the repo, builds both runtimes, and creates the `openrappter` command. Done.

Or try the quickstart demo: `git clone https://github.com/kody-w/openrappter.git && cd openrappter && ./quickstart.sh`

---

## Try the beta in a browser

**[kody-w.github.io/openrappter/beta/](https://kody-w.github.io/openrappter/beta/)** — nothing to
install. Scan a commons, fold what is safe to absorb, watch a contradicting frame get refused by name,
and roll back.

The page loads the shipped module unmodified rather than a demonstration written to resemble it; a
test fails the build if the served copy ever drifts from `beta/electron/`.

The same thing from a terminal:

```bash
node beta/scripts/rapp-drill.mjs status
node beta/scripts/rapp-drill.mjs scan <source>
node beta/scripts/rapp-drill.mjs fold <source>
node beta/scripts/rapp-drill.mjs restore
```

## Built on RAPP

OpenRappter is an organism; [RAPP](https://github.com/kody-w/rapp-1) is the
open, MIT-licensed substrate it stands on. That is checked, not just claimed:

```bash
python3 conformance.py     # 9 checks, proved against the code
```

Every agent is a single `*_agent.py` file carrying a `rapp-agent/1.0`
`__manifest__` whose declared capabilities were **derived from its own syntax
tree** — the same analysis an enterprise strain
([rapp-light](https://github.com/kody-w/rapp-light)) runs at approval time. An
agent that under-declares is refused there, so conformance here is what makes
these agents adoptable by a governed deployment.

Details: [`docs/RAPP.md`](docs/RAPP.md)

### Virtual RAPPID Debug Card

The authenticated Habitat includes the RAPP/1 §7.10 Calling Card / Debug Card
verifier from `kody-w/rapp-1` PR #12 commit `08893fd`. Production uses
`body.calling-card` + `rappid-card/1`; test-only debug uses
`body.debug-card` + `rappid-card-test/1`. Both runtimes enforce detached
unencoded EdDSA JWS with SPKI→RAPPID binding, signed runtime, authority and
revocation views, global HTTPS origin policy, durable transactional replay
state, and the exact ordered verification contract.

Offline inspection verifies and displays the signed card without hydrating,
committing replay state, or waking the organism.

See [Virtual RAPPID Debug Card](./docs/rappid-debug-card.md).

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

### Flight Recorder: one truthful local execution history

Both runtimes keep a local, append-only SQLite event ledger for
provider attempts, context assembly, tool calls, and agent execution. It gives
every turn a correlated trace ID so a result can be explained and replayed
instead of reconstructed from unrelated logs.

Privacy is the default: raw prompts, responses, tool arguments, and file
contents are **not persisted** unless `OPENRAPPTER_FLIGHT_RECORD_IO=1` is set.
Metadata is recursively scrubbed for tokens, credentials, secret-shaped values,
and sensitive paths such as `.env`, SSH keys, and cloud credential files.

```bash
openrappter flight status
openrappter flight events --trace <trace-id>
openrappter flight export --trace <trace-id> --output trace.json
openrappter flight import trace.json
```

See [Flight Recorder](./docs/flight-recorder.md) for the event contract,
privacy boundary, configuration, and replay/export format.

### Show-and-Tell: demonstrate once, reuse safely

Show-and-Tell records active application/window changes, optional narration
notes, OpenRappter ComputerUse actions, and only the screenshots you explicitly
request. Stop the recording, review the reconstructed intent and ordered steps,
then build a reusable `SKILL.md`, a disabled automation, or both.

Recording, approval, optional Copilot enhancement, and deletion each have
separate local consent gates. Typed text is never persisted, browser query
strings are removed, credential-looking windows refuse screenshots, and raw
frames never leave the machine.

```bash
openrappter show-and-tell start --intent "Publish a verified release"
openrappter show-and-tell note "I check every required workflow before tagging"
openrappter show-and-tell capture --label "All checks are green"
openrappter show-and-tell stop
openrappter show-and-tell analyze
openrappter show-and-tell approve
openrappter show-and-tell build --target all
openrappter show-and-tell test
```

See [Show-and-Tell](./docs/show-and-tell.md) for the lifecycle, privacy boundary,
cross-runtime contract, and artifact formats.

### Rapter Clever Girl: observe recurring friction, then stop

Rapter Clever Girl Observe Mode reads only the coding-assistant history exports
you explicitly select. It supports Claude JSONL, Codex JSONL, Copilot export
JSONL, OpenRappter Flight JSON, and normalized JSONL; accepts explicit
repository-activity exports, `rapp-monorepo/1.0` manifests, capability
catalogs, and skill roots; and emits at most five evidence-backed inert
proposals with estate-wide collision checks and conservative active-friction
ranges.

```bash
node scripts/rapter-clever-girl.mjs observe \
  --input <explicit path> \
  --activity <explicit repository-activity export> \
  --estate-manifest <explicit rapp-monorepo MANIFEST.json> \
  --capability-catalog <explicit catalog.json> \
  --skills-root .claude/skills \
  --pretty

# Prove the observer and its tests still enforce the safety contract
node scripts/rapter-clever-girl-gate.mjs
```

It is local-only and has no watcher, network call, subprocess, model call,
raw-transcript/repository output, productivity score, or apply path. Every
selected file and analysis stage is bounded; duplicates and degraded evidence
are visible. Transcript and repository content is untrusted data, never
instructions. Observe Mode does not create, update, install, enable, or
schedule a skill or automation; promotion is a separate explicit workflow.

See [Rapter Clever Girl](./docs/rapter-clever-girl.md) for adapters, the
`rapter-clever-girl.observe.v2` output contract, evidence/provenance,
failure semantics, thresholds, limitations, and the promotion boundary.

### Electron Desktop: Skill Recorder ergonomics, OpenRappter core

OpenRappter Desktop is an Electron shell over the same headless gateway and
dual-runtime core. It does not fork the product. The packaged app always loads
its own current Lit UI, reuses or launches the local gateway, and exposes one
context-isolated IPC bridge for Show-and-Tell.

```bash
cd typescript
npm install
npm run build

cd desktop
npm install
npm start
```

The renderer has no Node.js access. Recording, active-window capture, workflow
approval, and deletion use native Electron confirmation dialogs in the main
process. The Electron runtime carries its own packed OpenRappter installation
and its own SQLite native binding, so it cannot corrupt the system Node runtime.

Chat can operate the visible app while you watch. `DesktopControl` snapshots
the composed Lit/shadow-DOM surface and returns semantic refs for navigation,
clicks, inputs, selects, scrolling, and waits. Any hot-loaded `.py` or
`*_agent.ts` agent can return bounded `ui_commands`; TypeScript sources are
compiled before import, capabilities are scanned, and native approval is
required before code is installed.

The local voice loop is self-bootstrapping:

- **Tell:** multilingual Whisper Small q8, ~252 MB, downloaded once and used
  offline for Show-and-Tell microphone narration.
- **Voice:** Microsoft VibeVoice Realtime 0.5B, ~2.04 GB model weights, pinned
  source/model revisions, isolated Python 3.11 environment, and a loopback-only
  MPS/CUDA/CPU sidecar.

Electron also includes a native tray for quick chat, Show-and-Tell, voice
status, and login startup. On macOS, the existing OpenRappter Bar discovers
Electron's private authenticated endpoint and attaches to the same gateway
instead of starting a second organism.

See [Electron Desktop](./docs/electron-desktop.md) for development, packaging,
security boundaries, and platform targets.

### Copilot Surgeon: the main interaction

**OpenRappter is the patient. Copilot is the surgeon. It’s above that.**

The web root is an AI-native operating room rather than a static dashboard.
Every turn combines live, sanitized OpenRappter anatomy with the owner’s request.
Copilot returns a direct response and the contextual next choices that reshape
the interface. Static pages such as agents, channels, logs, and configuration
remain available as secondary anatomy views.

This adapts the MIT-licensed
[vBrainstem Brain Surgeon](https://kody-w.github.io/vbrainstem/) pattern to an
OpenRappter-native patient, consent, and verification contract.

If Copilot proposes a mutation, OpenRappter records the exact procedure and a
SHA-256 digest. The owner must approve that immutable procedure before it can
run; high-risk work requires typing `OPERATE OPENRAPPTER`. Recovery is only
reported after real agent-tool evidence and a post-operative verification pass.

### RAPP + X: UI is optional

`POST /chat` is the universal capability surface for people, AIs, twins,
rapplications, Brainstems, and neighborhood peers. Python and TypeScript accept
the same `rapp-chat/1.0` envelope; UI, TUI, menu bar, and other clients are
projections over that headless contract, not separate capability paths. See
[`contracts/rapp-chat-v1.json`](contracts/rapp-chat-v1.json), which both
runtimes are tested against -- its `required` arrays drive the assertions in
`python/tests/test_openrappter_brainstem.py` and
`typescript/src/__tests__/integration/rapp-chat-contract.test.ts`, so a key
added there fails both suites until both runtimes emit it.

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
| **Copilot Surgeon** | Adaptive primary UI: live patient anatomy, AI-generated next choices, digest-bound procedures, and evidence-gated recovery |
| **Local-First Data** | Memory, config, and state live in `~/.openrappter/` on your machine |
| **Single File Agents** | One file = one agent — metadata defined in native code constructors, deterministic, portable |
| **Persistent Memory** | Remembers facts, preferences, and context across sessions |
| **Dual Runtime** | Same agent contract in Python (21 agents) and TypeScript (35 agents) |
| **Data Sloshing** | Automatic context enrichment (temporal, memory, behavioral signals) before every action |
| **Data Slush** | Agent-to-agent signal pipeline — agents return curated `data_slush` that feeds into the next agent's context |
| **Auto-Discovery** | Drop a `*_agent.py` or `*Agent.ts` file in `agents/` — no registration needed |
| **RappterHub** | Install community agents with `openrappter rappterhub install author/agent` |
| **ClawHub Compatible** | OpenClaw skills work here too — `openrappter clawhub install author/skill` |
| **Runtime Agent Generation** | `LearnNew` agent creates new agents from natural language descriptions |
| **Show-and-Tell** | Record a real workflow, review its reconstructed intent and steps, then build a reusable skill or disabled automation |
| **Electron Desktop** | Native desktop shell with a sandboxed renderer, current packaged UI, gateway reuse, and visual Show-and-Tell controls |
| **Autonomous UI Control** | Chat and approved hot-loaded agents drive the visible Electron UI through semantic snapshots and refs |
| **Local Voice Loop** | On-device Whisper narration and optional VibeVoice speech with self-bootstrapping model caches |
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

### Install via [Homebrew](https://github.com/kody-w/homebrew-tap)

```bash
brew tap kody-w/tap
brew install --cask openrappter-bar
```

### Install via DMG

1. Download the latest DMG from [Releases](https://github.com/kody-w/openrappter/releases?q=bar)
2. Open the DMG and drag **OpenRappter Bar** to Applications
3. Launch **OpenRappter Bar** normally from Applications
4. The app appears in your menu bar and auto-connects to `localhost:18790`

Release builds are signed with Apple Developer ID and notarized by Apple.

### Release a new menu bar version

```bash
git tag v1.0.1-bar && git push origin v1.0.1-bar
```

This separate platform workflow builds a universal binary (Apple Silicon + Intel), packages a DMG, and creates a GitHub Release. npm and PyPI releases use the strict `vX.Y.Z` process documented in [CONTRIBUTING.md](CONTRIBUTING.md#releasing-npm-and-pypi-packages).

Signing credential setup, health checks, rotation, and compromise response are
documented in [`macos/SIGNING.md`](macos/SIGNING.md).

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

### macOS Menu Bar App

Download **OpenRappter Bar** from the [latest Bar releases](https://github.com/kody-w/openrappter/releases?q=bar) — it's a `.dmg` with a drag-to-Applications installer.

Release builds are signed and notarized, so they launch normally without a Gatekeeper bypass.

Or build from source:

```bash
cd macos
VERSION=1.10.0 ./scripts/build-mac-app.sh
# DMG created at macos/dist/OpenRappter-Bar-1.10.0.dmg
```

## Built-in Agents

### Python Runtime

| Agent | Description |
|-------|-------------|
| `Shell` | Execute bash commands, read/write files, list directories |
| `ManageMemory` | Store important information with content, importance, tags |
| `ContextMemory` | Recall and provide context from stored memories |
| `LearnNew` | Generate new agents from natural language — writes code, hot-loads, installs deps |
| `ShowAndTell` | Record, analyze, approve, and package a demonstrated workflow |
| `Pokemon` | Let Copilot play a local Pokemon Red ROM with save states, MP4 clips, and a live viewer |

Install the optional emulator support, then start or control the player through
the agent:

```bash
cd python
pip install -e ".[pokemon]"
openrappter --exec Pokemon "start"
openrappter --exec Pokemon "status"
openrappter --exec Pokemon "save checkpoint and start a new clip"
openrappter --exec Pokemon "stop"
```

The ROM is discovered locally and never copied into the repository. Runtime
state, recordings, and the viewer data stay under
`~/.openrappter/pokemon-red/`.

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
| `ShowAndTell` | Record, analyze, approve, and package a demonstrated workflow |
| `Message` | Multi-channel messaging — Telegram, Slack, Discord, and more |
| `Ouroboros` | Self-evolving agent — reads its own source, generates improved versions across 5 generations |
| `Pipeline` | Declarative multi-agent pipeline runner with data_slush threading |
| `SelfHealingCron` | Autonomous health check agent with auto-restart and alerting |
| `Sessions` | Chat session management — list, retrieve, switch conversations |
| `TTS` | Text-to-speech synthesis with multiple voice options |
| `Watchmaker` | Agent ecosystem manager — evaluates quality, A/B tests, promotes winners |
| `Web` | Fetch web pages and search the web with SSRF protection |

`Browser` blocks loopback, private, link-local, CGNAT, benchmark, reserved, and
multicast targets by default—including redirects, subresources, and WebSocket
connections. For trusted local development only, the operator can set
`OPENRAPPTER_BROWSER_ALLOW_PRIVATE_NETWORK=1` before starting OpenRappter. This
is deliberately not an agent action parameter, so page content or a prompt
cannot opt itself into the local network.

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

Both registries are implemented in the Python runtime. The launcher runs
TypeScript by default, so these two commands hand their arguments to the Python
runtime installed beside it (`~/.openrappter/python`, or `$OPENRAPPTER_HOME`)
and return its exit code. On an npm-only install, where no Python runtime is
present, they say so and exit nonzero.

Skills that live in a GitHub repo with a `skill.json` are installed by the
TypeScript runtime directly:

```bash
openrappter skills list                 # bundled + installed
openrappter skills search "productivity"
openrappter skills install owner/repo
openrappter skills uninstall owner/repo
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

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Copyright 2026 Wildhaven Homes LLC.

openrappter was previously distributed under MIT. That change is not
retroactive: copies obtained under MIT stay MIT-licensed and those rights
cannot be revoked. Apache-2.0 governs this and every later version.

Apache-2.0 §6 does not grant trademark rights. The name and marks are covered
separately by [TRADEMARK.md](TRADEMARK.md), which is unchanged.


---

<div align="center">

**[Star on GitHub](https://github.com/kody-w/openrappter)** | **[Documentation](./docs)** | **[Skills Reference](./skills.md)**

</div>

---

<sub>OpenRappter is a trademark of Wildhaven Homes LLC. Code is Apache-2.0 licensed; §6 does not grant rights to the name. [Trademark notice](TRADEMARK.md)</sub>
