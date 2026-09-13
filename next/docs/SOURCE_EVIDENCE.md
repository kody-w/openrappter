# Prototype evidence used, not imported

Evidence was read from the supplied session's `files/` directory. These reports
are historical implementation evidence, not authority over the new root data.

| Evidence | Principle adopted |
|---|---|
| `local-workspace-discovery-result.json` | Bounded metadata observation, historical uncertainty, no automatic workspace creation and no source writes |
| `multibot-transcript-validation.json` | Distinct root GUID speakers; signed guidance/echo; exact occurrence binding; explicit public context; retain disagreement |
| `rapp-work-egg-result.json` | Complete canonical history and branch retention, same-root byte identity, no replay on restart |
| `bot-guid-result.json` | The full canonical RAPPID is the bot GUID, not a tail, display name, locator or child workspace |
| `root-admission-result.json` | No domain inference from paths, no mixed-frame filtering, and no scope transfer without signed adoption/closure |
| `shared-runtime-result.json` | One shared spine, independent root scopes; the actual external data-only hotload binding was not established |
| `copilot-bot-bridge-validation/validation-summary.json` | Injected Copilot transport, canonical emitted-frame/restart evidence, no live-profile changes |
| `domain-authority/rapp_hive.py` and `bundle.py` | Structural labels are not signed authority; use existing registry/acceptance and exact-byte protection boundaries |

Current canonical protocol selection was verified independently against
`kody-w/rapp-1` main: `dda32d741c7218f41443a5bd17eebfe0eae82cb7`, rev-15,
head `83ca275f35cca96e43d75c99d338326c1a39b2240eabf57eb7c29ac96cc90818`.
The full accepted authority bytes and exact checker are retained unmodified.

The only adopted old implementation source is the independently isolated
wire/crypto primitive package, fingerprinted in `adopted-primitives.json`.
No old UI, conversation state machine, workspace store, model-provider service,
agent runtime or domain package is imported.

The Private Hive boundary was checked against the existing public
`RegistryAuthority` / `HiveAcceptance` contract at
`kody-w/RAPP@0a15ebd0d79e0502606755ad4df1432dcb6e1f59`.
No live Hive, native estate, provider profile, Messages store or external
Brainstem process was inspected or activated by the new-core tests.
