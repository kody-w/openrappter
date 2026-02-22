# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenRappter is a local-first AI agent framework with parallel implementations in **TypeScript** and **Python**. It provides agent orchestration with built-in "data sloshing" (implicit context enrichment), a skills system via ClawHub, memory persistence, multi-channel messaging, and a WebSocket gateway. The `openclaw/` directory is a separate, bundled production AI assistant system with its own build.

## Repository Layout

- `typescript/` — TypeScript/Node.js package (v1.7.0, ES modules, Node >=20)
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
- `AgentChain` (`chain.ts`) — Sequential pipeline with automatic `data_slush` forwarding between steps; supports transforms, timeouts, stopOnError/continue modes
- `AgentGraph` (`graph.ts`) — DAG executor with parallel execution, topological sort, cycle detection, and multi-upstream `data_slush` merging

## Architecture: AgentGraph (DAG Executor)

`AgentGraph` executes agents as a directed acyclic graph. Nodes whose dependencies are satisfied run concurrently; data flows automatically between nodes.

### Key types

- `GraphNode` — `{ name, agent, kwargs?, dependsOn?: string[] }` — a node in the DAG
- `GraphNodeResult` — `{ name, agentName, result, dataSlush, durationMs, status: 'success'|'error'|'skipped' }`
- `GraphResult` — `{ status, nodes: Map, executionOrder, totalDurationMs, error? }`
- `GraphOptions` — `{ nodeTimeout?, stopOnError?: boolean }`

### Execution model

1. `validate()` checks for missing dependencies and cycles (DFS three-color algorithm)
2. `run()` computes topological levels via Kahn's algorithm
3. Each level's nodes execute concurrently via `Promise.all`
4. Multi-dependency slush merging: `upstream_slush = { nodeA: { ...slushA }, nodeB: { ...slushB } }`
5. Failed nodes: dependents are marked `skipped` (default) or execution stops immediately (`stopOnError: true`)

```typescript
const graph = new AgentGraph()
  .addNode({ name: 'fetch', agent: webAgent, kwargs: { url: '...' } })
  .addNode({ name: 'parse', agent: parseAgent, dependsOn: ['fetch'] })
  .addNode({ name: 'store', agent: memAgent, dependsOn: ['parse'] })
  .addNode({ name: 'notify', agent: msgAgent, dependsOn: ['parse'] });

const result = await graph.run();
// 'parse' runs after 'fetch'; 'store' and 'notify' run in parallel after 'parse'
```

**Files**: `typescript/src/agents/graph.ts`, `typescript/src/__tests__/parity/agent-graph.test.ts` (19 tests)

## Architecture: Agent Observability (AgentTracer)

Span-based tracing system for agent execution. Tracks start/end/duration/inputs/outputs across chains, graphs, and sub-agent calls.

### Key types

- `TraceSpan` — `{ id, parentId, traceId, agentName, operation, startTime, endTime, durationMs, status, inputs?, outputs?, dataSlush?, error?, tags? }`
- `TraceContext` — `{ traceId, spanId, baggage? }` — propagated through chains/graphs to link parent-child spans
- `AgentTracerOptions` — `{ maxSpans?: number, recordIO?: boolean, onSpanComplete?: (span) => void }`

### Usage

```typescript
import { globalTracer } from './agents/tracer.js';

const { span, context } = globalTracer.startSpan('ShellAgent', 'execute', undefined, { action: 'bash' });
// ... run agent ...
globalTracer.endSpan(span.id, { status: 'success', outputs: { exitCode: 0 } });

// Child spans link to parents via context propagation
const { span: child } = globalTracer.startSpan('MemoryAgent', 'execute', context);
```

- `getTrace(traceId)` — all spans for a trace in chronological order
- `getActiveSpans()` / `getCompletedSpans(limit?)` — query running/finished spans
- `toJSON()` — serializable summary with per-trace rollups for dashboards
- `globalTracer` singleton + `createTracer(options)` factory

**Files**: `typescript/src/agents/tracer.ts`, `typescript/src/__tests__/parity/agent-tracer.test.ts` (24 tests)

