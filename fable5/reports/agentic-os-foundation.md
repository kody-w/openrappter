# Agentic OS Foundation — openrappter (Fable 5 use case #3 + Charlie Automates' 3 steps)

> Generated 2026-07-16. Blueprint for turning openrappter into your agentic OS: recurring tasks → skills → automations, mapped onto the repo's own primitives (Obsidian vault, agents, GitHub Actions).

## Overview

Agentic-OS foundation for openrappter = Fable-5 use-case #3 ("your repo becomes a self-operating product") realized via video2's 3-step method (brain -> builder -> publish), mapped ONLY onto primitives the repo already ships. No external tools are introduced. The three video2 steps bind to three existing layers:

- STEP 1 BRAIN = the openrappter-obsidian/ vault, upgraded from a static docs mirror into a live knowledge graph of Claude-Code usage, backed by the in-flight frontier-memory catalog (python/openrappter/memory/{store,projection,working_set,retrieval,embeddings,safety}.py). The vault's [[wikilink]] graph + the memory catalog's authoritative-JSON projection fence become one addressable brain.
- STEP 2 BUILDER = openrappter's own agents (LearnNewAgent, ProductivityStackAgent, DocScannerAgent, NotesIntakeAgent, CodeReviewAgent, GitAgent, WebAgent, DreamAgent) + the 6 orchestration patterns (chain/graph/router/broadcast/subagent/tracer) + MCP server + gateway. The builder consumes the brain and emits new agents/skills/automations. This is the self-hosting loop: openrappter builds openrappter.
- STEP 3 PUBLISH = the docs/ GitHub Pages site (kody-w.github.io), install.sh, macos/ menu-bar app, and release*.yml lanes — extended with a Pages deploy workflow and reskin-as-product path (local -> Pages -> Railway/Vercel). Publishing turns the whole loop into a shippable, reskinnable product.

The 5 audited candidate skills and 4 automations slot cleanly across these layers: Video-to-Prompts + CLAUDE-md-Generator + TS/Python-Parity-Check + Release-Reviewer are BUILDER skills; iMessage-Persona-Bot is a CHANNEL skill riding the real python/openrappter/imessage service and the imessage MCP plugin. The 4 automations are the CI/cron/hook glue that make the loop autonomous (event-driven iMessage responder, pre-release review gate, parity CI check, deliverable+notes persistence hook). Every element already has a home file in the repo; this design wires them, it does not invent them.

