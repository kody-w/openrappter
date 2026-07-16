# What's Worth Assimilating Into openrappter

> Generated 2026-07-16 by an 8-agent deep-read + synthesis workflow. Sources: local clones of OpenClaw, Hermes Agent, Pi, OpenHands (read as real source) + Claude Code (docs/knowledge). Framed against what openrappter already has.

## TL;DR — Top 3 bets (from the adversarial critique)

1. BET 1 -- AB-01 catalog parity, but re-scoped correctly: FIRST build a cross-runtime golden-scoring fixture from the existing Python implementation (RRF scores, tie-breaks, working-set projection, deterministic hash-embedding fallback), THEN port module-by-module, THEN collapse BOTH TS memory surfaces (MemoryManager stub AND MemoryAgent's memory.json) onto the ported catalog so the actual runtime benefits. Without the fixture-first step and the MemoryAgent rewire, this is a port nobody feels. This is the correct #1 -- the parity asymmetry is real and verified -- but only if scoped to the real consumer.
1. BET 2 -- AB-04 + AB-08 merged into one durability workstream (write-intent-before-effect, tombstone-on-complete, reconcile-on-boot) shared across egress and ingress on the existing SQLite migration engine. Confirmed zero recovery/delivery markers exist today, so an interrupted turn is genuinely lost -- this is the single biggest correctness gap and it is fully local-first. Merging them pays the idempotency-hash + schema design cost once.
1. BET 3 -- AB-09 provider-family compat helpers (S, mechanical, one pass both runtimes). Highest effort/impact ratio in the backlog and it directly serves the Copilot-multi-family backbone by killing per-provider drift now, before more providers are added. Cheap insurance that the plan under-ranks at priority 9. (Deliberately NOT betting on AB-07 ACP client -- it is the one item that genuinely fights the local-first + stdlib-brainstem architecture.)

**Critique verdict:** The synthesis is directionally correct and unusually honest for a competitive-assimilation doc -- its central thesis (openrappter already leads on memory; the win is TS parity plus operational-durability patterns, not copying OpenClaw's cloud-heavy features) is verified true. The Python catalog is real, substantive (7,183 lines of actual code in store.py, real RRF with tunable k/phrase/identifier bonuses/cosine floor, tested with ~150 memory tests), not padded. The TS side is genuinely a naive stub. The doNotAssimilate list is the document's strongest section -- correctly rejects LanceDB, Docker/SSH sandboxes, cloud voice, Canvas, and media-gen on sound local-first grounds. BUT three things undercut the ranking: (1) AB-01's 'transformational' rating and its de-risking plan both assume a cross-runtime scoring contract test that does NOT exist (contract-compat has only 2 non-scoring tests) and ignore that the real runtime consumer is MemoryAgent's separate memory.json, not the MemoryManager stub the plan targets -- so the port as scoped is invisible to users; (2) AB-04 and AB-08 are the same idempotency mechanism double-counted as two items; (3) AB-07 ACP client is mislabeled local-first -- it is outbound external-service coupling that fights the verified stdlib-only brainstem contract, and 'opt-in' does not resolve that. Fix the scoping on AB-01, merge AB-04/08, demote AB-07, and promote AB-09 (best effort/impact ratio, under-ranked), and this becomes an executable plan rather than a compelling narrative.

## Synthesis summary

OpenRappter already leads competitors on memory: the Python openrappter memory catalog is a real frontier-memory system with authorization-scoped SQLite, checksummed migrations with collision certification, hybrid RRF lexical plus semantic retrieval, deterministic bounded working-set projection, authoritative-JSON projection fencing, and injection safety scrubbing bidi and invisible unicode. It also already has a two-phase plugin loader (manifest discovery without code exec), a hooks registry, a SKILL.md skills system, a versioned gateway protocol with a hello-ok snapshot, Copilot device-code auth as the LLM backbone, and checksummed storage migrations. The highest-leverage assimilation is not to copy OpenClaw memory. It is to bring the TypeScript runtime to parity with the Python catalog since TS memory is a naive hybrid-search stub, and to selectively adopt the operational-durability and lifecycle patterns competitors have that openrappter lacks: durable restart recovery plus idempotent delivery, durable spool ingress with dead-lettering, a deeper typed hook lifecycle, doctor fix config repair, an active-memory circuit-breaker cache around recall, typed message presentation actions, provider-family compat helpers, and an ACP client agent. Cloud and heavy features such as LanceDB, Docker or SSH sandboxes, realtime-voice cloud APIs, Canvas native apps, and media generation pipelines either duplicate what openrappter already does locally or violate its local-first plus Copilot-backbone philosophy and are excluded. The backlog is ranked by leverage of impact over effort; TS and Python parity implications are called out per item since openrappter maintains mirrored runtimes. Key file anchors: python openrappter memory store retrieval working_set projection safety migrations are the source of truth for AB-01; typescript src memory manager is the naive stub to replace; typescript src hooks registry and types are the extension point for AB-03; typescript src gateway server and channels base plus python storage adapter are the anchors for AB-04 and AB-08; typescript src cli doctor and config migrations for AB-05.

## Cross-cutting themes

### Durable idempotent execution across restart
_Seen in: OpenClaw restart recovery, OpenClaw durable spool, OpenHands event stream, Claude Code resumable sessions_

Competitors write a recovery claim before inference and a delivery intent before send, then reconcile on boot. OpenRappter has neither marker, so an interrupted turn is lost and a crash after send is ambiguous.

### Typed lifecycle hooks with decision propagation
_Seen in: OpenClaw agent and tool and compaction hooks, Claude Code PreToolUse and PostToolUse_

Competitors influence behavior at fine-grained boundaries via typed accept reject pass-through. OpenRappter HookRegistry has only 10 coarse phases and no decision object, so a plugin cannot gate a tool call or inject memory before generation.

### Config as a self-repairing plugin-owned contract
_Seen in: OpenClaw doctor fix and legacy rules, Claude Code settings migration_

Competitors repair legacy config with backup before boot. OpenRappter has additive-only migrations and a read-only doctor, so drift accumulates with no forcing function to normalize config before startup.

### Memory as a resilient authorization-first service
_Seen in: OpenClaw active-memory circuit breaker, OpenClaw lancedb corpus visibility_

OpenRappter Python catalog already exceeds most of this. The gaps are the recall-time resilience wrapper and the session-corpus visibility split, plus the catalog not existing in the TS runtime.

### Inter-agent interop via a stable protocol
_Seen in: OpenClaw ACP sdk, Claude Code MCP client and subagents_

Competitors bridge local agents to external agent servers. OpenRappter has an MCP server but no client agent, so it cannot call an external Claude app or agent server as a tool.

### Channel intent typed and ingress durable
_Seen in: OpenClaw typed presentation actions, OpenClaw durable spool with tombstoning_

OpenClaw never infers intent from string patterns and never loses an inbound message on restart. OpenRappter encodes actions less structurally and has no durable ingress spool.

### Provider-family reuse over per-provider drift
_Seen in: OpenClaw shared family-level helpers_

OpenRappter has per-provider files with failover but no shared family-level helpers, so the same compat patch is re-implemented per provider and drifts.

## Assimilation backlog (ranked by leverage)

| # | Feature | Sources | Effort | Impact | Where it lands |
|---|---------|---------|--------|--------|----------------|
| 1 | TypeScript frontier-memory catalog parity | openrappter python memory, OpenClaw memo | XL | transformational | TS: new memory catalog, retrieval, working-set, projection,  |
| 2 | Active-memory recall resilience wrapper | OpenClaw active-memory recall circuit br | M | high | Python: new memory recall guard wrapping retrieval, consumed |
| 3 | Deeper typed hook lifecycle | OpenClaw tool and compaction and session | L | high | TS: hooks types phase enum and decision, hooks registry plus |
| 4 | Durable restart recovery plus idempotent delivery | OpenClaw restart recovery and sentinel a | L | high | TS: gateway recovery module plus a delivery-intent guard in  |
| 5 | Doctor fix config migration and repair | OpenClaw doctor fix and legacy config ru | M | medium | TS: extend cli doctor with a fix path, config migrations rep |
| 6 | Typed message presentation actions | OpenClaw message presentation typed acti | M | medium | TS: channels types presentation action union on OutgoingMess |
| 7 | ACP client agent | OpenClaw acp-core and ACP sdk | L | medium | TS: agents ACP client agent plus optional acp transport modu |
| 8 | Durable spool ingress with retry and dead-lettering | OpenClaw Telegram durable spool pattern | L | medium | TS: channels spool consumed by webhook plus polling channels |
| 9 | Provider-family compat helpers | OpenClaw shared family-level helpers | S | medium | TS: new providers families helpers imported by openai anthro |
| 10 | Sessions-vs-memory corpus visibility split | OpenClaw session transcript visibility r | S | low | Python: extend memory store scope and retrieval filter; wire |

### 1. TypeScript frontier-memory catalog parity  
`effort:XL · impact:transformational · sources:openrappter python memory, OpenClaw memory-core`

- **Fit:** Parity obligation: openrappter maintains mirrored runtimes. Python has the scoped catalog, RRF retrieval, projection, working-set, safety; TS memory is a naive stub. Closes the biggest capability asymmetry and is fully local-first.
- **What to build:** Port the Python catalog to TS: MemoryAccessScope and MemoryCatalog with scoped reads and writes, immutable source events plus rebuildable derivatives, idempotency optimistic-revision and tombstone errors; RRF hybrid retrieval with lexical and semantic weights and exact-phrase and identifier bonuses and cosine floor; deterministic bounded working-set projection; projection fencing; injection-safety scan. Reuse the existing checksummed storage migration engine.
- **Where it lands:** TS: new memory catalog, retrieval, working-set, projection, safety, migrations modules mirroring the python ones; rewire memory manager and index; extend storage migrations. Python already done. Add TS parity tests mirroring python catalog and contract-compat tests.
- **Parity:** This is the parity work: Python is ahead, TS must catch up on shared fixtures.
- **Risks:** Largest port; scoring must be deterministic across runtimes or the contract test diverges; FTS5 availability differs between node and Python sqlite, needing a graceful fallback. Mitigate by porting module-by-module behind the cross-runtime fixture.

### 2. Active-memory recall resilience wrapper  
`effort:M · impact:high · sources:OpenClaw active-memory recall circuit breaker and caching`

- **Fit:** Wraps the recall path so a slow or failed retrieval never stalls a turn. Pure-local, no new deps. Reuses contamination scrubbing openrappter already ships.
- **What to build:** A recall facade: per-scope circuit breaker opening after N failures with half-open probe, a bounded timeout with empty successful fallback, request de-duplication of identical concurrent recalls, and a small TTL result cache keyed by scope and query hash and ranking version.
- **Where it lands:** Python: new memory recall guard wrapping retrieval, consumed by context memory agent. TS: new memory recall guard wrapping the AB-01 retrieval module, consumed by MemoryAgent. Tests: python recall-guard test plus a TS parity test.
- **Parity:** Build both together. Depends on AB-01 for the TS half; Python half ships immediately.
- **Risks:** Cache invalidation must key on ranking version and working-set snapshot revision or stale results leak after consolidation. Circuit-breaker state is per-process only, fine for local-first.

### 3. Deeper typed hook lifecycle  
`effort:L · impact:high · sources:OpenClaw tool and compaction and session hooks, Claude Code PreToolUse and PostToolUse`

- **Fit:** openrappter has HookRegistry but only coarse phases. Extending the phase enum and adding an accept reject replace HookResult unlocks memory-injection-before-generation and tool gating that aligns with ApprovalManager.
- **What to build:** Add phases for agent reply before, tool before and after, tool result before, compaction, and session create end and reset. Give HookResult a typed decision threaded through the executor so a hook can veto or mutate a tool call or inject context before the LLM sees the prompt. Wire into BasicAgent and the brainstem tool loop.
- **Where it lands:** TS: hooks types phase enum and decision, hooks registry plus a new executor, call sites in BasicAgent and gateway server tool dispatch. Python: new hooks package which does not exist yet, invoked from basic agent and brainstem run chat. Tests: hook-lifecycle parity tests.
- **Parity:** TS has a partial system; Python has none. Both tool loops must be instrumented.
- **Risks:** Threading decisions through the brainstem tool loop without breaking the RAPP kernel wire-compat contract; a rejecting hook must produce a well-formed tool result. Python has no hooks package yet so this is net-new there.

### 4. Durable restart recovery plus idempotent delivery  
`effort:L · impact:high · sources:OpenClaw restart recovery and sentinel and config-reload recovery`

- **Fit:** openrappter persists to SQLite and runs a long-lived gateway, so recovery claims and delivery intents are a bounded schema addition, fully local, making restart mid-session safe.
- **What to build:** Two tables via the migration engine: recovery claims with session and turn id written before inference and cleared on finalize; delivery intents with channel and conversation id and message hash and state pending to delivered written before send. On boot scan stale claims and re-dispatch with a synthetic interrupted message; reconcile unknown delivery intents fail-closed. Add graceful drain on shutdown.
- **Where it lands:** TS: gateway recovery module plus a delivery-intent guard in the channels base send wrapper, new storage migrations, boot scan in gateway server. Python: new gateway recovery module plus storage adapter migration and brainstem boot scan; channels base send guard. Tests: crash-mid-turn and crash-after-send parity tests.
- **Parity:** Schema and reconciliation must match so a DB from one runtime is recoverable by the other. Ship in both storage layers together.
- **Risks:** Idempotency hash must be stable across restarts. Fail-closed on unknown delivery may leave a sent message unmarked, acceptable since a missed dedup beats a duplicate text. Must not break the brainstem stdlib HTTP model.

### 5. Doctor fix config migration and repair  
`effort:M · impact:medium · sources:OpenClaw doctor fix and legacy config rules`

- **Fit:** openrappter has doctor read-only checks, additive migrations, and Zod schemas. This upgrades doctor from report to repair and lets plugins declare legacy-config rules, matching the inline-resolution UX principle.
- **What to build:** A fix mode that runs additive migrations and legacy-shape repairs renaming or moving deprecated keys, backs up the original before writing, re-validates against the schema, and lets each plugin manifest contribute a legacy rules array. Extend the manifest schema with a compat block for min gateway version and config-api range.
- **Where it lands:** TS: extend cli doctor with a fix path, config migrations repair rules and backup, plugins manifest compat and legacy rules fields. Python: add a config migrations and repair module since Python config is thinner, CLI wiring. Tests: doctor-fix parity tests plus a broken-config fixture.
- **Parity:** TS config is ahead; do TS-first then Python follow-up.
- **Risks:** Repair must be non-destructive and idempotent. Plugin rules run untrusted transforms so restrict to pure data transforms never exec. Python config is less built-out so more net-new there.

### 6. Typed message presentation actions  
`effort:M · impact:medium · sources:OpenClaw message presentation typed actions`

- **Fit:** openrappter has more than 20 channels and an ApprovalManager. Declaring typed actions before encoding removes per-channel string inference and lets each channel render native affordances or degrade gracefully.
- **What to build:** A transport-agnostic presentation action union covering approval command URL web-app select and multiselect on OutgoingMessage; BaseChannel maps actions to native affordances with a plain-text fallback. Preserve raw callback values exactly and keep callback data transport-private. Route approvals into ApprovalManager.
- **Where it lands:** TS: channels types presentation action union on OutgoingMessage, base default text-fallback encoder, per-channel overrides in telegram slack discord, wire approvals to ApprovalManager. Python: channels base plus types and imessage service. Tests: encode and fallback parity tests.
- **Parity:** Both runtimes have parallel channel sets; the union and fallback must match.
- **Risks:** Retrofitting all channels is broad; ship the base contract plus text fallback first, then upgrade high-traffic channels. Callback-value round-trip is easy to corrupt.

### 7. ACP client agent  
`effort:L · impact:medium · sources:OpenClaw acp-core and ACP sdk`

- **Fit:** openrappter is an MCP server but cannot call an external agent server. An ACP or MCP client agent lets local reasoning compose with external Claude apps on demand, local-first since you opt in per call.
- **What to build:** An ACP client single-file agent that opens a session to a configured endpoint, maps request response streaming and artifacts into the tool-loop result plus data slush, registered like any other agent so it appears as a tool. Reuse MCP client plumbing if simpler than a full ACP SDK.
- **Where it lands:** TS: agents ACP client agent plus optional acp transport module. Python: new acp client agent plus acp package. Register in AgentRegistry and brainstem agent pool. Tests: mock-server parity tests.
- **Parity:** Python client should be stdlib-only while TS may use the SDK; behavior must match on the tool-result shape.
- **Risks:** Adds an external protocol dependency in TS; Python may need a hand-rolled client to honor the brainstem zero-dependency rule. Streaming and artifact mapping is fiddly. Keep it opt-in and off by default.

### 8. Durable spool ingress with retry and dead-lettering  
`effort:L · impact:medium · sources:OpenClaw Telegram durable spool pattern`

- **Fit:** Complements AB-04 on the inbound side: channels process inbound messages in-memory today. A durable spool that stores before process and advances offset only after adoption makes ingress crash-safe. Local SQLite, no new infra.
- **What to build:** A generic inbound spool over the storage adapter that persists inbound events on receipt, processes then adopts into a session turn then advances offset; tombstones completed rows so redelivery is a no-op; a single retry policy with age-based dead-lettering; a pre-adoption watchdog that does not kill healthy long turns.
- **Where it lands:** TS: channels spool consumed by webhook plus polling channels like telegram and imessage proxy, storage tables via migrations. Python: new channels spool module consumed by webhook plus imessage service, storage adapter migration. Tests: redelivery-idempotency and dead-letter parity tests.
- **Parity:** Spool schema shared via the migration engine; retry and dead-letter constants must match.
- **Risks:** Watchdog must use adoption timestamp not turn duration. Over-broad tombstoning could suppress legitimate re-sends. Start with Telegram and iMessage.

### 9. Provider-family compat helpers  
`effort:S · impact:medium · sources:OpenClaw shared family-level helpers`

- **Fit:** openrappter has per-provider files with failover but no shared family-level helpers; the Copilot backbone proxies multiple families so a single normalize and stream-wrap layer reduces drift.
- **What to build:** Extract family-level helpers: an OpenAI-style tool-payload wrapper, a Gemini tool-schema normalizer, and a shared stream-wrapping and replay policy imported by the concrete providers. Expose from the provider registry.
- **Where it lands:** TS: new providers families helpers imported by openai anthropic gemini copilot and referenced from registry. Python: new providers families module imported by openai compatible and registry. Tests: family-helper unit tests.
- **Parity:** Small and mechanical; do both runtimes in one pass. Python surface is thinner.
- **Risks:** Low, mostly a refactor. Guard with golden-payload tests before and after consolidating inline patches.

### 10. Sessions-vs-memory corpus visibility split  
`effort:S · impact:low · sources:OpenClaw session transcript visibility rules`

- **Fit:** openrappter catalog stores immutable source events; a corpus and visibility dimension is a small extension of MemoryAccessScope rather than a new subsystem.
- **What to build:** Add a corpus and visibility field to MemoryAccessScope and a corpus tag on rows for memory or session, then plumb a corpus filter through retrieval so recall can scope to memory sessions or both. Default preserves current behavior.
- **Where it lands:** Python: extend memory store scope and retrieval filter; wire from context memory agent. TS: mirror in the AB-01 port. Tests: extend retrieval tests plus parity.
- **Parity:** Fold into AB-01 TS port; Python change is small and standalone.
- **Risks:** Minimal; must not change default recall results. Only meaningful once session transcripts are indexed.

## Do NOT assimilate

- **LanceDB or any heavyweight vector DB dependency** — OpenRappter frontier catalog already does hybrid RRF retrieval over local SQLite with pluggable embeddings and agent-scoped access. LanceDB adds a heavy binary and a second storage engine for a capability openrappter already has.
- **Docker or SSH or OpenShell sandbox backends** — Heavy container and remote runtimes contradict openrappter local-first low-footprint stance. ApprovalManager plus tool policy plus ShellAgent scoping cover the trust model without a dependency that would make the assistant undeployable on constrained devices.
- **Cloud realtime-voice provider abstraction** — OpenRappter has TTSAgent and a Copilot backbone; a realtime-voice transport pulls in always-on cloud streaming APIs and audio session machinery that are a different product surface and violate the local-first single-backbone principle.
- **Canvas visual workspace with native apps** — Canvas requires native client apps and a UI-rendering pipeline out of scope for openrappter headless framework plus web dashboard. The dashboard and typed presentation actions cover interactive affordances without a native app fleet.
- **Media generation pipeline with multimodal indexing** — Cloud image and video generation is off-backbone since it is not Copilot and adds provider lock-in and a multimodal indexing subsystem outside the local assistant core. ImageAgent covers narrower needs.
- **Published gateway-protocol package with owner-review gate** — OpenRappter already versions its gateway protocol inline with a hello-ok snapshot; a published package and human review gate is process overhead with no functional gain for a single-owner deployment.
- **Facade-loader plugin SDK with entrypoint-cost CI enforcement** — OpenRappter already has two-phase manifest discovery without code exec and a scoped plugin API. The full facade-loader boundary and CI startup-cost profiling are heavyweight for a much smaller plugin surface; SecurePluginLoader with path containment and symlink rejection is sufficient.

## Adversarial critique

### Overhyped / marketing-driven
- **AB-01 TypeScript catalog parity labeled 'transformational' impact** — The impact rating is inflated by the parity framing, not by user value. I verified the actual TS runtime memory path: MemoryAgent.ts (typescript/src/agents/MemoryAgent.ts:73,317) reads a separate ~/.openrappter/memory.json with naive substring matching and does NOT consume MemoryManager at all. The naive MemoryManager stub is only wired into cli/memory.ts and showcase-methods.ts. So AB-01 as scoped ('replace the MemoryManager stub') ports 13k lines of Python into a TS module that the real agent never calls. 'Transformational' assumes users feel the difference; they won't until MemoryAgent itself is rewired, which the synthesis lists as a footnote ('rewire memory manager and index') rather than the actual work. This is a parity-completeness obligation dressed up as a capability leap.
- **AB-04 durability + AB-08 durable spool as separate high-priority items** — These are the same idempotency/dedup mechanism (write-intent-before-effect, tombstone-on-complete, reconcile-on-boot) applied to egress vs ingress. Ranking them at priorities 4 and 8 as independent L-effort items double-counts the design cost. The hard part -- a stable idempotency hash across restarts and a shared migration schema -- is paid once. Shipped together they are closer to a single L, not 2xL. Splitting them inflates the backlog's apparent breadth.
- **AB-07 ACP client agent framed as local-first-compatible** — The one-line 'local-first since you opt in per call' hand-waves the actual tension. I confirmed the brainstem (python/openrappter/brainstem.py) is strictly stdlib -- urllib, http.server, sqlite3, no third-party deps by design, enforced by test_memory_contract_compat.py's dependency-free shim test. An ACP client's entire value is reaching OUT to external/cloud Claude agent servers. That is the definition of off-backbone external-service coupling. It may be worth having, but calling it local-first because it's opt-in is the same logic that would justify any cloud integration.

### Conflicts with local-first
- AB-07 ACP client agent: its purpose is to call external agent servers / cloud Claude apps as tools. Opt-in-per-call does not make outbound dependency on an external service 'local-first' -- it introduces a network runtime dependency and, in TS, a third-party SDK (@agentclientprotocol/sdk) that the brainstem's zero-dependency contract (verified stdlib-only in brainstem.py) explicitly forbids on the Python side. The synthesis even admits Python needs a hand-rolled client, which is a tell that the feature fights the architecture.
- AB-02 circuit-breaker TTL cache: not cloud lock-in, but the synthesis undersells that a result cache keyed on query hash can silently serve stale authorization-scoped results across scope boundaries if the key omits the access scope. In a local-first single-process assistant the resilience upside over a local SQLite read is marginal -- there is no network hop to protect against. It borrows a pattern designed for OpenClaw's remote/heavier recall path and applies it where the failure mode it guards against (slow network retrieval) barely exists locally.
- The doNotAssimilate list is correct and well-reasoned (LanceDB, Docker/SSH sandboxes, cloud realtime-voice, Canvas native apps, media-gen). No local-first violations slipped INTO the backlog beyond AB-07. Credit where due: the exclusions are the strongest part of the synthesis.

### Missed opportunities
- The real AB-01 blocker is missing: there is no cross-runtime scoring golden/contract test. I read test_memory_contract_compat.py -- it has only 2 tests (loader discovery + dependency-free shims), neither of which locks RRF scores, tie-breaking, or working-set projection output. AB-01's entire de-risking strategy ('port module-by-module behind the cross-runtime fixture') assumes a fixture that does not exist. Building that golden-vector fixture FROM the Python implementation is the true priority-1 prerequisite and is unscoped in the plan.
- Unifying the THREE divergent memory implementations is the missed structural win. TS has MemoryManager (naive, cli/showcase-only) AND MemoryAgent's memory.json (naive, the real runtime path), plus the Python catalog. The highest-leverage move is not porting Python to a fourth surface -- it's collapsing MemoryAgent onto the ported catalog so the runtime actually benefits. The synthesis treats MemoryAgent rewiring as incidental.
- FTS5 graceful fallback is already solved in Python (store.py:1238 _detect_fts5 probe) but the synthesis flags FTS5 divergence as an open AB-01 risk to be mitigated later. The pattern to port already exists; the plan doesn't credit this, overstating that risk.
- No item addresses observability/tracing parity for the memory path. AgentTracer exists (TS) but Python has no equivalent per the plan's own AB-03 note ('Python has no hooks package'). Memory recall decisions (what got injected, why) are invisible. A recall-decision trace is higher operator value than several M/L items and reuses existing tracer infra.
- Deterministic embedding fallback across runtimes is unaddressed. RRF fuses lexical + semantic; if TS and Python use different embedding providers/dims, the 'contract test diverges' risk in AB-01 is not just FTS5 -- it's the semantic half entirely. The plan should specify a shared deterministic hash-embedding fallback for the contract fixture.

### Effort reality checks
- **AB-01** — XL is if anything optimistic once you account for what I found. The scope note says 'rewire memory manager and index' but the real runtime consumer is MemoryAgent.ts (separate memory.json path), and there is NO existing cross-runtime scoring contract to port against (test_memory_contract_compat.py has 2 non-scoring tests). Realistic XL+: port 5 modules + build the golden fixture from scratch + rewire MemoryAgent + reconcile the third memory.json surface. Treat the fixture as its own prerequisite deliverable.
- **AB-04** — L is plausible for the schema+reconcile, but 'idempotency hash must be stable across restarts' plus threading a delivery-intent guard through 20+ channel base send wrappers AND not breaking the brainstem stdlib HTTP model is the hard 20%. Verified brainstem is a hand-rolled BaseHTTPRequestHandler (brainstem.py:661) -- graceful drain on shutdown there is non-trivial. Call it L-to-XL.
- **AB-03** — L is fair but the parity gap is understated: Python has NO hooks package at all (confirmed -- only TS has typescript/src/hooks/). Net-new package + threading a typed decision object through the brainstem tool loop (which must preserve RAPP kernel wire-compat) is the risky part. The TS side is genuinely just an enum + HookResult decision extension (types.ts confirms only bail/data today). Effort is asymmetric: S-ish for TS, L for Python.
- **AB-05** — M is right for TS (doctor.ts exists, add a --fix path). For Python it is net-new: no doctor exists at all (confirmed -- only typescript/src/cli/doctor.ts). Python side is closer to L. The blended M hides that asymmetry.
- **AB-09** — S is accurate and this is the best effort/impact ratio in the whole backlog. Pure mechanical refactor with golden-payload guard tests, both runtimes in one pass. Under-ranked at priority 9 relative to its low risk and drift-prevention value.

## Appendix — per-system standout features

### OpenClaw is an open-source personal AI assistant framework running on your devic

OpenClaw demonstrates sophisticated production patterns for multi-channel, multi-provider agent systems. Its standout ideas are: (1) narrow, version-gated plugin boundaries with two-phase loading, (2) doctor-driven config evolution that prevents silent compat debt, (3) durable restart recovery with idempotent delivery guarantees, (4) per-agent SQLite with bounded indexing and disk budget management, (5) typed message presentation actions to avoid string inference fragility, (6) provider-family-level helpers instead of scattered compat logic, and (7) durable spool-based ingress with pre-adoption timeouts. These patterns are particularly valuable for systems supporting many channels/providers on resource-constrained devices. The codebase is mature (production, ~2800 tests), well-documented, and the architecture prioritizes fail-closed security and operator control over convenience. OpenRappter could adopt several of these patterns without major restructuring: doctor-driven migrations, SQLite-backed spool ingress for channels, explicit plugin loading phases, and ACP integration would all strengthen its extensibility and reliability.

- **Deterministic plugin SDK boundary with facade-loader pattern** _(production)_ — Most frameworks allow plugins unfettered access to internals or suffer from monolithic re-exports that bloat every plugin entrypoint. OpenClaw makes the boundary explicit and enforces it: plugins see 
- **Doctor-driven config migration and compatibility repair** _(production)_ — Most systems lack a forcing function for config evolution. OpenClaw's doctor is mandatory—every update candidate is validated, and broken configs are fixed deterministically before runtime. This elimi
- **Durable restart recovery with idempotent delivery guarantees** _(production)_ — Durable recovery without operator intervention is rare in agent frameworks. Most systems lose in-flight work on restart, require manual session salvage, or have non-idempotent delivery (risking duplic
- **Per-agent SQLite session store with bounded transcript indexing and disk budget enforcement** _(production)_ — Most agent systems either store all sessions in a single flat file (poor scalability), or use expensive materialization of entire transcripts on every read (unbounded memory). OpenClaw's per-agent SQL

### OpenClaw (personal AI assistant framework with memory, skills, canvas, voice)

OpenClaw is architecturally sophisticated in three core dimensions: (1) Plugin composition via typed lifecycle hooks (not just pub/sub), (2) Clean abstraction of pluggable backends (memory, voice, embeddings, sandbox runtimes) behind SDK contracts, and (3) Event-driven multi-agent routing with strict workspace isolation. The memory system is particularly mature — it's not just vector search but a multi-layer circuit-breaker with contamination filtering and sub-agent fallback. Canvas is integrated into message rendering, not bolted-on. Voice is a first-class transport with native wake-word matching and turn control. The hook system's key innovation is typed decision propagation (accept/reject/pass-through at each phase), enabling plugins to influence core behavior without reaching into internals. Doctor mode's declarative repair workflows show architectural maturity — config breakage is handled via plugin-owned rules, not hard-coded core migration code. The system's strength is deep integration of memory, voice, and visual rendering into the core agent loop, with sophisticated resilience patterns (circuit-breaker, caching, timeouts, contamination filtering) that openrappter could benefit from studying.

- **Pluggable multi-layer memory architecture (LanceDB vector + active-memory circuit-breaker)** _(solid)_ — Unlike monolithic RAG systems, OpenClaw's memory cleanly separates search semantics (plugins), vector storage (swappable), and agent recall logic (circuit-breaker + caching). Active-memory's resilienc
- **Comprehensive hook lifecycle system for plugins (before/after agent, tool, reply, compaction, session events)** _(production)_ — The hook system is not a simple pub/sub—it's a typed decision pipeline that allows plugins to influence agent behavior at critical boundaries without reaching into internals. beforeAgentReply hooks ca
- **Live Canvas with A2UI rendering and agent-driven visual workspace (macOS/iOS/Android)** _(solid)_ — Canvas is not a bolted-on widget library—it's integrated into the message rendering pipeline and routed through channels (Telegram, Discord, etc. get text fallback; native apps render A2UI). The MCP a
- **Native voice I/O with realtime voice provider abstraction (speak/listen, wake words, barge-in)** _(solid)_ — Voice is treated as a first-class transport, not a channel hack. Talk mode's barge-in handling and turn context tracking (TalkBrain) let agents reason about speech state in real-time. Activation name 

### Hermes Agent (Nous Research) - A self-improving AI agent with persistent memory,

Hermes Agent's most distinctive ideas are: (1) **Background review loops** that defer skill/memory decisions to an isolated fork with cache reuse, eliminating the main conversation latency; (2) **Prompt caching as a sacred invariant** protecting the warm prefix cache across every turn—worth ~75% cost savings; (3) **Honcho dialectic user modeling** that reasons about users over time via multi-pass synthesis rather than just storing facts; (4) **Curator lifecycle** that autonomously manages skill quality and consolidation without manual intervention; (5) **FTS5 search with demoting** to prevent automation vocabulary from drowning out interactive sessions. These are all **production-ready**, not marketing-only. None exist in openrappter. The architecture philosophy—narrow core, capability at the edges via plugins/skills, every design guarded by "does this break the cache?"—is worth copying wholesale.

- **Background Review Loop (Post-Turn Self-Improvement)** _(production)_ — Unlike most agents that decide on memory/skills inline during conversation, Hermes defers this to a background fork. This keeps the main loop fast, avoids cache invalidation mid-conversation, and uses
- **Curator - Autonomous Skill Lifecycle Management** _(production)_ — Hermes doesn't just create skills autonomously—it actively curates them over time, archiving stale ones and consolidating related skills into umbrellas via an auxiliary model. The state machine (activ
- **FTS5 Session Search with Deduplication & Demotion Strategy** _(production)_ — The dedup-by-lineage + demotion strategy is clever—it prevents cron vocabulary from starving out interactive sessions in search results. Most systems do naive FTS; Hermes ranks sessions by source and 
- **Prompt Caching Strategy (System + Last-3-Messages)** _(production)_ — Caching is foundational to Hermes' cost model. The system+3 strategy is elegantly minimal—enough context for coherence, small enough to fit in the cache budget. Provider-aware marker placement (top-le

### Pi Agent Harness (earendil-works/pi)

Pi's most distinctive value is **multi-provider abstraction + observable streaming agent loop + compaction-aware session management**. The unified LLM layer (pi-ai) eliminates provider lock-in; steering/follow-up queues enable live user interruption; structured compaction preserves narrative while freeing context. The native TUI (pi-tui) with differential rendering is production-grade and reusable. The .pi/ extension convention makes customization approachable. Compared to openrappter (Copilot-only, memory-projection-based, no TUI, sequential execution), Pi is more modular, extensible, and suitable as a cross-platform SDK. However, openrappter's strength is zero friction (Copilot subscription, local memory, single Python/TS agent contract) and dual-runtime parity; Pi is more powerful but requires more setup. For openrappter, the highest-ROI steals are: (1) steering/follow-up queues, (2) unified provider abstraction, (3) pi-tui library, (4) .pi/ extension pattern, (5) structured compaction with narrative preservation.

- **Unified Multi-Provider LLM API Layer (pi-ai)** _(production)_ — Complete abstraction of provider diversity into ONE unified interface. Client code never changes when swapping providers. Auth isn't bolted on—it's intrinsic to provider identity. Contrasts with openr
- **Streaming Event Architecture with Steering/Follow-Up Queues (Agent Loop)** _(production)_ — Steering/follow-up are first-class patterns, not retrofitted. Enables live user interruption while tools run (e.g., 'stop and do X instead'). Event granularity lets UI show tool progress in real time.
- **Message Compaction with Structured Summarization and Branch Preservation** _(production)_ — Structured summarization preserves coherent narrative (Goal/Decisions/Next Steps), not just token reduction. Handles split turns (mid-turn cut points). Branch preservation on navigation—context isn't 
- **Native Terminal UI with Differential Rendering and Synchronized Output** _(production)_ — Differential rendering eliminates flicker on slow networks/terminals. Synchronized output is atomic—no teardown. Overlay system (centered, anchored, percentage/absolute positioning) is 'desktop UI in 

### OpenHands is a distributed developer control center for AI agents. It's architec

OpenHands is a production-grade distributed agent platform designed for teams and enterprises, not single-user local agents. Its key innovation is the **event stream + webhook callback** pattern, which decouples agent execution from downstream automation. The **multi-backend architecture** enables agents to run persistently in the cloud independent of a developer's laptop, critical for production use. The **ACP provider abstraction** makes agents swappable (use Claude today, Gemini tomorrow, without reconfiguration). **Microagents** are OpenHands' answer to context enrichment: instead of stuffing everything into one prompt, drop a .md file with triggers, and the framework loads domain knowledge on-demand. For openrappter, the biggest wins to steal are: (1) **event stream** (convert execute() → perform() into a persistent append-only log), (2) **webhook callbacks** (make automation registration declarative, not hardcoded), (3) **multi-backend abstraction** (enable remote sandbox execution), (4) **provider pluggability** (abstract the LLM backend). Avoid the temptation to copy OpenHands wholesale—openrappter's strength is simplicity and local-first design. Instead, port the *patterns*: event-driven architecture, callback registration, provider abstraction.

- **Multi-Backend Agent Execution with Seamless Switching** _(production)_ — Openrappter is single-node (local or CLI-only). OpenHands' multi-backend architecture enables teams to share agent servers, run agents persistently on cloud infra, and seamlessly failover between exec
- **Agent-Client Protocol (ACP) for Pluggable Agent Providers** _(production)_ — Openrappter is tightly coupled to Copilot via GitHub integration. OpenHands abstracts the agent provider, allowing any ACP-compliant LLM agent (Claude, Gemini, etc.) to run in the same framework witho
- **Event Stream Architecture with Action/Observation Pattern** _(production)_ — Openrappter's agent execution is imperative (execute() → perform() → return result). OpenHands models all agent/system interaction as a persistent append-only event log, enabling: (1) perfect replay/a
- **Webhook-Driven Event Callbacks and Automation Orchestration** _(production)_ — Openrappter has no automation layer. OpenHands decouples automation from agent execution: register a callback once, and it fires on every matching event across all conversations. The EventCallbackProc

### Claude Code (Anthropic, closed-source). Analyzed via the actual installed binary

The single highest-value idea to steal is the Workflow durable-replay orchestrator: make AgentGraph/AgentChain event-sourced and resumable by forbidding nondeterminism (Date.now/Math.random) inside orchestration scripts and checkpointing agent-call results, so long multi-agent runs survive crashes/backgrounding and resume without repeating work — a strict upgrade over openrappter's in-memory single-shot DAG. Close behind: (2) deferred tools + a ToolSearch equivalent so openrappter stops shipping every agent as an up-front MCP tool and instead lazy-loads schemas as the agent/skill count grows; (3) file-history checkpoint + /rewind that undoes an agent's code AND conversation detour without touching git; and (4) reworking hooks into out-of-process shell commands with a PreToolUse permissionDecision so end-users can gate/rewrite individual tool calls declaratively, with output-styles falling out for free as SessionStart context injectors. Progressive-disclosure Skills (execute-without-load) and a multi-extension plugin marketplace are the natural distribution-layer follow-ons.

- **Workflow: deterministic-replay durable orchestration for multi-agent runs** _(production)_ — openrappter's AgentGraph/AgentChain are in-memory, single-shot DAG executors — if the process dies mid-run everything is lost and re-running re-does all work. Claude Code's Workflow is a DURABLE orche
- **File-history checkpoint / rewind decoupled from git** _(production)_ — openrappter has infra/backup.ts but no unified edit-history snapshot + conversation-rewind that lets a user undo an agent's whole detour (code + chat) in one action WITHOUT touching git history. This 
- **Deferred tools + ToolSearch (lazy tool-schema loading)** _(production)_ — openrappter exposes ALL agents as MCP tools up front (mcp/server.ts, dashboard). With hundreds of agents/skills/MCP tools that blows the context window and degrades tool selection. Deferred loading ke
- **Lifecycle Hooks as external shell commands that can GATE and rewrite tool calls** _(production)_ — openrappter's hooks (typescript/src/hooks/types.ts) are IN-PROCESS TypeScript callbacks over app-lifecycle phases (boot, agent.before, message.incoming...). Claude Code's are OUT-OF-PROCESS shell comm
