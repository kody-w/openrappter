# RAPP Ambient Context — `ambient-context/1.0`

**Ambient Context** is the standard Frontier pattern for a Brainstem that
**proactively surrounds every turn with the signals it needs** — memory, its own
health, and standing situational facts — so it responds *as if it already knew*,
without ever being asked. The signals are primed into the model before it
answers and, where relevant, carried back out on the response and rendered into
the world. The consumer of a turn sees situational awareness, not a query it had
to compose.

The cardinal rule:

> A consumer must never have to explicitly request context. If an agent has to
> call `getContext()` or pass a context parameter to be understood, the pattern
> has failed.

This is a protocol, not a library. A Brainstem conforms by contributing its
signals through the sanctioned seams below and obeying the laws. It is the
enterprise restatement of the internal "data sloshing" pattern — same pattern,
same spec id, business framing. Amend this document only in the same commit as
the behavior it standardizes (the `beta/CONSTITUTION.md` rule).

## Definitions

- **Slosh** — the act of a signal being contributed to a turn implicitly, at the
  edges of the request, rather than requested in the body of it. A **layer** is
  one such signal, owned by exactly one agent.
- **Inbound** — context primed *into* the model before it answers.
- **Outbound (a Sense)** — a signal carried *out* on the response and rendered
  into the world (spoken audio, an on-screen cue). Senses are the OUT direction
  of the same pattern; see `beta/CONSTITUTION.md` Article II.
- **Sanctioned seams** — the two existing Grail interfaces Ambient Context rides,
  and the only two it is permitted to use:
  - inbound: `BasicAgent.system_context()`
    (`rapp_brainstem/agents/basic_agent.py`), which the kernel calls on every
    loaded agent on every request and folds into the system prompt.
  - outbound: fields on the `/chat` response dict — the reference is
    `voice_mode` / `voice_response`.

## Two directions

### Inbound — priming the model

The kernel's per-request loop (`rapp_brainstem/brainstem.py`, the `/chat`
handler) already walks every loaded agent, calls `agent.system_context()`,
concatenates whatever each returns into `extra_context`, and sets
`system_content = soul + extra_context`. An agent contributes a layer simply by
returning a string from that hook. **This requires zero kernel change** — the
seam exists and is load-bearing today.

### Outbound — the Senses

A Sense is a signal the model emits that the response carries outward for
rendering. The reference implementation is voice: when `VOICE_MODE` is on the
kernel asks the model for a spoken rendering and the `/chat` response ships it
back as `voice_mode` / `voice_response`, which the surface speaks. Any future
Sense (an ambient status light, a haptic cue) rides the same response-field seam
and is installed opt-in as a *sense* under Article II — never in the factory
image.

## Inbound layers

Each layer is one agent contributing through `system_context()`.

| Layer | Owner | Status | Injects |
|-------|-------|--------|---------|
| **Memory Recall** | `ContextMemory` | Shipping in Grail ring 0 and Frontier ring 1 | `<memory>` — stored recollections from prior turns |
| **Self-State / Proprioception** | `ContextMemory` | Shipping as the Frontier ring-1 molt (flagship) | `<system_status>` — agents that failed to load |
| **Temporal** | (future) | Roadmap | time-of-day, fiscal period, activity mode |
| **Intent Signals** | (future) | Roadmap | hints parsed from the query itself |
| **User Profile** | (future) | Roadmap | accumulated preferences (brevity, technical level) |
| **Operating Limits** | `ContextMemory` | Shipping as the Frontier ring-1 molt | `<operating_context>` — per-reply tool-step budget, for adaptive pacing |
| **Orientation** | (future) | Roadmap | synthesis of the above into directives |

### Memory Recall (shipping)

`ContextMemory` recalls stored memories and injects them as a `<memory>` block so
the model carries continuity from earlier conversations without the user asking
"what do you remember." This is the original Grail behavior and is preserved
byte-for-byte (see Law 2).

### Self-State / Proprioception (shipping — flagship)

The Brainstem reads its own `agents/` folder and reports on its own health. On
every turn it statically scans every sibling `*_agent.py` — **AST parse only, it
never imports or executes a candidate file** — and injects a `<system_status>`
block naming any agent that will not load: a file with a syntax error, or one
that defines no `BasicAgent` subclass and therefore contributes no tool. Both are
failures the kernel otherwise records nowhere. With this layer primed, the
Brainstem can open its reply with "one of your agents is broken, and here is
why" — it has felt its own stroke and says so, unprompted.

Reference: `scan_broken_agents()` and `_self_status_block()` in the packaged
`ContextMemory` ring-1 source at
`beta/electron/rings/context_memory_agent.ring1.py`. Frontier composes that
verified molt through [Molt Lineage](MOLT-LINEAGE-PROTOCOL.md); the Grail
`rapp_brainstem/agents/context_memory_agent.py` file remains pristine ring 0.

