# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.10.0] - 2026-07-11

### Added

- **Dual-use binary classification** (RAI hardening, closes audit must-fix #3's mechanism) — `exec-safety.ts` now tags network-fetch/install/arbitrary-exec/permission binaries (`curl`, `wget`, `pip`, `npm`, `npx`, `yarn`, `pnpm`, `node`, `python`, `tsx`, `chmod`, `chown`) via `DUAL_USE_BINS`; every `SafetyCheckResult` carries `dualUse` + `requiresApproval` so an approval layer can gate them (still `safe` under the default policy — backward-compatible). New opt-in `ExecSafety({ strictDefaults: true })` starts from the safe set minus dual-use binaries, so they return `safe: false, requiresApproval: true` unless explicitly re-added. Injection detection still precedes classification (a `curl … | sh` is blocked, not merely gated). `isDualUse()` helper; 6 new tests (suite 3109 → 3115).

### Added

- **Brainstem device-code auth** (kernel parity) — `POST /login` starts the GitHub device flow (same `COPILOT_CLIENT_ID` GitHub App as the RAPP kernel, producing `ghu_` tokens), `POST /login/poll` captures and persists the token in the kernel's `.copilot_token` JSON format (legacy plain-text reads supported), `GET /login/status` reports state. Token resolution: env → saved file → gh CLI (`gho_` OAuth tokens skipped — they 404 on the Copilot exchange, same lesson the kernel encodes). Copilot session now caches with `expires_at` + 60s buffer and re-exchanges when stale. 5 new auth-parity tests (Python suite 655 → 660).

### Added

- **OpenRappter Brainstem** (`python/openrappter/brainstem.py`, `python -m openrappter.brainstem`) — the local-device-first rappter: a stdlib-only (zero-dependency) HTTP server wire-compatible with the RAPP brainstem kernel so all training transfers. Same routes (`/chat`, `/health`, `/agents`, `/agents/import`, `/agents/export/<f>`, DELETE `/agents/<f>`, `/version`, `/models`), same JSON envelopes, same single-file agent contract with kernel-parity import shims (`agents.basic_agent` / `basic_agent` → OpenRappter's BasicAgent — the exact mirror of how the RAPP kernel shims `openrappter.agents.basic_agent`). Packaged OpenRappter agents form the default pool; user drop-ins in `~/.openrappter/brainstem/agents/` hot-load per request and override by name. `/chat` runs the Copilot tool loop (same token-exchange handshake as the kernel; `GITHUB_TOKEN` or `gh auth token`). Default port 7072 (`PORT=7071` for full drop-in). 8 wire-parity tests including a RAPP-authored agent dropping in unchanged and a full tool-loop round; verified live end-to-end with real Copilot on claude-sonnet-5. Also fixes a 30s `socket.getfqdn()` reverse-DNS hang per server bind on macOS.

### Added

- **Weighted sentiment words** (Roadmap 2.5 graduated scoring) — `SENTIMENT_WORD_WEIGHTS` intensity tiers (mild 0.5 / strong 1.0; flat word lists now derive from the map, preserving membership for the negation counter and input-difficulty scorer); generated `analyzeSentiment()` scores by weight, so "amazing" moves the needle twice as far as "good" and three milds barely offset one strong. Behavioral test executes the actual generated method (brace-extracted from catalog output), not a recomputation.

### Added

- **Simpson's Diversity Index** (Roadmap 2.5 graduated scoring) — generated `wordStats()` now reports `simpson_diversity` (1 − Σn(n−1)/N(N−1)) and `checkWordStats`'s `has_diversity` check uses it (threshold D >= 0.7, inclusive) instead of the raw unique/total ratio — repetition is weighted by frequency, so one dominant word is penalized even when many words are unique. E2E evolution test asserts the real generated capability emits valid entropy and Simpson values.

### Added

- **Character-level cipher verification** (Roadmap 2.5 graduated scoring) — `checkCaesarCipher` gains a `char_shift_valid` check that verifies every character is shifted by exactly ROT13 (case preserved, punctuation passed through); a transform that merely roundtrips (e.g. string reversal) now fails. Cipher denominator 3 → 4 checks; 3 new tests.

### Added

- **Soul-to-soul communication** (Roadmap 1.2) — agents invoked through a soul now receive a `_soul` handle in kwargs (`{ id, chain, summon(rappterIds, message, mode) }`) that summons sibling souls through the manager. An ancestry chain rides every nested invocation: summon cycles (a → b → a) are blocked, depth is capped at `MAX_SOUL_SUMMON_DEPTH` (3), and souls loaded without a manager degrade gracefully. 4 new tests.

### Added

- **`rappter.create` RPC** (Roadmap 1.2) — create and load a soul from a natural-language description: name inferred via LearnNewAgent's keyword convention (explicit name wins), kebab-case id with collision suffixing, and an auto-derived `systemPrompt` so identity injection carries the persona to agents; `persist: true` saves the config. `RappterManager.createSoul()` + 6 new tests; rappter RPC surface now 13 methods.

### Added

- **RAPP brainstem drop-in compliance harness** (`python/tests/test_brainstem_compliance.py`) — proves every `*_agent.py` in `python/openrappter/agents/` runs when dropped into a rapp-installer brainstem (kody-w/rapp-installer, per rapp-spine). Replicates the kernel's `_load_agent_from_file` contract in a clean subprocess per agent: kernel `BasicAgent` (vendored verbatim as a fixture), import shims exactly as the brainstem registers them, zero-arg instantiation, registration by `instance.name`, and `to_tool()` for the /chat loop. Unshimmed `openrappter.*` imports fail exactly as they would in a real brainstem (validated with a negative control). Result: **12/12 agent files compliant**; 13 new tests.

- **Input difficulty scoring** (Roadmap 2.5, completes the quick-wins block) — `scoreInputDifficulty(input)` rates per capability whether the input gives it a fair chance (word/unique-word minimums, alphabetic content, pattern categories present, sentiment-bearing words), with reasons listing exactly what's missing; `EvolutionReport` now carries `input_difficulty` so a weak capability score can be attributed to unfair input instead of a broken capability. 8 new tests.

- **Per-capability trajectory tracking with confidence gating** (Roadmap 2.5) — `EvolutionLineage` now includes `capability_trajectories`: an independent regression slope per capability, where a direction (improving/declining) is only reported when `|slope| > 2 × standard error` with 3+ data points — noisy histories read as stable instead of falsely trending. New `computeCapabilityTrajectories()` export; shared `linearRegression()` helper now backs the overall trajectory too.

### Fixed

- **Shared-agent context clobbering in parallel summons** — souls built from the default pool share agent instances, and `BasicAgent.execute()` stores per-invocation context on the instance; parallel `all`/`race` summons let one soul's context (including `soul_identity`) overwrite another's mid-invocation. Executions are now serialized per agent instance inside `RappterSoul.invoke` (distinct agents still run fully parallel).

- **Soul identity injection** (Roadmap 1.2) — a soul's identity (id, name, description, emoji, systemPrompt, model) now flows into every agent invocation via data sloshing as `upstream_slush.soul_identity`; previously `systemPrompt` and `model` were stored on the config but never used
  - New `SoulIdentity` type; `RappterSoul.identity` getter; `RappterSoulStatus` now includes `systemPrompt`
  - In chain mode each soul injects its own identity; optional fields are omitted when unset
  - 4 new tests in `rappter-manager.test.ts` (suite now 3081 tests)

- **OuroborosAgent scoring quick wins** (Roadmap 2.5) — two capability-assessment upgrades
  - Lexical entropy: generated `wordStats()` now reports Shannon entropy over the word frequency distribution; `checkWordStats` gains a `lexical_entropy` check (threshold H >= 2.0), making trivially repetitive input fail
  - Negation handling: generated `analyzeSentiment()` flips polarity for sentiment words preceded by a negator within a 2-token window ("not good" scores negative) and reports flipped words in `negated`; `checkSentiment(s, inputText)` gains a `negation_handled` check that independently recomputes expected flips from the input
  - Shared sentiment vocabulary (`SENTIMENT_POSITIVE_WORDS`, `SENTIMENT_NEGATIVE_WORDS`, `SENTIMENT_NEGATORS`) exported as single source of truth for generated agents and the judge
  - Denominators: word stats 5 → 6 checks, sentiment 4 → 5 checks; ouroboros suite 81 → 86 tests

### Fixed

- All 8 outstanding ESLint warnings (unused imports/variables in `twin-methods.ts`, `pii.ts`, `index.ts`, and 2 test files) — lint is now warning-free

- **Soul config persistence hardening** (Roadmap 1.2) — persistence is now backed by a dedicated `SoulStore` (`gateway/soul-store.ts`) with filename-safe ID validation (blocks path traversal via `saveSoulConfig`), config shape validation on load, corrupt-file tolerance, and an injectable souls directory for tests
  - `RappterManager` persistence methods (`saveSoul`, `saveSoulConfig`, `deleteSavedSoul`, `listSavedSouls`, `loadSavedSouls`) now delegate to `SoulStore`; new `restoreSouls()` reports restored/skipped/failed IDs; `loadSoul` gains a `persist` option
  - 4 new RPC methods: `rappter.save`, `rappter.persisted`, `rappter.restore`, `rappter.forget` (save/restore/forget require auth)
  - Gateway startup restores all persisted souls after loading the default soul
  - `soul-store.test.ts` — 27 new tests (store, manager integration, RPC end-to-end)

## [1.9.1] - 2026-02-22

### Added

- **Showcase #20: Agent Stock Exchange** — multi-round marketplace simulation where 3 analyst agents bid on 20 deterministic tasks across 4 categories (data/web/security/infra). Exercises AgentGraph, BroadcastManager, AgentRouter, and BasicAgent + data_slush simultaneously. Emergent specialization, reputation effects, and wealth distribution.
- **5 remaining UI-called RPC methods** registered in method files for MockServer/test parity
  - `chat.messages` — retrieve session messages with optional limit
  - `channels.send` — send a message via channel registry
  - `agents.files.read`, `agents.files.write` — read/write agent files via registry
  - `config.apply` — apply raw config with configManager or in-memory fallback
- 16 new tests across `dashboard-rpc.test.ts` and `gateway-rpc-methods.test.ts`
- Total test count: 2769 tests across 106 files

## [1.9.0] - 2026-02-22

### Added

- **Dashboard RPC parity**: All 12 UI pages now fully functional — 19 missing RPC methods registered
  - `chat.list`, `chat.delete` — session management for chat and sessions pages
  - `cron.list`, `cron.add`, `cron.enable`, `cron.run`, `cron.remove` — full CRUD for cron page
  - `skills.list`, `skills.toggle` — skill listing and enable/disable for skills page
  - `agents.list` — agent summary listing for agents page
  - `channels.list`, `channels.connect`, `channels.disconnect`, `channels.probe`, `channels.configure` — channel ops for channels page
  - `connections.list` — device listing for devices page
  - `status`, `health` — system info for debug and presence pages
- 3 new method files: `channels-methods.ts`, `connections-methods.ts`, `system-methods.ts`
- `dashboard-rpc.test.ts` — 30 new handler tests for all dashboard RPC methods
- Updated `gateway-rpc-methods.test.ts` — 25 → 55 tests covering 18 method groups
- Total test count: 2753 tests across 106 files

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
