# OpenRappter Roadmap

> Last updated: 2026-02-22 | Current version: **1.9.1**

## Where We Are

OpenRappter is a local-first AI agent framework with dual TypeScript/Python runtimes. The core is solid: 18 agents, 6 orchestration patterns (Chain, Graph, Broadcast, Router, SubAgent, Pipeline), 22 messaging channels, 5 LLM providers, a WebSocket gateway with 60+ RPC methods, a 12-page Lit dashboard, 20 deterministic showcase demos, an MCP server, span-based tracing, and 2,800+ tests.

The Multi-Rappter Gateway (v1.9.1) introduced hot-loadable souls — the gateway acts as a brainstem that can summon one or more rappter configurations per request via single, parallel, race, or chain modes.

TypeScript is the primary runtime. Python is ~60% complete.

### What exists today

| Area | TypeScript | Python | Notes |
|------|-----------|--------|-------|
| Core agents | 18 | 13 | 5 TS agents not yet ported |
| Orchestration | Chain, Graph, Broadcast, Router, SubAgent, Pipeline | Chain, Graph, Broadcast, Router, SubAgent, Pipeline | Full parity |
| Channels | 22 (Slack, Discord, Telegram, WhatsApp, Signal, Teams, etc.) | Base + Registry only | No channel implementations in Python |
| Providers | Copilot, Anthropic, OpenAI, Gemini, Ollama | Config skeleton | No provider implementations in Python |
| Gateway | WebSocket + HTTP, 60+ RPC methods | None | TS only |
| Dashboard | 12 pages (Lit 3.1 web components) | N/A | TS only |
| MCP Server | Full (JSON-RPC 2.0 over stdio) | Skeleton | Needs integration |
| Storage | SQLite + in-memory | SQLite | Full parity |
| Config | YAML/JSON5, Zod validation, env substitution | YAML | Full parity |
| Security | ApprovalManager, audit, rate limiting | Partial | |
| Memory | FTS + chunking + embeddings | FTS + chunking | Full parity |
| Skills (ClawHub) | Full | Full | Full parity |
| Plugins | Full system | None | TS only |
| Showcase demos | 20 | 14 | 6 remaining |
| Tests | 2,803 across 108 files | 126 across 37 files | Python needs catch-up |
| Rappter Manager | Souls + summon modes | None | TS only, new in v1.9.1 |

---

## Phase 1: Foundation Hardening (v1.10 — v1.12)

_Finish what's started. Close gaps. Make it production-worthy._

### 1.1 Python Runtime Completion

- [ ] Port remaining agents: `BrowserAgent`, `ImageAgent`, `TTSAgent`, `MessageAgent`, `SessionsAgent`
- [ ] Implement channel integrations (Slack, Discord, Telegram minimum)
- [ ] Implement provider integrations (Anthropic, OpenAI, Ollama)
- [ ] Python WebSocket gateway (asyncio, mirroring TS protocol)
- [ ] Python plugin system
- [ ] Port remaining 6 showcase demos
- [ ] Python test count from 126 to 500+ (match TS test-per-module ratios)

### 1.2 Rappter Multi-Soul Expansion

- [ ] Soul config persistence — save/load from `~/.openrappter/souls/*.json`
- [ ] Soul-specific conversation history (isolated sessions per soul)
- [ ] Soul identity injection — system prompt and personality per soul
- [ ] Dashboard page for soul management (list, load, unload, summon)
- [ ] `rappter.create` RPC — create souls from natural language descriptions via LearnNewAgent patterns
- [ ] Soul templates — prebuilt configurations ("researcher", "coder", "ops", "analyst")
- [ ] Soul-to-soul communication — souls can summon other souls

### 1.3 Observability & Operations

- [ ] Cost attribution — per-agent and per-soul LLM spend tracking
- [ ] Execution timeline visualization in dashboard (Gantt-style span viewer)
- [ ] Error rate tracking with threshold-based alerting
- [ ] Agent memory usage monitoring
- [ ] Structured logging (JSON output mode for log aggregators)

### 1.4 CI & Quality

- [ ] GitHub Actions pipeline: lint, test, build for both runtimes
- [ ] Performance benchmark suite (agent latency, gateway throughput, memory footprint)
- [ ] Flaky test detection and quarantine
- [ ] Code coverage reporting (target: 80% for both runtimes)
- [ ] Automated release workflow (changelog generation, npm/pypi publish)