## Architecture: MCP Server

Exposes OpenRappter agents as MCP (Model Context Protocol) tools via JSON-RPC 2.0 over stdio. Enables Claude Code, Cursor, and other MCP-capable clients to discover and invoke agents.

### Protocol

- `initialize` — returns server info and capabilities (`{ tools: {} }`)
- `tools/list` — returns agent metadata mapped to MCP tool definitions
- `tools/call` — routes to `agent.execute()`, returns content as MCP text blocks
- `ping` — keepalive

### Usage

```typescript
import { McpServer } from './mcp/server.js';

const server = new McpServer({ name: 'openrappter', version: '1.6.0' });
server.registerAgent(shellAgent);
server.registerAgent(memoryAgent);
await server.serve(); // reads stdin, writes stdout
```

Agent metadata maps to MCP tools: `name` → tool name, `description` → tool description, `parameters` → `inputSchema`. Tool call errors return `{ isError: true, content: [{ type: 'text', text: 'Error: ...' }] }` per MCP spec.

**Files**: `typescript/src/mcp/server.ts`, `typescript/src/__tests__/parity/mcp-server.test.ts` (18 tests)

## Architecture: Dashboard REST API

HTTP endpoints for the web dashboard UI. Designed as a mountable handler on the existing gateway HTTP server.

### Endpoints (default prefix: `/api`)

- `GET /api/agents` — list all registered agents with metadata
- `POST /api/agents/execute` — execute an agent: `{ agentName, kwargs }` → `{ status, result, durationMs }`
- `GET /api/traces[?limit=N]` — recent execution traces
- `DELETE /api/traces` — clear trace history
- `GET /api/status` — agent count, trace count, agent names

### Usage

```typescript
import { DashboardHandler } from './gateway/dashboard.js';

const dashboard = new DashboardHandler({ prefix: '/api', cors: true });
dashboard.registerAgents([shellAgent, memoryAgent]);

// In HTTP handler:
const handled = await dashboard.handle(req, res);
if (!handled) { /* pass to next handler */ }
```

CORS enabled by default. Trace store is in-memory with a 500-entry circular buffer. Execution traces are automatically recorded on each `/api/agents/execute` call.

**Files**: `typescript/src/gateway/dashboard.ts`, `typescript/src/__tests__/parity/dashboard-api.test.ts` (21 tests)

## Architecture: Skills (ClawHub)

Skills are `SKILL.md` files stored in `~/.openrappter/skills/`. Skills get wrapped as `ClawHubSkillAgent` instances (extending `BasicAgent`).

- `ClawHubClient` handles search/install/load via `npx clawhub@latest`
- Skills can include executable `scripts/` directories (Python or shell)
- Lock file at `~/.openrappter/skills/.clawhub/lock.json`
- TypeScript: `src/clawhub.ts`, `src/skills/registry.ts`
- Python: `openrappter/clawhub.py`

## Architecture: Other Key Systems

- **Memory** (`typescript/src/memory/`) — Content chunker (overlapping windows), embeddings, hybrid search; Python uses JSON at `~/.openrappter/memory.json`
- **Gateway** (`typescript/src/gateway/`) — WebSocket server, JSON-RPC 2.0 protocol, streaming agent responses, event system (agent, chat, channel, cron, presence); Dashboard REST API (`dashboard.ts`)
- **MCP** (`typescript/src/mcp/`) — MCP server exposing agents as tools via stdio transport
- **Channels** (`typescript/src/channels/`) — CLI, Slack, Discord, Telegram, Signal, iMessage, Google Chat, Teams, WhatsApp, Matrix
- **Storage** (`typescript/src/storage/`) — `StorageAdapter` interface with SQLite and in-memory implementations; migration system
- **Config** (`typescript/src/config/`) — YAML/JSON loading, Zod schema validation, file watcher for live reload
- **Providers** (`typescript/src/providers/`) — Model integrations: Anthropic, OpenAI, Ollama

## Language Parity

