# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.2] - 2026-02-22

### Fixed

- Stale version references in `CLAUDE.md` (1.6.0 → 1.8.0) and `skills.md` (1.4.0 → 1.8.0)
- Empty `__init__.py` files in 7 Python sub-packages now have proper exports with `__all__`

### Added

- Export tests for all 7 Python sub-packages (`test_module_exports.py`)
- CHANGELOG entries for v1.5.0–v1.8.1

## [1.8.1] - 2026-02-22

### Added

- **Parallel AgentGraph** execution in Python (`python/openrappter/agents/graph.py`)
- 9 Python showcase ports: Darwin's Colosseum, Infinite Regression, Ship of Theseus, Panopticon, Lazarus Loop, Agent Factory, Swarm Vote, Time Loop, Ghost Protocol
- 11 new Python modules: channels, config, gateway, mcp, memory, security, storage sub-packages
- 81 new Python tests across showcase and parity test suites
- Version bump to 1.8.1 in `package.json` and `pyproject.toml`

## [1.8.0] - 2026-02-17

### Added

- **Python parity**: `AgentChain`, `AgentGraph`, and `AgentTracer` ported to Python
- Chat methods for gateway WebSocket protocol
- 151 new tests across TypeScript and Python
- Swift agent fixes for actor isolation

## [1.7.0] - 2026-02-14

### Added

- **Phoenix Protocol**: Self-healing agent orchestration (32 tests)
- **19 Showcase Prompts**: Advanced agent orchestration patterns with runnable examples
  - The Architect, Ouroboros Accelerator, Swarm Debugger, Mirror Test, Watchmaker's Tournament
  - Living Dashboard, Infinite Regression, Code Archaeologist, Agent Compiler, Doppelganger
  - The Inception Stack, Data Sloshing Deep Dive, Memory Recall, Channel Switchboard
  - Config Hotswap, Persistence Vault, Healing Loop, Authorization Fortress, Stream Weaver
- Showcase dashboard UI page (`<openrappter-showcase>` Lit web component)
- Showcase RPC methods: `showcase.list`, `showcase.run`, `showcase.runall`
- 176 showcase tests (all deterministic, no LLM calls)

## [1.6.0] - 2026-02-12

### Added

- **AgentGraph**: DAG executor with parallel execution, topological sort, cycle detection, multi-upstream `data_slush` merging
- **AgentTracer**: Span-based observability for agent execution (start/end/duration/inputs/outputs)
- **MCP Server**: Expose agents as Model Context Protocol tools via JSON-RPC 2.0 over stdio
- **Dashboard REST API**: HTTP endpoints for web dashboard (`/api/agents`, `/api/traces`, `/api/status`)
- Python parity tests for broadcast, router, subagent patterns

## [1.5.0] - 2026-02-11

### Added

- **AgentChain**: Sequential pipeline with automatic `data_slush` forwarding, transforms, timeouts
- **LearnNewAgent TypeScript port**: Runtime agent generation with hot-loading, factory pattern
- LLM-powered agent description inference for LearnNewAgent
- 10 LearnNewAgent runtime generation prompts
- 10 agent chain prompts

## [1.4.0] - 2026-02-11

### Added

- **Single File Agent Pattern**: The defining architecture of openrappter
  - One file = one agent. Metadata contract, documentation, and deterministic code all in a single `.py` or `.ts` file
  - Native code constructors: Python dicts and TypeScript objects — no YAML, no config files, no magic parsing
  - `slush_out()` (Python) / `slushOut()` (TypeScript) — convenience helper for building `data_slush` dicts
  - `SubAgentManager` auto-chains `data_slush` between sequential sub-agent calls via `context.lastSlush`
  - `BroadcastManager` fallback mode passes `data_slush` from failed agents to the next in the chain
- **Single File Agent Manifesto**: RappterHub page explaining the standard
- All built-in agents use the native constructor pattern
- `LearnNewAgent` generates agents with native code constructors

## [1.3.0] - 2026-02-11

### Added

- **Data Slush**: Agent-to-agent signal pipeline
  - Agents can return a `data_slush` dict in their JSON output with curated signals from live results
  - `last_data_slush` (Python) / `lastDataSlush` (TypeScript) property on `BasicAgent` for accessing the most recent output
  - `upstream_slush` kwarg on `execute()` — automatically merged into `self.context['upstream_slush']` for downstream agents
  - Enables LLM-free agent chaining in sub-agent pipelines, cron jobs, and broadcast patterns
- `WeatherPoetAgent` — example agent demonstrating data_slush with live weather API integration and haiku generation
- `upstream_slush` field added to `AgentContext` type (TypeScript)

## [1.2.0] - 2026-02-05

### Added

- **Monorepo structure**: Separate `python/` and `typescript/` directories
- **TypeScript agent system**: Full port of Python agent pattern to TypeScript
  - `BasicAgent.ts` with data sloshing
  - `AgentRegistry.ts` for dynamic agent discovery
  - `ShellAgent.ts` and `MemoryAgent.ts` core agents
- Unified agent contract between Python and TypeScript
- `pyproject.toml` for Python packaging

### Changed

- Reorganized repository structure for dual-runtime maintenance
- Python package moved to `python/openrappter/`
- TypeScript source moved to `typescript/src/`
- Updated all documentation for monorepo structure
- Lowered Node.js requirement to 18+ (from 22+)

## [1.1.0] - 2026-02-05

### Added

- Dynamic agent discovery system (agents/ directory)
- BasicAgent base class following CommunityRAPP pattern
- Data sloshing for context enrichment
- Agent switching at runtime (`/agent <name>`, `/agents`)
- `--list-agents` and `--agent` CLI options

### Changed

- Renamed RAPPagent.py to openrappter.py
- Lowercase "rapp" throughout for readability
- Restructured to agents/ directory pattern

## [1.0.0] - 2025-02-05

### Added

- Initial release of openrappter
- GitHub Copilot SDK integration (no API keys needed!)
- Interactive chat mode
- Single task execution (`--task`)
- Persistent memory system
- Built-in skills: bash, read, write, list
- Custom skill support (YAML and Python)
- Onboarding wizard
- Python standalone version (openrappter.py)
- Full documentation and GitHub Pages site

### Technical

- Node.js 18+ required
- TypeScript with strict mode
- ESM modules
- Vitest for testing
