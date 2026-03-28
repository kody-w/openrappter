# openrappter Knowledge Base

> Local-first AI agent framework powered by GitHub Copilot SDK — no API keys required.

**Version**: 1.9.3 (TypeScript) / 1.9.1 (Python)
**License**: MIT
**Repo**: [github.com/kody-w/openrappter](https://github.com/kody-w/openrappter)

---

## Quick Navigation

### Architecture
- [[Architecture Overview]] — System design, execution flow, deployment topology
- [[Data Sloshing]] — Implicit context enrichment before every agent action
- [[Data Slush Pipeline]] — Agent-to-agent signal forwarding
- [[Single File Agent Pattern]] — One file = one agent, no config files
- [[Gateway Server]] — WebSocket RPC server and REST dashboard
- [[Storage System]] — SQLite persistence layer
- [[Memory System]] — Hybrid vector + full-text search
- [[Config System]] — YAML/JSON config with hot-reload
- [[MCP Server]] — Model Context Protocol integration
- [[LLM Providers]] — Copilot, Anthropic, OpenAI, Gemini, Ollama
- [[Dashboard UI]] — Lit web component dashboard

### Agents
- [[Agent Index]] — Complete catalog of all agents
- [[BasicAgent]] — Abstract base class with data sloshing
- [[ShellAgent]] — Shell commands, file I/O
- [[MemoryAgent]] — Persistent memory storage/recall
- [[LearnNewAgent]] — Meta-agent that creates agents from natural language
- [[OuroborosAgent]] — Self-evolving agent with lineage tracking
- [[Agent Composition]] — Chains, graphs, routers, broadcasts

### Channels
- [[Channel Index]] — All 18+ messaging platform integrations
- [[Channel Architecture]] — BaseChannel pattern and registry

### Guides
- [[Getting Started]] — Installation and first run
- [[Creating an Agent]] — Step-by-step agent creation guide
- [[Multi-Agent Patterns]] — Chains, graphs, DAGs, broadcasts
- [[Showcase Demos]] — 20 runnable orchestration pattern demos
- [[Soul Templates]] — 10 prebuilt agent personas
- [[Skills and ClawHub]] — Community skill marketplace
- [[Background Daemon and Cron]] — Scheduled jobs and daemon setup
- [[Testing Guide]] — Vitest and pytest usage
- [[macOS Menu Bar App]] — Dino tamagotchi companion

### Project
- [[Productivity Stack Plan]] — Automation roadmap
- [[Integration Checklist]] — External service connections
- [[Roadmap]] — Feature priorities and upcoming work
- [[Capability Scoring Principles]] — Ouroboros evolution scoring rules

---

## Runtimes

| | TypeScript | Python |
|---|---|---|
| **Entry** | `typescript/src/index.ts` | `python/openrappter/cli.py` |
| **Agents** | `src/agents/*Agent.ts` | `agents/*_agent.py` |
| **Build** | `npm run build` | `pip install -e .` |
| **Test** | `npx vitest run` | `pytest` |
| **Node/Python** | >=20.0.0 | >=3.10 |

---

#moc #home