TypeScript and Python implementations are designed to mirror each other. When modifying agent logic, check both:
- `typescript/src/agents/BasicAgent.ts` ↔ `python/openrappter/agents/basic_agent.py`
- `typescript/src/agents/ShellAgent.ts` ↔ `python/openrappter/agents/shell_agent.py`
- `typescript/src/agents/LearnNewAgent.ts` ↔ `python/openrappter/agents/learn_new_agent.py`
- `typescript/src/agents/broadcast.ts` ↔ `python/openrappter/agents/broadcast.py`
- `typescript/src/agents/router.ts` ↔ `python/openrappter/agents/router.py`
- `typescript/src/agents/subagent.ts` ↔ `python/openrappter/agents/subagent.py`
- `typescript/src/agents/PipelineAgent.ts` ↔ `python/openrappter/agents/pipeline_agent.py`
- `typescript/src/agents/GitAgent.ts` ↔ `python/openrappter/agents/git_agent.py`
- `typescript/src/agents/CodeReviewAgent.ts` ↔ `python/openrappter/agents/code_review_agent.py`
- `typescript/src/agents/WebAgent.ts` ↔ `python/openrappter/agents/web_agent.py`
- `typescript/src/clawhub.ts` ↔ `python/openrappter/clawhub.py`

Parity tests: `typescript/src/__tests__/parity/` and `python/tests/` (broadcast, router, subagent, pipeline, git_agent, code_review, web_agent).

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

## Showcase Prompts (v1.7.0)

10 advanced agent orchestration patterns with runnable examples and deterministic test suites. Each demonstrates a different framework capability. All helper agents are defined inline — no new core agent files. Tests use vitest mocking, no LLM calls.

### Showcase Index

| # | Name | Pattern | Example | Test | Tests |
|---|------|---------|---------|------|-------|
| 1 | The Architect | LearnNewAgent + AgentGraph DAG | `examples/architect.ts` | `showcase-architect.test.ts` | 7 |
| 2 | Ouroboros Accelerator | AgentChain evolution → code review | `examples/ouroboros-accelerator.ts` | `showcase-accelerator.test.ts` | 7 |
| 3 | Swarm Debugger | BroadcastManager race mode + slush forwarding | `examples/swarm-debugger.ts` | `showcase-swarm-debugger.test.ts` | 5 |
| 4 | Mirror Test | Parallel parity comparison via AgentGraph | `examples/mirror-test.ts` | `showcase-mirror-test.test.ts` | 5 |
| 5 | Watchmaker's Tournament | Competing agents + evaluator graph | `examples/watchmaker-tournament.ts` | `showcase-watchmaker-tournament.test.ts` | 7 |
| 6 | Living Dashboard | Tracer → Dashboard → MCP self-monitoring | `examples/living-dashboard.ts` | `showcase-living-dashboard.test.ts` | 7 |
| 7 | Infinite Regression | SubAgent depth limits + loop detection | `examples/infinite-regression.ts` | `showcase-infinite-regression.test.ts` | 13 |
| 8 | Code Archaeologist | AgentGraph fan-out / fan-in | `examples/code-archaeologist.ts` | `showcase-code-archaeologist.test.ts` | 6 |
| 9 | Agent Compiler | PipelineAgent conditional steps | `examples/agent-compiler.ts` | `showcase-agent-compiler.test.ts` | 9 |
| 10 | Doppelganger | AgentTracer + clone comparison | `examples/doppelganger.ts` | `showcase-doppelganger.test.ts` | 6 |

All paths relative to `typescript/`. Tests at `src/__tests__/parity/`. Run all: `npx vitest run src/__tests__/parity/showcase-*.test.ts` (72 tests).

### 1. The Architect — LearnNewAgent + AgentGraph DAG

Runtime-created agents (DataValidator, Transformer, Reporter) wired into an AgentGraph. Reporter depends on both upstream nodes and receives merged `upstream_slush = { validate: {...}, transform: {...} }`. Demonstrates DAG wiring, topological execution order, multi-upstream slush merging, and error propagation (skip dependents / stopOnError).

### 2. Ouroboros Accelerator — AgentChain + Code Review

