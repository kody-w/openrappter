# Controlled local dogfood — approval-gated runbook

## Current hard stop

Do **not** point the fixture application at current/live profiles. Do not relabel
a real plan `sanitized-fixture`, change real root namespaces, copy private native
transcripts, or weaken the canonical domain/closure guard to get a green result.

The current executable deliberately accepts only signed sanitized-fixture
authority. A real observed local run is **not yet approved or qualified**.
The release gate stays pending until an operator-owned binding provides the
existing adopted canonical source/domain/closure and signer authority.

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
   cannot be supplied by a boolean field or this runbook. Bind original root
   signers in the trusted host; no fixture keys and no root reminting.

   **This is where the current implementation stops for live data.** Its
   `migration-adoption-unavailable` refusal is intentional. An actual adopted
   binding must be implemented/qualified before continuing; no currently
   working “enable live” flag is implied.

## Controlled execution after the authority gate is satisfied

6. The trusted owner host launches the **new** `MigrationService` and its public
   `MigrationEndpoint` over stdio with the approved plan/authority and a newly
   chosen empty destination. Do not use a current profile as the destination.
   The destination is created only by the application, never seeded by a driver.
   Start a passive projection process before importing the first item.

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

10. Submit the machine evidence and self-contained replay for final human
    integration/cutover acceptance. The old implementation and live profiles
    remain untouched until that decision. Fixture success or a green API is
    never substituted for this controlled-local observed migration.
