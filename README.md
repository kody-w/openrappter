<div align="center">

# 🦖 openrappter

### AI agents that run on your machine

**No extra API keys. No new accounts. No additional monthly bills.**

[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3b82f6.svg)](https://python.org)
[![Node.js 18+](https://img.shields.io/badge/Node.js-18+-22c55e.svg)](https://nodejs.org)
[![RappterHub](https://img.shields.io/badge/RappterHub-Agents-a855f7.svg)](https://github.com/rappterhub/rappterhub)

[Documentation](./docs) • [Skills Reference](./skills.md) • [RappterHub](https://github.com/rappterhub/rappterhub)

---

</div>

## The Problem

Every AI agent framework wants your API keys and credit card. OpenAI, Anthropic, Gemini — they all add up to $50-100+/month for power users. Your conversations go to the cloud. Your data isn't yours.

## The Solution

**openrappter** uses your existing GitHub Copilot subscription ($10/mo, free for students) to power a local-first AI agent. No new accounts. No extra API keys to manage. Your agent data stays on your machine.

```bash
pip install openrappter
openrappter "remember that I prefer TypeScript over JavaScript"
# 🦖 Remembered: "prefer TypeScript over JavaScript" (preference)
```

## Features

| Feature | Description |
|---------|-------------|
| 🔐 **Zero API Keys** | Uses GitHub Copilot SDK — no separate API keys needed |
| 🏠 **Local-First** | All data stays in `~/.openrappter` on your machine |
| 🧠 **Persistent Memory** | Remembers facts, preferences, and context across sessions |
| 📦 **RappterHub** | Install community agents with `rappterhub install author/agent` |
| 🔄 **Dual Runtime** | Same agent contract in Python and TypeScript |
| 🎯 **Data Sloshing** | Automatic context enrichment before every action |
| 🔌 **ClawHub Compatible** | Install OpenClaw skills with `openrappter clawhub install` |

## Quick Start

### Python (Recommended)

```bash
# Install
pip install openrappter

# Run interactive mode
openrappter

# Or run a single task
openrappter "what files did I change today?"

# Install agents from RappterHub
openrappter rappterhub install kody-w/git-helper
```

### TypeScript

```bash
cd typescript
npm install && npm run build
node dist/index.js "remember that I installed openrappter"
```

## RappterHub — Agent Registry

[RappterHub](https://github.com/rappterhub/rappterhub) is our open registry for sharing AI agents.

```bash
# Search for agents
rappterhub search "git automation"

# Install an agent
rappterhub install kody-w/git-helper

# Create your own
rappterhub init my-agent

# Publish to the registry
rappterhub publish ./my-agent
```

## Architecture

```
~/.openrappter/
├── config.json      # User preferences
├── memory.json      # Persistent memory
├── state.json       # Agent state
├── agents/          # RappterHub agents
└── skills/          # ClawHub skills
```

### Agent Contract

Both Python and TypeScript agents follow the same pattern:

```python
class MyAgent(BasicAgent):
    def __init__(self):
        metadata = {
            "name": "MyAgent",
            "description": "What this agent does",
            "parameters": {...}
        }
        super().__init__("MyAgent", metadata)

    def perform(self, **kwargs) -> str:
        # self.context has enriched signals from data sloshing
        return json.dumps({"status": "success", "result": "..."})
```

### Built-in Agents

| Agent | Description |
|-------|-------------|
| `Shell` | Execute bash commands, read/write files |
| `Memory` | Store and recall facts persistently |
| `LearnNew` | Meta-agent that generates new agents from descriptions |

## ClawHub Compatibility

openrappter can also use [ClawHub](https://clawhub.ai) skills:

```bash
# Search ClawHub
openrappter clawhub search "discord"

# Install a skill
openrappter clawhub install steipete/discord

# List installed skills
openrappter clawhub list
```

## Why "openrappter"?

It's a **rapp**id prototyping **agent** that's open source. Plus, who doesn't want a velociraptor in their terminal? 🦖

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
# Development setup
git clone https://github.com/kody-w/openrappter.git
cd openrappter/python
pip install -e .
```

## License

MIT © [Kody W](https://github.com/kody-w)

---

<div align="center">

**[⭐ Star us on GitHub](https://github.com/kody-w/openrappter)** — it helps more developers discover local-first AI agents

</div>
