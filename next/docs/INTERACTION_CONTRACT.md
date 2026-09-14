# Binding headless interaction contract

The primary surface is natural-language collaboration through Copilot CLI/stdio.
The CLI is not a UI backend with a chat feature. A future visual surface may only
project this same conversation and forward explicit human intent.

## Executable boundary

From the repository root, after `npm --prefix next run build`:

```sh
node next/dist/cli.js --store next/.state --id create-my-bot \
  bots.create '{"name":"My Work"}'

node next/dist/cli.js --store next/.state stdio
```

The store must have an existing real parent, be dedicated to canonical state,
and be owner-only. It is never a native profile or source folder. No ambient
HOME/profile discovery, authentication, installation or automatic model startup
occurs. A new operator root can record/reconstruct context while external
Brainstem/provider bindings are unavailable.

Stdio is newline-delimited JSON, **not a claim to implement MCP**:

```json
{"id":"thought-1","method":"conversation.say","params":{"root":"<full canonical RAPPID>","text":"Make this a world and recap progress every Monday"}}
```

Responses have `interface:"rapp-work.stdio/1"`, the same `id`, and either `result`
or a bounded public `error:{code,message}`. No diagnostic stack, private provider
error, reasoning event or credential goes to the canonical conversation.
Requests are limited to 64 KiB. Unknown methods/fields, duplicate JSON keys,
invalid root/scope types and excessive values refuse.

Mutating request IDs are lowercase bounded labels, scoped to a root across its
stream families; root-creation IDs are unique across the catalog. Repeating an
ID returns the original receipt or an explicit incomplete state. Rebinding the
ID to different work fails. A restart does not resume an SDK session or replay a
model, tool, channel send or uncertain approval.

## Thought to outcome

1. Select a full root GUID and optional internal scope. Read and verify canonical
   context first; sibling scopes and other bots' private memory are excluded.
2. Append the user's public thought before inference. A crash at this boundary
   leaves an honest incomplete-turn attention item, not an instruction to retry.
3. Under a transient observation, the verified root interpreter requests only
   **GPT-6 Astra / max / long_context** through the injected Copilot SDK adapter.
   Tools, MCP servers, plugins, skills, ambient Git/config/instructions, SDK
   memory, cross-session store, telemetry/export and automatic compaction are
   disabled. Only bounded public response JSON is accepted.
4. Infer organization rather than asking the user to design folders. The public
   draft contains `summary`, material `tradeoffs`, irreducible `questions` and
   bounded `actions`. Nothing in a draft executes.
5. `organization.confirm` names the exact proposal wave. It must still be the
   current head, have no unresolved human question, and fit the selected scope.
   One canonical successor atomically represents the whole internal outcome.
   In the same natural conversation, “yes, do that”, “go ahead”, or “confirm”
   resolves only the exact latest reviewed proposal in the permitted scope;
   “confirm <wave>” names one explicitly. No pending context means refusal, not
   a guessed action. This cannot approve an external effect.
6. A later reviewed answer can carry `resolves:[question-wave]`. Only exact
   pending questions in the same scope can be superseded, and **only after
   human confirmation**. Both questions and answers remain in history.
7. Progress and evidence refer to existing frames of this root. Undo appends a
   correction to reversible internal work. It cannot erase turns, rewrite an
   external action, or orphan a dependent scope.

Supported draft actions are internal scope creation, canonical inert text
artifacts, registration of discovered native **pointers**, recurring canonical
recaps, and preparation of external-message requests. They are application
payload semantics in existing RAPP/1 kinds, not new protocol kinds.

## Methods

`root` may be omitted only after `bots.select` in the same stdio session.
Selection is transient; an explicit invalid `root` never falls back to it.

