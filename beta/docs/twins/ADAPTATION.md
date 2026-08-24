# Safe twin capability adaptation — beta.11

OpenRappter twins can adapt their **capability composition**. They cannot rewrite
their running selves in place. The Grail kernel remains unchanged, `/chat`
remains the only model/tool wire, and the controller adds no Brainstem REST
management route.

## State machine

```text
observed → diagnosed → proposed → staged → shadow_verified
  → approval_required | activatable → active → healthy

failed → quarantined → rolled_back
```

The machine is closed: no other state or transition is accepted. An explicit
user request/correction can enter `observed` immediately. Runtime evidence must
repeat and must normalize to one of: tool error, schema mismatch, constant/stub
output, declared capability returning no data, missing binding, or health
failure. A transcript, provider payload, model hunch, or arbitrary string is not
a trigger. Evidence records type plus a digest; mailbox content, prompts,
credentials, and tool payloads do not enter adaptation lineage.

There is no free-running self-edit loop. A new adaptation requires a fresh
accepted trigger.

## Diagnose, then reuse

Diagnosis inventories loaded tool names, RAR candidates, memory bindings,
declared permissions, auth, and health before any source is produced.

Order of preference:

1. **REUSE/BIND** an exact, pinned verified capability.
2. **EXTEND** only when a behavior contract proves a gap in an otherwise valid
   data path.
3. **GENERATE** only when no verified capability fits.

For read-only Microsoft 365 email, the full RAPP Agent Registry entry
`@kody-w/workiq` is the preferred reusable provider. Its pinned bytes are
composed with a deterministic thin read-only contract adapter: shadow fixtures
execute that real candidate with provider I/O mocked, while live turns normalize
WorkIQ into structured `messages` or truthful no-data/auth/unavailable states.
The fixture seam is disabled outside `MOLTER_SHADOW`. A generated BuddyRole that
always returns `{"status":"ready"}` has no data path and is diagnosed as a stub,
not as a successful email capability. Email send/reply remains denied unless
separately approved.

Memory is a separate binding, not a code generation. Each twin has a stable,
private namespace in `memory-binding.json`. A twin does not claim persistence
until both recall and save bindings are loaded and verified. Namespaces differ
between twins, preventing cross-twin recall.

## Immutable generations and pointers

The controller and Molter share `MOLTER_HOME`:

```text
MOLTER_HOME/
├── adaptation.json
├── ACTIVE.json
├── memory-binding.json
└── molts/<capability>/gen-NNN/
    ├── agent.py
    ├── molt.json
    └── shadow.json
```

Generation directories are append-only. `agent.py` and generation metadata are
written once and content-hashed. Activation names the exact capability,
generation, base hash, behavior-contract hash, and candidate hash. A live agent
is a normal copied file in the twin's `AGENTS_PATH`; no symlink is required.
Same-directory temporary writes plus atomic rename provide the cross-platform
pointer/materialization swap.

`mutate`, `generate`, and `acquire` now verify and **stage** by default. The
Molter `activate` action requires an exact generation/hash.
Legacy contract-less migration is available only to the trusted host operator
through `MOLTER_LEGACY_COMPAT=1`; it is not present in the `/chat` tool schema.
The adaptation controller never enables it, and elevated permissions still
cannot activate through that path.

## Gates and shadow evaluation

A candidate must pass:

1. trusted AST lineage/import checks;
2. secretless subprocess import and instantiation;
3. declared input/output schemas and bounded golden cases;
4. timeout and process resource limits;
5. permission/import consistency;
6. ready/ack stub detection;
7. deterministic candidate identity;
8. fresh whole-agent-set loader validation.

Shadow cases use redacted fixtures. Network is blocked in the disposable
subprocess; email and provider behavior is mocked. The email contract accepts:

- structured messages when fixture data exists;
- truthful `no_data`;
- truthful `auth_required` or `unavailable`.

A static `ready` acknowledgement is never success.

## Approval and activation

Same-or-lower local/read-only permission candidates can become `activatable`
under policy. New network, data-source, write, send, shell, or credential access
becomes `approval_required`. Approval is a human UI action bound to the exact
candidate hash, behavior contract, base generation, and permission diff.
Semantic controls can inspect, propose, stage, and rollback; they cannot approve
or activate elevated permissions.

Activation atomically materializes the staged bytes, forces fresh loader/tool
registry validation, runs bounded probes, and watches the first configured
turns. Import collision, exception, stub regression, timeout, contract
violation, or unexpected permission request quarantines the candidate and
restores the last-known-good pointer. Restart rehydrates only that healthy
last-known-good head. Source and secrets are never sent to the renderer.

## UI and wire

The twin tile's **Adapt** panel shows diagnosis, REUSE/EXTEND/GENERATE proposal,
permission diff, staged hash, approval state, health, version history,
quarantine, and rollback. Electron IPC carries deterministic local control
events. Twin work still crosses only its existing loopback `POST /chat`; no
Brainstem adaptation endpoint exists.

## beta.10 → beta.11 migration

- Existing Molter `state.json` and `molts/gen-NNN` archives remain readable.
- Existing live generations rehydrate only after their archived SHA-256 is
  verified. Unreadable, symlinked, or tampered archives are quarantined.
- Callers that depended on immediate `acquire`/`mutate`/`generate` activation
  must adopt the controller flow. A host operator can temporarily set
  `MOLTER_LEGACY_COMPAT=1` for migration; chat agents cannot request it.
- A code version and a memory/skill/provider binding are distinct. Updating one
  does not silently change the other.
- When the controller is unavailable, a twin must say adaptation/self-repair is
  unavailable. It must not promise persistent memory or self-repair.

The user's live twins are never migrated or adapted automatically. beta.11
applies when that rapplication is next hatched under the new runtime and the
user explicitly triggers adaptation.
