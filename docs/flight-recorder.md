# Flight Recorder

Flight Recorder is OpenRappter's local, provider-neutral execution ledger. It
answers:

> What context, provider, model, agent, tool, and result produced this outcome?

It records a correlated event stream across an Assistant turn:

```text
trace.started
  context.assembled
  provider.attempt.started
  provider.attempt.completed
  tool.call.started
    agent.execute.started
    context.assembled
    agent.execute.completed
  tool.call.completed
trace.completed
```

The default ledger is SQLite at `~/.openrappter/flight-recorder.db`. OpenRappter
owns that directory and enforces mode `0700`; the database and live WAL/SHM
sidecars are mode `0600`. A custom `OPENRAPPTER_FLIGHT_DB` keeps the mode of an
existing caller-owned parent directory while the database and sidecars remain
`0600`. The operational database is separate: a recorder failure cannot block
an agent response.
Recording is fail-open; inspection is not. A corrupt row makes
`events`/`export`/`import` fail explicitly and updates recorder health instead
of returning an empty history.

TypeScript and Python pin their canonical hash behavior to the same committed
`contracts/flight-recorder-vector.json` fixture, including UTF-16 object-key
ordering, non-BMP Unicode, numeric edge cases, and exact one-to-three-digit
fractional-second parsing.
Exports read one uncapped SQLite snapshot; the 10,000-row limit applies only to
interactive queries, so large active traces remain complete in replay bundles.
Retention removes whole completed traces, never arbitrary rows from the middle
of a replay. Activity is determined by unmatched lifecycle starts in trace
sequence order, so nested traces and clock rollback cannot make an executing
outer trace look completed. Active traces are preserved, so the configured
event count is a target bound when trace integrity requires exceeding it.

## Privacy boundary

Summary events are enabled by default in the TypeScript and Python runtimes.

Raw prompts, responses, tool arguments, tool results, and file contents are
discarded unless explicitly enabled:

```bash
export OPENRAPPTER_FLIGHT_RECORD_IO=1
```

When IO recording is enabled, values are sanitized recursively before they
reach SQLite:

- token, secret, password, credential, authorization, cookie, private-key,
  access-token, and refresh-token keys
- GitHub tokens, AWS access keys, bearer tokens, credential-bearing URLs,
  password connection strings, and PEM private keys
- `.env*`, `.ssh`, `.aws/credentials`, `.copilot_token`, credential files, and
  `.pem`, `.key`, or `.p12` paths
- prototype-pollution keys and circular values
- secret-shaped or excluded-path property names, replaced with deterministic
  collision-safe markers; contents under excluded filenames are removed

Payloads are capped at 16 KiB after redaction. Oversized values are replaced by
an explicit truncation marker rather than silently clipped into invalid JSON.

This is local-first, not secret-proof. If you enable raw IO, the resulting file
is sensitive even after automated redaction. FileVault or equivalent
full-disk encryption is still recommended.

## Commands

The `flight` command is the TypeScript CLI inspection surface. The Python
runtime records the same event schema and exposes the equivalent
`openrappter.flight_recorder` API.

```bash
# Health, event count, errors, database path
openrappter flight status
openrappter flight status --json

# Privacy-safe summaries
openrappter flight events --limit 50
openrappter flight events --trace <trace-id> --json
openrappter flight events --session <session-id>
openrappter flight events --kind provider.attempt.failed

# Versioned bundle for replay/evals
openrappter flight export --trace <trace-id> --output trace.json
openrappter flight import trace.json

# Destructive and explicit
openrappter flight clear --yes
```

Exported files atomically replace their destination at mode `0600`, including
when an older file had broader permissions. They use:

```json
{
  "schema": "openrappter-flight-export/1.0",
  "exportedAt": "2026-08-11T00:00:00.000Z",
  "events": []
}
```

Every event carries `openrappter-event/1.0`, a trace-local sequence, a SHA-256
integrity hash, and optional session/workspace/provider/agent/tool identities.
Session identifiers are stored as stable `session:<hmac-sha256-prefix>` values so
channel keys cannot persist phone numbers, email addresses, or chat GUIDs.
They are keyed with a private per-installation HMAC secret stored beside the
database at mode `0600`, preventing offline dictionary guesses from an export.
Session filters accept the original identifier and normalize it before lookup.
Absolute workspace paths are stored as stable `workspace:<sha256-prefix>`
identifiers rather than persisted verbatim.
`auto` is recorded as `metadata.modelPolicy`, not as the model identity: when
the provider does not reveal the selected model, the `model` field stays absent
rather than turning a routing policy into a false attribution.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `OPENRAPPTER_FLIGHT_RECORDER` | `1` outside tests | Set `0` to disable recording |
| `OPENRAPPTER_FLIGHT_DB` | `~/.openrappter/flight-recorder.db` | Override database path |
| `OPENRAPPTER_FLIGHT_RETENTION` | `10000` | Target retained events; active and newest replayable traces may exceed it |
| `OPENRAPPTER_FLIGHT_RECORD_IO` | `0` | Opt into sanitized raw IO |
| `OPENRAPPTER_FLIGHT_MAX_PAYLOAD` | `16384` | Post-redaction payload byte cap |
| `OPENRAPPTER_FLIGHT_ID_KEY` | installation key | Optional 64-hex HMAC key override |

## Runtime boundary

Copilot CLI tools in the TypeScript runtime run in a child MCP process. The
provider passes the active trace, parent, session, and workspace scope through
the child environment; the MCP server then records a tool-to-agent subtree in
the originating trace. Direct providers and in-process tool calls are likewise
correlated, including telephony, Surgeon, LearnNew, Ouroboros, and readiness
probes.