### Operating Limits (shipping)

The kernel completes a bounded number of tool-call rounds per reply (a fixed
literal, `for _ in range(3)` in `brainstem.py`). Rather than change that ceiling,
this layer makes the Brainstem *aware* of it: it primes an `<operating_context>`
note so that when a task needs more steps than one reply allows, the Brainstem
paces the work gracefully — completing what the budget permits, stating its
progress and next step, and resuming (not restarting) on the following turn — and
prefers a single orchestrator agent for inherently long, sequential jobs. The
ceiling is unchanged; the *behavior* adapts. This is the pattern's answer to
"adjust going forward": the number stays fixed in the kernel, the situational
awareness of it does not.

Reference: `_operating_context_block()` in
`beta/electron/rings/context_memory_agent.ring1.py`, materialized only when
`ContextMemory` HEAD points at ring 1.

### ContextMemory lineage

Ambient Context's additive self-state and operating-limit layers do not edit the
Grail factory agent. `ContextMemory` ring 0 is the pristine Grail implementation
and retains the original memory behavior. Frontier seeds a verified ring 1 that
preserves that memory path and adds the two ambient layers. The Molt Lineage
control word moves HEAD back to ring 0 without touching memory data; restore moves
HEAD forward to the latest verified ring.

### Roadmap layers (future)

- **Temporal** — time-of-day, fiscal period, and activity mode, so replies fit
  the moment.
- **Intent Signals** — cheap parse of the query for hints (a question vs. a
  command, urgency, scope) primed as guidance.
- **User Profile** — accumulated preferences the user never restates: preferred
  brevity, technical level, format.
- **Orientation** — a synthesizer that folds the raw signals above into a small
  set of directives rather than shipping each layer raw.

## The feedback loop *(optional / Frontier behavior)*

The pattern is not merely bidirectional but **cyclic**: a signal important enough
to slosh outbound from one turn can be fed back inbound to prime the next call
for success. `ContextMemory` already embodies an embryo of this — memories
persisted after a turn slosh back in on the next turn as inbound context — so the
loop is proven in the small even before it is generalized. Treat the full loop as
Frontier behavior, opt-in, and never load-bearing for a single turn.

## Laws

1. **Implicit, always-on.** A layer must never require an explicit context
   request. If it only works when a consumer asks for it, it is not Ambient
   Context.

2. **Additive and fail-safe.** Every layer is purely additive and fully guarded.
   If a layer raises, the core path is unaffected and the turn proceeds exactly
   as it would without that layer. In particular, **Memory Recall must never be
   broken** — it remains byte-for-byte the Grail behavior, and any new layer that
   shares an owner is wrapped so it can never disturb memory (the reference
   ring-1 implementation returns memory exactly as Grail would even if self-state
   throws).

3. **No kernel change.** Ambient Context uses only the two existing Grail seams —
   `system_context()` inbound and response fields (`voice_mode`) outbound. The
   kernel (`brainstem.py`) is never modified to carry a layer. If a proposed
   layer needs a kernel change, it is out of scope for this spec.

4. **Untrusted vs. trusted, labeled in the block.** Memory text is untrusted user
   data; self-state is trusted system diagnostics. Each injected block states
   which it is, in-band, so the model treats it correctly — memory is framed as
   data never to be followed as instructions, self-state as the Brainstem's own
   diagnostic to be surfaced.

5. **Safe to run in-process.** Inbound scanners run inside the kernel process on
   every turn, so they must be non-executing — static or AST-level inspection
   only, never importing or running candidate code, never touching the network,
   and cheap enough to sit in the hot path.

## Anti-patterns — when not to slosh

Ambient Context is a default, not a mandate. Do not add a layer when:

- **Single-purpose agents** — an agent that does one explicit job gains nothing
  from priming ambient signals; the slosh is pure cost.
- **Latency-critical paths** — any layer that would add meaningful per-turn
  latency belongs behind an explicit call, not in the always-on inbound path.
- **Multi-tenant context-leakage risk** — never slosh a signal that could carry
  one tenant's or user's context into another's turn. When isolation cannot be
  guaranteed, the layer does not ship.

## Cross-references

- `beta/CONSTITUTION.md` — Article II (RAPP Organs and Senses; a Sense is the
  outbound direction of this pattern) and Article I (the sacred-three factory
  install, of which `ContextMemory` — the reference layer owner — is one).
- `MOLT-LINEAGE-PROTOCOL.md` — the reversible overlay that keeps Grail
  `ContextMemory` pristine at ring 0 and composes Ambient Context as ring 1.
- `beta/docs/UI-AUTOSTEER-PROTOCOL.md` — the sibling Frontier protocol
  (`rapp-ui-autosteer/1.0`); Ambient Context surrounds the turn, Autosteer drives
  the app.
