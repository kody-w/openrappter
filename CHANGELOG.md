# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
