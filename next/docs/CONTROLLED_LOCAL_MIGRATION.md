# Controlled local dogfood — approval-gated runbook

## Current hard stop

Do **not** point the fixture application at current/live profiles. Do not relabel
a real plan `sanitized-fixture`, change real root namespaces, copy private native
transcripts, or weaken the canonical domain/closure guard to get a green result.

The packaged CLI deliberately accepts only signed sanitized-fixture authority.
The core now has a separate programmatic injection seam for a trusted owner
host, but this repository ships no production registry, signer custody,
domain/closure verifier, Private Hive verifier or live credential. A real
observed local run is therefore **still PENDING, not approved or qualified**.

## Exact preparation and review sequence

1. Keep the current application/profile running or preserved as-is. Work on
   `rewrite/autonomous-agent-first`, with no push/merge/publication/install.
   Run the full fixture gate first:

   ```sh
   npm --prefix next run check
   npm --prefix next run migration:gate
   ```

2. The owner explicitly selects source paths/objects and read authority. The
   selection must cover the same categories as `fixtures/migration-estate.json`,
   replacing fixture locators with independently reviewed canonical references.
   Never scan a whole home directory or infer authority from a folder name.
   Native-provider selections are safe metadata/opaque native pointers only;
   private content stays excluded unless separately, explicitly authorized.

3. Use the existing authenticated canonical registry/root reader and source
   adapters to produce the exact plan contract in `migration-contract.ts`:
   full root GUIDs; every compatible canonical frame/branch file and its exact
   byte count/SHA-256; capability/artifact closure; selected manager/native
   pointer identity/provenance; explicit historical/unavailable records.
   Classify incompatible application payloads as unavailable pointers—never
   transform them into `next/` payloads.

4. Compare the source selection against the owner's Workspace Manager selection
   and all approved native/provider roots. An omission, unreadable source or
   unknown domain is a blocker recorded in the plan, not a silent skip.
   Freeze source inventories (file hashes/metadata, directory metadata) and
   expected root/scope/form/provider/classification counts.

5. Obtain **final integration approval** plus the adopted canonical authority
   binding for this exact plan hash, full root closure, domain selection and
   target isolation. Required GODD protection and signed PII/domain evidence
   cannot be supplied by a boolean, manifest label or this runbook.

   The trusted host must inject all of the following into
   `openMigrationService`:

   - the authenticated registry containing exactly the selected roots;
   - one independently custodied signer for every selected root, including the
     owner;
   - a `controlledLocal.verify(...)` adapter that verifies the exact owner
     approval wave, plan hash, registry commitment and computed closure
     commitment;
   - signed GODD/DOGG domain-declaration and closure-acceptance waves; and
   - an existing Private Hive acceptance bound to the same owner and plan, with
     its authenticated registry commitment, monotonic sequence and checkpoint.

   Signer/registry probes and this authority verification run **before the
   destination profile is opened**. Missing, revoked, mismatched or malformed
   owner/domain/closure/Hive authority fails closed. Fixture roots cannot be
   relabeled `controlled-local`, and classifications or neutral historical
   records are never rewritten to manufacture adoption. The resulting authority
   evidence hash is bound into the first owner-signed migration control frame;
   restart with a different authority binding refuses rather than rebinding.

   **This is still the operational stop for live data.** The injection contract
   exists, but no production adapter or authority material is included here.
   There is no “enable live” flag and the real cutover remains PENDING.

## Controlled execution after the authority gate is satisfied

6. After an external adapter satisfies step 5, the trusted owner host calls
   `openMigrationService({ directory, plan, approvalBytes, authority,
   capabilityHash })`, then exposes the returned **new** `MigrationService`
   through `MigrationEndpoint`. The `authority` value carries the operator
   registry/signers and the verifier adapter; private keys remain opaque signer
   handles and are never serialized into the plan or evidence.

   Choose a newly empty destination; do not use a current profile. The
   destination is created only after authority binding succeeds and only by the
   application, never seeded by a driver. Start a passive projection process
   before importing the first item.

   The fixture launch syntax demonstrates the interface, **not live authority**:

   ```sh
   # Fixture only. Production must use its qualified owner-bound launch descriptor.
   node next/dist/migration-app.js --fixture \
     --store "<new isolated fixture destination>" \
     --manifest "<signed-selection plan.json>" \
     --approval "<owner-signed approval frame.json>"
   ```

   `RAPP_WORK_MIGRATION_CAPABILITY` is supplied by protected host configuration.
   A public request is:

   ```json
   {"id":"bind-selection","method":"rapp_work_migration_begin","params":{"root":"<exact approved owner RAPPID>"}}
   ```

7. Use only the public methods in `MIGRATION_RELEASE_GATE.md`:
   subscribe/read empty state → begin → start explicit batch → stage each
   approved file chunk or pointer → prepare → commit one item → wait for the
   passive display's matching cursor/addition. Root import preserves all source
   bytes and appends a successor receipt; pointers retain native forms and do
   not carry private transcript content.

8. Retain stable batch/item/request IDs. On interruption, request a canonical
   status snapshot, restart the passive client, repeat identical staged chunks,
   and resume only pending items. Abort an incomplete batch via the public
   rollback operation; never delete/overwrite a committed root. Do not force
   arbitrary stale locks: SIGKILL/power-loss recovery needs an independently
   reviewed owner recovery procedure, not lock stealing.

9. Finish only when the complete selected source inventory is accounted for.
   Restart both service and display, compare exact reconstructed state, source
   inventories, GUIDs, hidden scopes, provenance and original frame bytes.
   Run the exact canonical checker on the destination and review the recorded
   live display/replay and browser checks. A skipped source category, missing
   artifact, duplicate identity, source write or projection gap fails the gate.
   A plan may select at most the repository bound of **64 roots**, including
   hidden roots. The observed capacity regression migrates all 64 and observes
   all 64 through the passive projection; a 65-root plan is rejected before the
   destination is created.

10. Submit the machine evidence and self-contained replay for final human
    integration/cutover acceptance. The old implementation and live profiles
    remain untouched until that decision. Fixture success or a green API is
    never substituted for this controlled-local observed migration.