---

## Phase 2: Intelligence Layer (v2.0 — v2.2)

_Make agents smarter and more autonomous._

### 2.1 Adaptive Routing & Failover

- [ ] Performance-weighted routing — route to agents based on historical success rates
- [ ] Cost-aware routing — prefer cheaper providers when quality is comparable
- [ ] Automatic fallback chains — cascade to alternatives on provider failure
- [ ] Circuit breakers — automatic failure isolation to prevent cascading errors
- [ ] Retry strategies — configurable backoff, jitter, and max attempts per agent

### 2.2 Knowledge & Memory

- [ ] Semantic knowledge graph — entity extraction and relationship mapping
- [ ] Cross-session memory — agents remember context across conversations
- [ ] Memory summarization — compress old memories into condensed representations
- [ ] Shared memory pool — multiple agents and souls contribute to a common knowledge base
- [ ] Memory import/export for backup and instance transfer

### 2.3 Data Sloshing v2

- [ ] Learned signal weights — adjust importance based on accumulated feedback scores
- [ ] Cross-agent signal propagation — one agent's slosh influences another's context
- [ ] Custom signal providers — plug in external sources (calendar, weather, market data)
- [ ] Signal compression for long-running conversations
- [ ] Temporal decay — older signals lose weight over time

### 2.4 Advanced Orchestration

- [ ] Consensus patterns — voting and quorum mechanisms for multi-agent decisions
- [ ] Streaming result aggregation — combine outputs from parallel agents in real-time
- [ ] Agent result caching with TTL and invalidation
- [ ] Conditional graph edges — dynamic DAG rewiring based on runtime results
- [ ] Agent priority queues — ensure critical agents execute first under load

### 2.5 Capability Scoring (OuroborosAgent)

_Extending the existing deterministic scoring system._

**Quick wins:**
- [ ] Lexical entropy in `checkWordStats` (Shannon entropy, threshold H >= 2.0)
- [ ] Negation handling in `checkSentiment` (2-token window: "not good" flips polarity)
- [ ] Per-capability trajectory tracking (independent slope per capability in `computeTrajectory`)
- [ ] Confidence intervals on trajectory (require slope > 2x standard error)
- [ ] Input difficulty scoring (distinguish "capability broken" from "unfair input")

**Graduated scoring:**
- [ ] Weighted sentiment words (intensity tiers: "good" = 0.5, "amazing" = 1.0)
- [ ] Pattern quality scoring (well-formedness validation, density, false-positive penalty)
- [ ] Character-level cipher verification (every character shifted by expected amount)
- [ ] Reflection method cross-validation (compare declared methods against prototype chain)
- [ ] Simpson's Diversity Index replacing simple unique/total ratio

**Cross-capability intelligence:**
- [ ] Correlation matrix across capability scores over history
- [ ] Bottleneck identification (lowest-scoring capability with highest cross-correlation)

**Predictive & LLM-enhanced:**
- [ ] Root-cause LLM analysis (diagnose why a capability is weak, not generic suggestions)
- [ ] Predictive quality model with confidence bounds
- [ ] Confidence-scored LLM suggestions (weighted by data backing)
- [ ] Multi-run archival summaries (compress before lineage log eviction)

---

## Phase 3: Developer Experience (v2.3 — v2.5)

_Make it easy to build on._

### 3.1 Agent Development Tools

- [ ] Scaffolding CLI (`openrappter create agent <name>`)
- [ ] Agent testing framework — fixtures, mocks, assertions for agent contracts
- [ ] Watch mode for agent files — auto-reload on change
- [ ] Step-through debugging with breakpoints
- [ ] VSCode extension — metadata preview, inline test runner, agent graph visualization

### 3.2 API & Integration

- [ ] OpenAPI spec generation from agent metadata
- [ ] Webhook support — trigger agents from external HTTP callbacks
- [ ] Event bus — pub/sub for inter-agent communication without direct coupling
- [ ] Client SDK packages (`@openrappter/client` for TS, `openrappter-client` for Python)
- [ ] CLI plugin system — third-party commands installable via skills

### 3.3 Documentation

- [ ] Architecture decision records (ADRs)
- [ ] Agent cookbook — common patterns with working examples
- [ ] Migration guide between major versions
- [ ] Auto-generated API reference from source

