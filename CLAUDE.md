# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenRappter is a local-first AI agent framework with parallel implementations in **TypeScript** and **Python**. It provides agent orchestration with built-in "data sloshing" (implicit context enrichment), a skills system via ClawHub, memory persistence, multi-channel messaging, and a WebSocket gateway. The `openclaw/` directory is a separate, bundled production AI assistant system with its own build.

## Repository Layout

- `typescript/` — TypeScript/Node.js package (v1.4.1, ES modules, Node >=20)
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

### Single File Agent Pattern

One file = one agent. The metadata contract, documentation, and deterministic code all live in a single file using native language constructs:

```python
# Python: native dict in __init__
class MyAgent(BasicAgent):
    def __init__(self):
        self.name = 'MyAgent'
        self.metadata = {
            "name": self.name,
            "description": "What this agent does",
            "parameters": { "type": "object", "properties": {...}, "required": [] }
        }
        super().__init__(name=self.name, metadata=self.metadata)
    
    def perform(self, **kwargs):
        ...
```

```typescript
// TypeScript: native object in constructor
export class MyAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = { name: 'MyAgent', description: '...', parameters: {...} };
    super('MyAgent', metadata);
  }
  async perform(kwargs) { ... }
}
```

No YAML. No config files. No magic parsing. The code IS the contract.

### Execution Flow

`execute(kwargs)` → `slosh(query)` → merge `upstream_slush` → `perform(kwargs)` → extract `data_slush`

- `execute()` is the entry point — it runs data sloshing, merges any `upstream_slush` from a previous agent, then calls `perform()`
- `perform()` is the abstract method subclasses implement
- `slosh()` gathers implicit context before action (temporal, query signals, memory echoes, behavioral hints, priors) and synthesizes an `Orientation` (confidence, approach, hints)
- After `perform()`, if the result JSON contains a `data_slush` key, it is extracted to `last_data_slush` (Python) / `lastDataSlush` (TypeScript) for downstream chaining
- Access enriched signals via `getSignal(key)` with dot-notation (e.g., `getSignal('temporal.time_of_day')`)
- Access upstream agent signals via `self.context['upstream_slush']` / `this.context.upstream_slush`

**Built-in agents** (all single file agents):
- `BasicAgent` — Abstract base with data sloshing
- `ShellAgent` — Shell commands, file read/write/list (actions: `bash`, `read`, `write`, `list`; natural language query parsing)
- `MemoryAgent` — Memory storage and retrieval (Python has `ContextMemoryAgent` and `ManageMemoryAgent`)
- `LearnNewAgent` — Meta-agent that generates new single file agents at runtime with hot-loading (both TypeScript and Python)

**Multi-agent patterns** (TypeScript `src/agents/`):
- `BroadcastManager` (`broadcast.ts`) — Send to multiple agents; modes: `all` (wait all), `race` (first wins), `fallback` (try until success)
- `AgentRouter` (`router.ts`) — Rule-based message routing by sender/channel/group/pattern with priority; session key isolation
- `SubAgent` (`subagent.ts`) — Nested agent invocation with depth limits and loop detection

## Architecture: Skills (ClawHub)

Skills are `SKILL.md` files stored in `~/.openrappter/skills/`. Skills get wrapped as `ClawHubSkillAgent` instances (extending `BasicAgent`).

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
- `typescript/src/agents/LearnNewAgent.ts` ↔ `python/openrappter/agents/learn_new_agent.py`
- `typescript/src/clawhub.ts` ↔ `python/openrappter/clawhub.py`

Parity tests live at `typescript/src/__tests__/parity/`.

## Capability Scoring Principles (OuroborosAgent)

The capability assessment system (`checkWordStats`, `checkSentiment`, `checkCaesarCipher`, `checkPatterns`, `checkReflection` in `OuroborosAgent.ts`) follows these design rules:

### Graduated thresholds over binary checks

Never treat the mere presence of data as a passing check. Require minimum meaningful samples:
- **Word counts**: `>= 3` for minimum meaningful sample, `>= 10` for statistically meaningful input
- **Frequency distributions**: `>= 3` entries to constitute a real distribution, not a single lucky match
- **Sentiment evidence**: `>= 2` sentiment-bearing words to confirm detection, not just 1

### Inclusive boundaries

Use `>=` not `>` for ratio thresholds. Natural text often lands exactly on boundaries (e.g., 50% unique word ratio is common). Excluding the boundary penalizes legitimate input.

### Polarity-agnostic sentiment scoring

