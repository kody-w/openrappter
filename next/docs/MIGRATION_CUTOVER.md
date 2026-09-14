# Binding migration and cutover criteria

## Current disposition

**Critical acceptance:** a green API/core is insufficient. The observed
full-estate migration/display test in `MIGRATION_RELEASE_GATE.md` is the release
gate. It runs the new application and a separate passive client, not direct
destination writes by a harness. Fixture success does not authorize release;
the controlled-local runbook remains gated on final integration approval.

This is an isolated headless replacement under `next/`, not a UI extension.
The old `apps/`, all non-adopted runtime packages and production packaging
workflow remain unchanged. Root integration is limited to the greenfield CI
gate, its standalone lockfile, `node_modules` ignore semantics, and an exact
source-only SHA-pinned Python contract/verifier allowlist. No greenfield product is
installed or added to the legacy release package.

The follow-up requirement explicitly authorizes installing the single generic
RAPP Work Bot skill. That narrow instruction-file installation does not install
an application, dependency, live root, MCP configuration or credential, and is
separate from Mirror Mode.

The old implementation must **not** be deleted, replaced, merged, published or
installed as part of this milestone. No live profile has been read into a test,
transformed, adopted or written.

## Measurable headless gates

| Gate | Required evidence |
|---|---|
| Trusted dependency direction | Exactly one adopted old-code boundary, seven fingerprinted wire source files; zero app/UI/service/store imports and no host-shell or alternate database dependency |
| Build | Strict full new-core typecheck and build, no ignored failures |
| Behavior | Complete unit/integration suite, no skips; actual CLI and stdio processes |
| Observed migration | New app starts empty; full selected estate populated only through public API; every bot/world/pointer appears on a separate live passive projection |
| Migration restart/rollback | Exact source prefixes and GUIDs; service+projection restart equivalence; stable retries; rollback after an unpublished materialization fault |
| Source protection | Full source file/directory inventories unchanged; no native private-content import; unavailable archives stay honest pointers |
| Display evidence | Captured canonical cursor/event log and self-contained replay exercised offline in both themes and desktop/mobile widths |
| Catch me up | Deterministic scoped frame/cursor timeline; recorded/reconstructed/unavailable grades, exact source hashes and independently verified state/page digests; no model/tool calls, mutation or hidden reasoning |
| Source-owned exhaust | Exact original root GUID/scope/stream for each action; no central copied activity/recap/peer dissent; causal source vectors, scoped branches, legacy honesty and frames-only rebuild |
| Optional Omarchy replay | Opt-in GODD/private canonical ComputerBroker evidence only; recorded guest frame bytes, reconstructed command/diff summaries, unavailable absence; no host screen/secrets/keystrokes or execution |
| Canonical authority | Exact current rev-15 checkpoint, complete sixteen-frame bootstrap verification and frozen registry agreement |
| Emitted data | Nonzero emitted frames scanned by the exact reference checker; signed collaboration included, `COMPLIANT`, no findings |
| Identity/world | Exact GUID and one Librarian survive restart, hide/restore, scopes and complete retained branches |
| Restart | Byte-identical canonical files, equal projection/transcript, zero model/tool/delivery replay |
| Reviewed intent | Incomplete thought -> proposal/tradeoffs -> exact confirmation -> atomic internal outcome; stale review and authority questions block |
| Human continuity | A reviewed answer can supersede its exact question; history remains intact |
| Autonomy | Explicit recurring intent; deterministic bounded recap, no model/native/external effects while dormant |
| Privacy/authority | No cross-root or sibling-scope context leakage, no source/native writes, deny-all SDK tools, no secret/reasoning persistence, no unauthorized effects |
| Failure/concurrency | Provider/channel outages, non-cooperative cancellation, lost acknowledgements, signed response substitution, concurrent writers, idempotency, correction dependencies |
| Private transport | Default-off production adapter; synthetic contact, outage recap, retry and idempotency tests |
| iMessage authority/custody | Owner-only external inbox, no CLI/gauntlet confirmation, same-publication question markers, private same-user runtime sibling, separate delivery approval, cancellation/preflight/batch/rate/DST/restart gates |
| Domain/Hive | Missing canonical adoption fails closed; no Egg transformation, inference-based classifier, unsigned sharing or identity merge |
| Provider-neutral publication | Copilot/Claude/Hermes/Scout/Grokbot/future labels publish through identical authenticated root APIs; zero model calls and no native-memory import |
| Closed projection | Exact existing-scope/reference validation; no HTML/JS/CSS, DOM selectors, coordinates or executable UI; unsupported hints retain useful work |
| Concurrent AI clients | Root-signed client attribution, explicit causal view heads and conflicts; no identity spoofing or last-writer overwrite |
| Real-time subscriber | Bounded MCP/stdio events, queue bytes/count, rate, replay cursor, reconnect/resync and read-only test-consumer transformations |
| Portable skill | One validated byte-identical instruction file, separate from Mirror Mode; exact setup/capabilities, no embedded credential or authority |

