# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenRappter is a local-first AI agent framework with parallel implementations in **TypeScript** and **Python**. It provides agent orchestration with built-in "data sloshing" (implicit context enrichment), a skills system via ClawHub, memory persistence, multi-channel messaging, and a WebSocket gateway. The `openclaw/` directory is a separate, bundled production AI assistant system with its own build.

## Repository Layout

- `typescript/` — TypeScript/Node.js package (v1.2.0, ES modules, Node >=18)
- `python/` — Python package (mirrors TypeScript agent architecture)
- `openclaw/` — Separate production assistant system (pnpm, tsdown build)

## Build & Test Commands

### TypeScript (`typescript/`)
```bash
cd typescript
npm run build        # tsc compilation → dist/
npm run dev          # tsx watch mode
npm start            # node dist/index.js
npm test             # vitest run (all tests)
npm run test:watch   # vitest in watch mode
npm run lint         # eslint src/
npm run format       # prettier --write .
```

Run a single test file:
```bash
cd typescript && npx vitest run src/path/to/file.test.ts
```

### OpenClaw (`openclaw/`)
```bash
cd openclaw
pnpm install && pnpm build
pnpm check           # type-check + lint + format
pnpm test            # vitest
```

## TypeScript Configuration

- **Target**: ES2022, **Module**: NodeNext, **Strict**: true
- Source in `src/`, compiled to `dist/`
- Tests: Vitest 2.0, pattern `src/**/*.test.ts`, globals enabled, node environment
- Validation: Zod v4

## Architecture: Agent System

Both TypeScript and Python share the same agent architecture. The key abstraction is `BasicAgent`:

**Execution flow**: `execute(kwargs)` → `slosh(query)` → `perform(kwargs)`

- `execute()` is the entry point — it runs data sloshing, then calls `perform()`
- `perform()` is the abstract method subclasses implement
- `slosh()` gathers implicit context before action (temporal, query signals, memory echoes, behavioral hints, priors) and synthesizes an `Orientation` (confidence, approach, hints)
- Access enriched signals via `getSignal(key)` with dot-notation (e.g., `getSignal('temporal.time_of_day')`)

**Built-in agents**:
- `BasicAgent` — Abstract base with data sloshing
- `ShellAgent` — Shell commands, file read/write/list (actions: `bash`, `read`, `write`, `list`; natural language query parsing)
- `MemoryAgent` — Memory storage and retrieval (Python has `ContextMemoryAgent` and `ManageMemoryAgent`)
- `LearnNewAgent` (Python only) — Meta-agent that generates new agent classes at runtime with hot-loading

**Multi-agent patterns** (TypeScript `src/agents/`):
- `BroadcastManager` (`broadcast.ts`) — Send to multiple agents; modes: `all` (wait all), `race` (first wins), `fallback` (try until success)
- `AgentRouter` (`router.ts`) — Rule-based message routing by sender/channel/group/pattern with priority; session key isolation
- `SubAgent` (`subagent.ts`) — Nested agent invocation with depth limits and loop detection

## Architecture: Skills (ClawHub)

Skills are `SKILL.md` files with optional YAML frontmatter, stored in `~/.openrappter/skills/`. Skills get wrapped as `ClawHubSkillAgent` instances (extending `BasicAgent`).

- `ClawHubClient` handles search/install/load via `npx clawhub@latest`
- Skills can include executable `scripts/` directories (Python or shell)
- Lock file at `~/.openrappter/skills/.clawhub/lock.json`
- TypeScript: `src/clawhub.ts`, `src/skills/registry.ts`
- Python: `openrappter/clawhub.py`

## Architecture: Other Key Systems

- **Memory** (`typescript/src/memory/`) — Content chunker (overlapping windows), embeddings, hybrid search; Python uses JSON at `~/.openrappter/memory.json`
- **Gateway** (`typescript/src/gateway/`) — WebSocket server, JSON-RPC 2.0 protocol, streaming agent responses, event system (agent, chat, channel, cron, presence)
- **Channels** (`typescript/src/channels/`) — CLI, Slack, Discord, Telegram, Signal, iMessage, Google Chat, Teams, WhatsApp, Matrix
- **Storage** (`typescript/src/storage/`) — `StorageAdapter` interface with SQLite and in-memory implementations; migration system
- **Config** (`typescript/src/config/`) — YAML/JSON loading, Zod schema validation, file watcher for live reload
- **Providers** (`typescript/src/providers/`) — Model integrations: Anthropic, OpenAI, Ollama

## Language Parity

TypeScript and Python implementations are designed to mirror each other. When modifying agent logic, check both:
- `typescript/src/agents/BasicAgent.ts` ↔ `python/openrappter/agents/basic_agent.py`
- `typescript/src/agents/ShellAgent.ts` ↔ `python/openrappter/agents/shell_agent.py`
- `typescript/src/clawhub.ts` ↔ `python/openrappter/clawhub.py`

Parity tests live at `typescript/src/__tests__/parity/`.