AgentChain: `evolve` step (EvolutionAgent) → `review` step (ReviewAgent). A transform function extracts `evolved_source` from the evolution result and passes it as `content` to the review step. Demonstrates chain transforms, data_slush propagation through steps, and stopOnError behavior.

### 3. Swarm Debugger — BroadcastManager (race) + Fix Agent

Three debug agents (LogAnalyzer, StackTraceParser, ErrorCategorizer) with different delays race via `BroadcastManager` in `race` mode. The fastest responder's `data_slush` is forwarded as `upstream_slush` to a FixSuggestionAgent. Key API: `broadcast(groupId, message, executor)` where executor is `(agentId, msg) => agent.execute({query: msg})`.

### 4. Mirror Test — AgentGraph Parallel Comparison

Two sentiment analysis agents (SentimentA, SentimentB) run as parallel AgentGraph roots. A ComparatorAgent depends on both, receiving `upstream_slush = { sentimentA: {...}, sentimentB: {...} }`. Compares sentiment labels for parity and computes confidence delta between implementations.

### 5. Watchmaker's Tournament — Competing Agents + Evaluator

Three CompetitorAgents run in parallel with no dependencies. A TournamentEvaluatorAgent depends on all three, reads `this.context.upstream_slush` with all competitors' slush, sorts by quality score, and picks the winner. Tests verify ranking order, tie handling, and skip-on-failure behavior.

### 6. Living Dashboard — Tracer → Dashboard → MCP Self-Monitoring

AgentChain runs demo agents (HealthCheck, Metrics, Report). AgentTracer captures spans via `onSpanComplete` callback → feeds `DashboardHandler.addTrace()`. A DashboardQueryAgent reads traces from the dashboard and is registered on McpServer. MCP `tools/call` queries the dashboard — the system monitors itself. Full loop: chain → tracer → dashboard → MCP query.

### 7. Infinite Regression — SubAgent Depth Limits + Loop Detection

Demonstrates SubAgentManager safety mechanisms:
- **Depth limits**: `canInvoke(agentId, depth)` returns false when `depth >= maxDepth`
- **Loop detection**: `context.history.slice(-10).filter(c => c.targetAgentId === id).length >= 3` triggers error
- **Blocked/allowed agents**: allowlist and blocklist enforcement
- Tests manually accumulate `SubAgentCall` records in `context.history` to simulate sequential sub-agent invocations (since `invoke()` creates child contexts without mutating the parent)

### 8. Code Archaeologist — AgentGraph Fan-out / Fan-in

Three analysis agents (GitHistoryAgent, DependencyAnalyzerAgent, ComplexityScorerAgent) run as parallel graph roots. A SynthesisAgent depends on all three and receives merged `upstream_slush` keyed by node name. Cross-references git hotspots with complexity risky files to identify priority refactoring targets.

### 9. Agent Compiler — PipelineAgent Conditional Steps

PipelineAgent with a conditional step triggered by `data_slush` values:
- InputParserAgent emits `data_slush.needs_new_agent = true/false`
- Conditional step: `{ field: 'needs_new_agent', equals: true }` (evaluated by `PipelineAgent.evaluateCondition()`)
- If true, runs AgentCreatorAgent (simulating LearnNewAgent), then DynamicExecutorAgent
- Tests verify conditional fires/skips, `exists` condition checks, data_slush threading, and end-to-end pipeline completion

### 10. Doppelganger — AgentTracer + Clone Comparison

Traces a TextProcessorAgent (deterministic word count / longest word / reverse) via `startSpan`/`endSpan` with `recordIO: true`. Extracts trace to build a description for creating a "clone" agent. Both original and clone run on the same input, then a ComparisonAgent checks field-by-field equality. Tests verify trace IO capture, duration recording, identical clone output, and divergence detection.

## UX Principles

**Inline resolution over error messages.** If a feature requires setup (auth, tokens, config), trigger that setup flow inline when the user first needs it. Never respond with "run X command" — just run it. If interactive setup isn't possible (no TTY), provide the most minimal, actionable guidance possible.