`npm --prefix next run check` runs the complete new-core gates. The E2E proof
uses explicit synthetic adapters and creates two independently signed root bots;
it is not live inference or a production Brainstem demonstration.

## Legacy gates: preserve their meaning

The legacy source gate bans Python by default. It permits only the exact
greenfield paths and SHA-256 values in `contracts/legacy-allowlist.json`; missing,
changed, duplicate or unlisted Python files fail. The exception applies only to
source qualification. Packaged runtime Python remains forbidden, and the old
artifact allowlist still excludes the new product.

**Do not broaden that source-only allowlist to make a green badge.** The retained
baseline at `d8601aa91c10f3330ea10b7fa31382137d981dfd` remains evidence for the
old product. Passing the integrated source gate is **not** release qualification
of `next/`; an independent release constitution and artifact allowlist remain
mandatory.

Native desktop/DMG installation acceptance and browser appearance parity are not
new headless-core gates. No installation or visual implementation was performed.

## Live integration gates before cutover

1. Adopt and verify an external Brainstem binding that hotloads the exact root
   GUID and immutable capability bytes, enforces root/scoped memory and
   cancellation, and cannot expand tools. Do not modify the external grail or
   introduce a second interpreter.
2. Bind an authenticated GitHub Copilot SDK **empty, memory-only** host. Prove the
   actual runtime honors every isolation flag, disables native discovery,
   permits no tools/hidden session stores, and uses Astra max/long without
   fallback. The injected-host declaration is not itself an OS sandbox.
3. Establish independently custodied persistent signers and an authenticated
   registry/checkpoint. Fixture keys must never become credentials. Keyless
   offline roots are valid local RAPP/1 identities, not signed collaboration
   identities; do not remint them to disguise a missing adopted delegation path.
4. Use existing signed Private Hive `RegistryAuthority` / `HiveAcceptance`,
   out-of-band owner anchor, fresh monotonic registry and full immutable
   resolver/checkpoint. Require bilateral consent for the exact room/object;
   ordinary public-perspective grants are insufficient. Never merge roots.
5. Complete signed rooted GODD/DOGG selection and dependency closure adoption,
   plus required GODD protection/transport. Until then all transfer scopes
   refuse. Do not classify paths or remove frames to manufacture compliance.
6. Optionally bind explicit local iMessage OS permission and contact authority;
   remaining disabled is an acceptable product configuration, not a failed
   reason to enable ambient access.
7. Qualify an independent `next/` release constitution and artifact allowlist.
   Retain external anti-rollback checkpoints and recover interrupted writes
   explicitly. Same-UID hostile mutation is outside the in-process trust model.
8. Qualify the operator-owned production AI publication endpoint before giving
   real clients credentials. The packaged fixture bootstrap is not root signer
   custody. The restricted MCP surface must remain separate from local owner
   administration; any future loopback/WebSocket adapter must preserve these
   same bounds, authentication and canonical semantics.

## Migration must be a separate reviewed outcome

Do not copy old UI caches, native AI stores or application databases. Before
adoption, prove full canonical root identity, recursive ancestry, every branch,
artifact closure, authority and exact bytes. An old profile is not silently
converted into this application's payload schema. Pre-release test stores are
not an adoption path.

Require signed owner-authorized migration evidence, read-only rehearsal,
side-by-side restart/projection tests and an explicit human cutover decision.
Rollback means selecting the preserved implementation/data and appending
corrections where appropriate, not overwriting canonical history.