### 3.4 Deployment

- [ ] Docker image (multi-stage, <100MB)
- [ ] Docker Compose for development (gateway + dashboard + storage)
- [ ] Kubernetes Helm chart
- [ ] Environment profiles (dev, staging, production)
- [ ] K8s health probes wired to gateway health endpoint

---

## Phase 4: Scale (v3.0 — v3.2)

_Run at production scale._

### 4.1 Distributed Execution

- [ ] Multi-node agent coordination — agents running across machines
- [ ] W3C trace context propagation for distributed tracing
- [ ] Agent registry service — central catalog across network nodes
- [ ] Message bus integration (Redis Streams, NATS, or RabbitMQ)
- [ ] Work queue — distribute invocations across worker nodes

### 4.2 Multi-Tenancy

- [ ] Tenant isolation — separate agent pools, memory, and sessions
- [ ] Usage quotas and rate limiting per tenant
- [ ] Tenant-scoped secrets management
- [ ] Admin dashboard for tenant CRUD

### 4.3 Storage at Scale

- [ ] PostgreSQL storage adapter
- [ ] Redis caching layer for hot data
- [ ] S3/blob storage for large artifacts (images, audio, generated files)
- [ ] Database migration tooling (up/down/rollback)

### 4.4 Performance

- [ ] Agent connection pooling
- [ ] Batch execution — vectorized operations for bulk agent calls
- [ ] Lazy agent loading — load on first invocation, not startup
- [ ] Memory pressure management — evict idle agents under load
- [ ] Horizontal auto-scaling (stateless gateway behind load balancer)

---

## Phase 5: Emergent Capabilities (v3.3+)

_Push the boundaries of what agent systems can do._

### 5.1 Swarm Intelligence

- [ ] Stigmergy — agents leave environmental signals that influence others
- [ ] Agent reputation and trust scores earned through outcomes
- [ ] Emergent specialization — agents develop roles from interaction patterns
- [ ] Collective memory — distributed knowledge store shared across the swarm

### 5.2 Meta-Learning

- [ ] Agent self-improvement — analyze own performance and adjust behavior
- [ ] Few-shot learning — acquire new tasks from minimal examples
- [ ] Capability transfer — trained skills migrate between agents
- [ ] Agent fusion — automatically combine agents into a more capable composite

### 5.3 Natural Language Composition

- [ ] "Build me an agent that..." — full conversational agent authoring
- [ ] "Connect these agents into a pipeline" — NL orchestration
- [ ] "What agents do I need for X?" — capability gap analysis
- [ ] Agent marketplace — publish, discover, install community agents

### 5.4 Edge & Hardware

- [ ] Mobile deployment (React Native or Capacitor shell)
- [ ] Raspberry Pi / IoT agent runtime
- [ ] GPU-accelerated inference for local models
- [ ] Offline-first mode — full functionality without internet

---

## Version History

| Version | Date | Highlights |
|---------|------|------------|
| **1.9.1** | 2026-02-22 | Multi-Rappter Gateway (hot-loadable souls), Agent Stock Exchange showcase, 2,803 tests |
| **1.9.0** | 2026-02-22 | Dashboard RPC parity (all 12 pages functional), 60+ RPC methods |
| **1.8.2** | 2026-02-22 | Python package exports, stale version fixes |
| **1.8.1** | 2026-02-22 | Python AgentGraph, 9 Python showcase ports, 11 new Python modules |
| **1.8.0** | 2026-02-17 | Python AgentChain/Graph/Tracer parity, chat methods |
| **1.7.0** | 2026-02-14 | 19 Showcase Prompts, Phoenix Protocol, showcase dashboard page |
| **1.6.0** | 2026-02-12 | AgentGraph, AgentTracer, MCP Server, Dashboard REST API |
| **1.5.0** | 2026-02-11 | AgentChain, LearnNewAgent TypeScript port |

---

## Principles

1. **Local-first** — runs on your machine, no cloud dependency required
2. **Single file = single agent** — metadata, docs, and code in one file. No YAML, no config files.
3. **Deterministic orchestration** — LLMs for thinking, code for coordination
4. **Language parity** — TypeScript and Python mirror each other
5. **Test-driven** — make a plan, write tests, build it, run until green, ship
6. **No magic** — native language constructs over DSLs and config parsing