| Method | Additional parameters / behavior |
|---|---|
| `runtime.info` | Binding availability, fixed model, fixture status; no inference |
| `bots.create` | `name`, optional explicitly bound `keyedRoot` |
| `bots.list` | optional `includeHidden` boolean |
| `bots.select` | `root`; read-only selection |
| `bots.hide`, `bots.restore` | Clear/restore the same GUID and history |
| `conversation.say` | `text`, optional internal `scope` |
| `conversation.where` | Canonical orientation/resume; no mutation or inference |
| `conversation.catch-up` | Optional `scope`, `from`, `to`, `limit`, private `guest` opt-in; deterministic graded replay, no execution |
| `attention.get` | Pending review, question, incomplete work, provider/channel/effect state and observation |
| `projection.get` | Stable passive projection, distinct signed collaboration speakers |
| `organization.confirm` | `proposalWave`; exact human confirmation |
| `estate.record` | `evidence`; closed historical local/native pointer provenance or non-candidate observation; exact source receipt, no registration |
| `estate.rapp-up` | Complete reviewed organization of already recorded discovery |
| `work.progress` | `scope`, `summary`, `evidence` wave hashes |
| `work.undo` | `targetWave`, `reason`; append-only internal correction |
| `work.due` | optional `utc`; read-only view of reviewed recurring work |
| `work.tick` | `routineId`, exact `occurrence`; bounded idempotent internal recap |
| `collaboration.grant` | `peer`, `publicBrief`, `mode:allow|revoke`; one-hop public perspective only |
| `collaboration.ask` | `peer`, `question`; requires independent bilateral signed grants |
| `collaboration.transcript` | Canonical UTC/wave order, distinct original GUID speakers |
| `effects.approve` | `effectId`, exact `requestHash`, exact `target`; separate external-action approval |
| `channels.bind` | `contactRef`, `permissionRef`, `enabled`; does not itself grant OS permission |
| `channels.queue-recap` | Canonical bounded public recap |
| `channels.deliver` | `deliveryId`; explicit delivery attempt |
| `channels.recap` | Read-only outage/missed-delivery continuity |
| `channels.receive` | `envelope`; trusted transport authentication and contact binding required |
| `hive.consent` | `peer`, `room`, `objectWave`, `mode:allow|revoke`; exact per-world consent |
| `hive.link` | `peer`, `room`, `objectWave`; also requires existing signed canonical Hive authority |
| `egg.at-rest` | Read-only byte commitments, exact `identity.body_stream`, and explicitly false closure/domain/code/shared-runtime adoption diagnostics |
| `egg.transfer` | `operation:inspect|export|restore`, `scope:godd|dogg|both`; refuses without adopted bindings |

There is no delete method, arbitrary shell/tool method, provider switch,
automatic external approval, native-store write or executable hotload from
carried data.

Native exporter/receipt details are in `NATIVE_FEDERATION_API.md`. Native union
provenance is metadata, not a provider switch or native-memory merge; unresolved
and Grok app-only observations are not workspace candidates. The frozen
framework-neutral reference and unavailable adoption flags are mapped in
`ROOTED_ESTATE_HANDOFF.md`.

`collaboration.ask` returns separate `responseStatus` and `synthesisStatus`.
An approved peer response with unavailable or no-longer-authorized synthesis is
`partial`. Exact recorded owner retries remain read-only even after peer grant
revocation or loss of a private signer; a changed request or new delegation
does not inherit that exception. Every new synthesis rechecks authority before
model dispatch. See `MULTIBOT_REFERENCE.md`.

## Recurring and away work

“Make this a world and recap progress every Monday” is one complete reviewed
intent: world, instruction, supported operation, cadence and first occurrence
are shown together. The initial bounded operation is `canonical-recap`;
arbitrary work is not silently translated into a claim of successful execution.
Monday **09:00 UTC** is explicit and reviewable, not an inferred timezone.

The routine is an internal organ. `work.tick` reads canonical context first and
appends a reversible, evidence-grounded recap. It makes **zero model calls**
and cannot send messages or execute arbitrary instructions. Repeating a tick
does not repeat work. Hidden roots have no due work. The backlog is bounded.

There is no installed daemon or host scheduler in this milestone. A permitted
scheduler can invoke this same hidden tick boundary; a standalone observation
or restart does not start a catch-up model run. A running external model that
ignores cancellation is reported as **quiescing**, not falsely called dormant;
that root is fenced against a replacement call until it settles.

## Explicit fixture dogfood

```sh
node next/dist/cli.js --store next/.state-fixture --fixture runtime.info '{}'
node next/scripts/e2e.mjs
```

`--fixture` is an explicit synthetic adapter selection, never a fallback.
Use a dedicated test directory, never a live store. `runtime.info` prints its
two deterministic public fixture RAPPIDs; pass one as `keyedRoot` when creating
a fixture bot. The script performs the complete reviewed headless scenario and
writes canonical evidence under `next/.test-scratch/`.

Fixture keys are publicly reproducible test material, not credentials or
production signer custody. Live integration must supply an authenticated,
empty, memory-only SDK host and the adopted external Brainstem boundary.