Key gaps confirmed by inspection (turn these into the roadmap's early wins): (1) no .github/workflows/pages.yml — Pages is served but never CI-deployed; (2) no named pre-release review gate or TS/Python parity gate as required checks; (3) vault Daily/ is empty and Templates/ has only 2 templates — the brain has no ingestion of actual Claude-Code sessions yet; (4) frontier-memory catalog exists but is not yet wired to the vault projection.

## Layer 1 — The Brain (video 2, step 1)

STEP 1 (brain) maps onto openrappter-obsidian/ extended into a knowledge graph of Claude-Code usage, backed by the frontier-memory catalog.

WHAT EXISTS: The vault already has 7 top-level sections (Architecture/, Agents/{Core,Specialized,Composition}/, Channels/, Guides/, Templates/, Project Planning/, Daily/) all cross-linked via [[wikilinks]] from Home.md (#moc #home). Templates/ ships Daily Note.md + New Agent Template.md. Daily/ is EMPTY. The frontier-memory branch adds a real memory catalog: python/openrappter/memory/store.py (catalog store), projection.py (RESERVED_METADATA_KEY authoritative-JSON projection fence, canonical_memory_path, authoritative_memory_lock), working_set.py (bounded USER_PROFILE / AGENT_MEMORY lanes with char budgets), retrieval.py, embeddings.py, safety.py (scan_memory_content, bounded_safe_label). Memory persists at ~/.openrappter/memory.json (Python) / memory.db (TS).

EXTENSION (do not invent, wire existing):
1. New vault section 'Claude Code Usage/' with sub-folders: Sessions/ (one note per Claude-Code session), Prompts/ (the 40 from PROMPTS.md, one note each, tagged #prompt/{basic,advanced,unhinged,learnnew}), Deliverables/ (artifacts produced), Failures/ (what broke + fix). Each note carries frontmatter (date, agent, tokens, outcome) so Obsidian Dataview-style queries work and the graph view shows prompt->agent->deliverable chains.
2. Bridge the catalog to the vault: the frontier-memory projection.py writes an authoritative JSON memory record; a thin projection emitter renders selected records into Claude Code Usage/Sessions/*.md so the vault becomes a HUMAN-READABLE VIEW of the memory catalog while the JSON stays authoritative (projection fence prevents drift). working_set.py's USER_PROFILE lane = the persona/preferences the brain surfaces; AGENT_MEMORY lane = per-agent episodic memory shown in Agents/*/Memory.md.
3. DreamAgent (already exists, TS) = nightly memory consolidation (Prompt #14 Dream Mode): reads the day's Sessions/ notes, clusters, writes a Daily/ consolidation note + updates Project Planning/Roadmap.md deltas. This fills the empty Daily/ folder automatically.
4. Data-sloshing memory_echoes already read from this store, so every agent action is enriched by the brain — the graph is not passive documentation, it is the live context source (getSignal('memory_echoes.*')).

The brain is thus a bi-layer: authoritative JSON catalog (machine, fenced) + Obsidian graph (human, wikilinked), kept consistent by the projection fence. This is exactly the 'second brain' video2 step1 describes, but native to openrappter.

## Layer 2 — Skills

STEP 2 (builder) skills layer — all 5 audited skills map to EXISTING agents/patterns; each becomes a SKILL.md in ~/.openrappter/skills/ wrapped as a ClawHubSkillAgent, invoking core agents:

1. VIDEO TO PROMPTS — Skill that takes a video/transcript URL, runs WebAgent (web_agent.py / WebAgent.ts) to fetch/transcribe, then LearnNewAgent to distill it into new PROMPTS.md-style power prompts + optionally generate the agents they need. This is the meta-loop that produced THIS task; it feeds new entries into brain's Prompts/ folder. Pattern: AgentChain(fetch -> extract -> LearnNew) with data_slush forwarding.

2. CLAUDE MD GENERATOR — Skill wrapping DocScannerAgent (DocScannerAgent.ts) + CodeReviewAgent to scan a target repo/subtree and emit/refresh a CLAUDE.md (the repo's own 37KB CLAUDE.md is the reference format). Runs as AgentChain(scan -> summarize -> write). Keeps CLAUDE.md in sync with the codebase; brain's Architecture/ notes are a downstream projection.

3. TS PYTHON PARITY CHECK — Skill that diffs the parallel implementations named in CLAUDE.md's Language Parity table (BasicAgent.ts<->basic_agent.py, chain.ts<->chain.py, graph.ts<->graph.py, etc.) using ShellAgent to run both test suites (npx vitest + pytest) and CodeReviewAgent to flag drift. Emits a parity report note into the brain. This is the human-invocable twin of the parity CI automation.

4. RELEASE REVIEWER — Skill wrapping CodeReviewAgent + GitAgent to review a release candidate diff (git diff main...HEAD), summarize risk, verify CHANGELOG/version bumps, and gate. Invocable locally before tagging; its CI twin is the pre-release review gate automation. Uses the AgentGraph pattern to fan out (security/perf/parity reviewers) then fan in to a verdict.

5. IMESSAGE PERSONA BOT — Channel skill riding the REAL service at python/openrappter/imessage/service.py + the imessage MCP plugin (reply / chat_messages tools, scoped by allowlist). Loads a Soul Template (vault Guides/Soul Templates.md — 10 personas) as the persona, pulls context from the brain (working_set USER_PROFILE lane), and replies in-character. MemoryAgent persists the conversation back into the brain. NOTE: access/pairing stays user-controlled via /imessage:access — the bot never self-approves.

Each skill is one file, follows the single-file-agent contract, and is discoverable via RappterHub/ClawHub. The builder's superpower: LearnNewAgent can GENERATE the deterministic scaffolding for skills 1-4 at runtime from a description, so the skills layer is itself self-extending.

## Layer 3 — Automations

STEP 2 (builder) automations layer — the 4 automations are the autonomous glue; each maps to an EXISTING CI workflow, cron, or hook primitive:

1. EVENT-DRIVEN IMESSAGE RESPONDER — Not CI; a channel event loop. The imessage MCP plugin already delivers inbound <channel source=imessage ...> events; the python/openrappter/imessage/service.py runs as the daemon (macos/ menu-bar app can host it). Wire an AgentRouter (router.py) rule: on inbound message -> route to the iMessage Persona Bot skill -> reply via the reply tool. SelfHealingCronAgent supervises the listener (restart on silent failure — Prompt #6 / the healing-loop demo). Access policy stays enforced by allowlist; the responder only acts on allowlisted chats. This is the always-on front door to the whole OS.

2. PRE-RELEASE REVIEW GATE CI — New required job added to release.yml (which already fires on tags v* !v*-bar). Before the existing preflight/build, run the Release Reviewer skill headlessly (CodeReviewAgent + GitAgent over git diff of the tag range) and FAIL the release if risk verdict is high or CHANGELOG/version drift is detected. scripts/release-preflight.mjs already exists as the hook point — extend it, don't replace it. Least-privilege (contents: read) matches the repo's existing permission posture.

3. TS PYTHON PARITY CI CHECK — New job in the reusable ci.yml (already runs on push/PR to main and via workflow_call). Runs the TS Python Parity Check skill: executes npx vitest run src/__tests__/parity/*.test.ts AND pytest python/tests/, then asserts the CLAUDE.md parity-pair files exist on both sides and their parity tests pass. Becomes a REQUIRED status check on main so drift can't merge. This directly protects the dual-runtime invariant the whole framework depends on.

4. DELIVERABLE AND NOTES PERSISTENCE HOOK — A Stop/PostToolWrite-style hook (configured via settings.json, per the update-config skill) that fires after each Claude-Code session or agent run: NotesIntakeAgent (NotesIntakeAgent.ts) captures the session's deliverables + notes, MemoryAgent writes them to the frontier-memory catalog (authoritative JSON, projection-fenced), and the projection emitter renders a note into brain's Claude Code Usage/{Sessions,Deliverables}/. This CLOSES THE LOOP: every build feeds the brain, so step2 continuously enriches step1. CronAgent/CronCreate can also schedule the DreamAgent nightly consolidation described in the brain layer.

Together these make the OS self-operating: iMessage is the input, agents+patterns are the compute, CI gates protect quality, and the persistence hook feeds results back into the brain for the next cycle.

## Layer 4 — Publish (video 2, step 3)

STEP 3 (publish) — local vs kody-w.github.io / Railway / Vercel, reskin-as-product. Maps onto docs/, install.sh, macos/, and release*.yml.

WHAT EXISTS: docs/ is a full static site (index.html, docs.html, architecture.html, changelog.html, blog/ with 9 posts, styles.css, nav.js, .nojekyll) intended for GitHub Pages at kody-w.github.io/openrappter. install.sh (86KB, also mirrored at docs/install.sh) is the one-line installer. macos/ ships a Swift menu-bar app (Package.swift, homebrew/) with its own release-bar.yml tag lane (v*-bar). release.yml handles npm/pypi package tags (v* !v*-bar). Remotes: origin=github.com/kody-w/openrappter (canonical/upstream), fork=github.com/rappter2-ux/openrappter (this working fork).

CONFIRMED GAP: there is NO .github/workflows/pages.yml — the docs/ site is committed but never CI-deployed to Pages. That is the #1 publish quick win.

PUBLISH TIERS (progressive, reskin-as-product):
- TIER 0 LOCAL: `./quickstart.sh` + gateway (ws://127.0.0.1:18790) + UI (localhost:3000) + macos menu-bar app. Zero-cloud, local-first, works today. This is the default 'run your own OS' story.
- TIER 1 GITHUB PAGES (kody-w.github.io): add pages.yml that publishes docs/ on push to main. The brain (openrappter-obsidian/) can ALSO be published here as a static graph site (Obsidian Publish-style export or a lightweight HTML export of the vault) so the knowledge graph becomes a public product surface. Free, static, no server.
- TIER 2 RAILWAY / VERCEL: for anything needing a running gateway/MCP server (the WebSocket gateway, MCP-over-HTTP, the dashboard REST API in typescript/src/gateway/dashboard.ts). Add a Vercel config for the static UI + serverless API routes, and/or a Railway service using the existing Dockerfile + docker-compose.yml (both already in repo root). This hosts the always-on responder + gateway when the user does not want a local daemon.

RESKIN-AS-PRODUCT: the dashboard UI (typescript/ui/, Lit) + docs/ site are themeable. A reskin = swap styles.css + Soul Template + branding, point install.sh at the fork, and ship as a differentiated product on the same engine. The showcase page (openrappter-showcase) already demonstrates 20 patterns in-browser — that IS the product demo surface. Publishing the brain graph + the showcase together = a complete, credible 'agentic OS' product page, all from existing files.

Recommendation order: Pages first (static, free, closes the docs gap), then Railway via existing Dockerfile for the always-on gateway/iMessage responder, Vercel optional for a marketing-grade UI reskin.

## Phased roadmap

### Phase 0 — Wire the Brain (Week 1) — Turn openrappter-obsidian/ from static docs into a live Claude-Code-usage knowledge graph backed by the frontier-memory catalog, and close the vault<->catalog gap.

- Merge/land the frontier-memory branch (python/openrappter/memory/{store,projection,working_set,retrieval,safety}.py) so the authoritative-JSON memory catalog is the brain's backing store.
- Add vault section 'Claude Code Usage/' with Sessions/ Prompts/ Deliverables/ Failures/ subfolders and frontmatter (date, agent, tokens, outcome); add a Template for each.
- Backfill Prompts/: script one note per entry in PROMPTS.md (40) tagged #prompt/{basic,advanced,unhinged,learnnew}, wikilinked to the agents each uses (from Agent Index.md).
- Write the projection emitter that renders selected authoritative memory records into Sessions/*.md, guarded by projection.py's fence (canonical_memory_path + authoritative_memory_lock) so JSON stays source of truth.
- Verify memory_echoes data-sloshing reads from the catalog so every agent is enriched by the brain (getSignal('memory_echoes.*')).

### Phase 1 — Builder Skills (Week 2) — Ship the 4 builder skills as single-file SKILL.md agents wrapping existing core agents; prove the self-hosting loop.

- CLAUDE md Generator: AgentChain(DocScannerAgent -> summarize -> ShellAgent.write) that regenerates CLAUDE.md; run it against a subtree to validate output matches the existing format.
- Video to Prompts: AgentChain(WebAgent.fetch -> LearnNewAgent.distill) emitting new Prompts/ notes + optional generated agents; dogfood it on this very task's source video.
- TS Python Parity Check: skill running npx vitest src/__tests__/parity/*.test.ts + pytest python/tests/, asserting every CLAUDE.md parity-pair file exists on both sides; emit a parity note to the brain.
- Release Reviewer: AgentGraph fan-out (security/perf/parity reviewers via CodeReviewAgent+GitAgent) -> fan-in verdict over git diff main...HEAD.
- Register all 4 via RappterHub/ClawHub; use LearnNewAgent to auto-scaffold the deterministic parts.

### Phase 2 — Automations / Autonomy (Week 3) — Make the loop self-operating: input via iMessage, quality via CI gates, feedback via persistence hook.

- Deliverable+Notes persistence hook: settings.json Stop-hook -> NotesIntakeAgent captures deliverables -> MemoryAgent writes to catalog -> projection emitter updates brain. Closes step2->step1 loop.
- TS Python parity CI check: add job to reusable ci.yml (runs on push/PR + workflow_call), make it a REQUIRED status check on main.
- Pre-release review gate CI: extend scripts/release-preflight.mjs + add a job in release.yml that runs Release Reviewer headlessly and fails on high-risk verdict or CHANGELOG/version drift.
- Nightly DreamAgent consolidation via CronCreate: reads day's Sessions/, clusters, writes Daily/ note + Roadmap deltas (fills the empty Daily/ folder).

### Phase 3 — iMessage Persona Front Door (Week 4) — Stand up the always-on conversational entry point on the real iMessage service, brain-aware and persona-driven.

- iMessage Persona Bot skill: load a Soul Template (Guides/Soul Templates.md) as persona, pull USER_PROFILE lane from working_set.py for context.
- Event-driven responder: AgentRouter rule routes inbound imessage MCP events -> Persona Bot -> reply tool; MemoryAgent persists convo to brain.
- Wrap the listener in SelfHealingCronAgent (restart on silent failure); host via macos/ menu-bar app or the daemon.
- Keep access user-controlled: pairing/allowlist only via /imessage:access; responder acts only on allowlisted chats; never self-approve.

### Phase 4 — Publish & Reskin-as-Product (Week 5) — Ship the 3-tier publish path and the reskinnable product surface.

- Add .github/workflows/pages.yml to deploy docs/ to kody-w.github.io on push to main (closes the confirmed Pages gap).
- Export the brain (openrappter-obsidian/) as a static graph site published alongside docs/ so the knowledge graph is a public product surface.
- Add Railway service (existing Dockerfile + docker-compose.yml) to host the always-on gateway + iMessage responder for cloud users; optional Vercel config for the UI reskin + serverless dashboard API.
- Reskin-as-product: parameterize styles.css + Soul Template + branding + install.sh target; ship the showcase page (20 patterns) + brain graph as the product demo.
- Tag a release through the now-gated release.yml to prove pre-release review + parity gates block bad releases.

## Quick wins

- Add .github/workflows/pages.yml to deploy docs/ to kody-w.github.io on push to main — the site already exists (index.html, blog/, .nojekyll) but is never CI-deployed. Highest ratio of value to effort.
- Create the empty vault section: openrappter-obsidian/Claude Code Usage/{Sessions,Prompts,Deliverables,Failures}/ + a Prompts template, and backfill the 40 PROMPTS.md entries as individual wikilinked notes so the Obsidian graph view immediately shows prompt->agent chains.
- Add the TS/Python parity job to ci.yml (it already runs vitest+pytest infrastructure; just add a step that runs src/__tests__/parity/*.test.ts + python/tests/ and checks the CLAUDE.md parity-pair files exist) and mark it a required check.
- Wrap CLAUDE md Generator as an AgentChain(DocScannerAgent -> ShellAgent.write) — both agents already exist — to keep the 37KB CLAUDE.md in sync automatically.
- Land the frontier-memory branch's memory catalog (store/projection/working_set already written) and point data-sloshing memory_echoes at it, so every agent instantly gets brain-backed context with no new code.
- Add the deliverable+notes persistence Stop-hook via settings.json (update-config skill) using the existing NotesIntakeAgent + MemoryAgent — one hook closes the build->brain feedback loop.
- Schedule the existing DreamAgent nightly via CronCreate to auto-populate the currently-empty Daily/ folder with consolidation notes.
- Extend scripts/release-preflight.mjs (already the release hook point) to invoke CodeReviewAgent over git diff main...HEAD as the first version of the pre-release review gate before wiring it into release.yml.