Sentiment quality measures detection accuracy, not tonal range. Pure positive text ("amazing wonderful great") should score 100% if detected correctly. The `sufficient_evidence` check rewards having multiple sentiment-bearing words regardless of polarity — never require both positive AND negative words.

### Pass/fail where appropriate

Caesar cipher checks are inherently pass/fail (roundtrip either works or doesn't). Pattern detection checks measure breadth across categories. Reflection checks validate correctness. Don't add graduated thresholds where binary is the right model.

### Quality = (passed checks / total checks) * 100

Each check contributes equal weight. Adding a new check changes the denominator for all scores in that capability. When adding checks, verify downstream tests and integration expectations still hold.

**Files**: `typescript/src/agents/OuroborosAgent.ts` (scoring functions), `typescript/src/__tests__/parity/ouroboros.test.ts` (capability scoring tests)

## Runtime Agent Generation (LearnNewAgent)

LearnNewAgent is a meta-agent that creates new agents from natural language descriptions at runtime. It is the key enabler for prompt patterns like Lazarus, Darwin's Colosseum, Skill Forge, and Agent Factory.

### Actions

- **`create`** — Generate, write, and hot-load a new agent from a description
- **`list`** — List all user-generated agents in the agents directory
- **`delete`** — Remove a generated agent (core agents are protected)

### Generated Agent Format

TypeScript generates `.js` ESM files using a **factory pattern** to avoid import resolution issues:

```javascript
// Generated: ~/.openrappter/agents/sentiment_agent.js
export function createAgent(BasicAgent) {
  class SentimentAgent extends BasicAgent {
    constructor() {
      super('Sentiment', { name: 'Sentiment', description: '...', parameters: {...} });
    }
    async perform(kwargs) { /* generated logic */ }
  }
  return SentimentAgent;
}
```

Python generates `.py` files with direct imports (standard `from openrappter.agents.basic_agent import BasicAgent`).

### Hot-Loading

- **TypeScript**: Dynamic `import()` with `pathToFileURL()` + cache-busting timestamp query param. The factory receives `BasicAgent` as a parameter, instantiates the class, and registers it in `loadedAgents` map.
- **Python**: `importlib.util.spec_from_file_location()` → `module_from_spec()` → `exec_module()`. Registers in `sys.modules` for future imports.

### Intelligence Inference

The agent infers structure from the description text:

- **Name generation**: Filters stop words (`that`, `this`, `with`, `from`, `agent`, `create`, `make`, `want`, `should`, `would`, `could`), extracts first 2 keywords > 3 chars, CamelCase joins them. Copilot CLI is an optional enhancer.
- **Extra parameters**: Keywords like `file`/`path` → adds `path` param; `url`/`http` → `url` param; `number`/`count` → `count` param.
- **Extra imports**: Keywords map to Node builtins (`fs`, `crypto`, `https`, `child_process`, etc.) or Python stdlib equivalents.
- **Tags**: Keywords map to categories (`weather`, `api`, `web`, `filesystem`, `data`, `search`, `email`, `database`, `news`, `scheduling`, `voice`). Defaults to `['custom']`.

### Dependency Management

- **TypeScript**: Parses `import` statements from generated code, filters out Node builtins, runs `npm install` for missing packages.
- **Python**: Parses `import`/`from` statements, filters stdlib via a known set, maps module→package names (e.g., `cv2`→`opencv-python`), runs `pip install`.

### File Naming

Both runtimes use snake_case: `CamelCase` → `camel_case_agent.{js,py}`. TypeScript uses `_agent.js` suffix; Python uses `_agent.py`.

### Core Agent Protection

Deletion is blocked for built-in agent files. TypeScript protects: `BasicAgent.ts`, `ShellAgent.ts`, `MemoryAgent.ts`, `LearnNewAgent.ts`, `AgentRegistry.ts`, `Assistant.ts` (plus `.js` variants). Python protects: `basic_agent.py`, `shell_agent.py`, `learn_new_agent.py`, `manage_memory_agent.py`, `context_memory_agent.py`.

### Constructor

The TypeScript constructor accepts an optional `agentsDir` parameter (defaults to `~/.openrappter/agents/`). Python uses `Path(__file__).parent` (the source agents directory).

**Files**: `typescript/src/agents/LearnNewAgent.ts`, `python/openrappter/agents/learn_new_agent.py`, `typescript/src/__tests__/parity/learn-new-agent.test.ts` (61 tests)

## UX Principles

**Inline resolution over error messages.** If a feature requires setup (auth, tokens, config), trigger that setup flow inline when the user first needs it. Never respond with "run X command" — just run it. If interactive setup isn't possible (no TTY), provide the most minimal, actionable guidance possible.
