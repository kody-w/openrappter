# RAPP media hook for an existing iMessage watcher

This is a **local source hook**, not another bot, LaunchAgent, Messages account,
network server, or model provider. It must be called by the existing watcher.
It does not start OpenRappter, OpenClaw, Brainstem, a Claude MCP channel, or an
`imsg watch` subscription. Do not call Brainstem discovery, `/chat`, `/health`,
or `/api/agent` to integrate it.

The route is:

```text
existing watcher tick
  -> authorized new Messages rows + private attachment staging
  -> explicit local JSON task adapter (submit/approve/status/result/...)
  -> existing durable copilot_jobs
  -> private ordered transport outbox
  -> pinned imsg 0.12.3 / AppleScript / original iMessage chat
```

The task adapter owns jobs, permission profiles, approvals, workers, recovery,
and intentional artifact manifests. This hook owns only intake cursors,
readiness, staged references, notification deduplication, and delivery records.

## Commands in the shared thread

Only `RAPP …` / `RAPP: …` addresses this portal. Case does not matter.

| Message | Action |
| --- | --- |
| `RAPP <task>` or `RAPP run <task>` | Prepare a task; **does not execute it**. |
| `RAPP file report.txt \| <task>` | Explicitly declare one passive output basename for this task. |
| `RAPP files image.png,clip.mp4 \| <task>` | Explicitly declare a bounded batch of output basenames. |
| `RAPP attach` | Open a bounded file-only intake window for this sender/thread. |
| A photo/video/audio/file after `RAPP attach` | Stage it and acknowledge a useful next step; never execute file contents. |
| `RAPP <task>` with files attached | Wait for all observed files, then prepare the task with their references. |
| `1` / `2` | Approve / cancel the **single** unexpired pending task in the same sender/thread, after its notice is confirmed sent. |
| `RAPP approve <job-id>` | Approve that exact locally pending job using its stored, finite token. |
| `RAPP status [job-id]` | Worker state and honest native output states. |
| `RAPP list` | Bounded list of jobs scoped by the local adapter to this actor. |
| `RAPP result [job-id]` | Bounded result text and deliberately declared file artifacts. |
| `RAPP stop [job-id]` / `RAPP cancel [job-id]` | Request cancellation, not an invented successful exit. |
| `RAPP resume [job-id]` / `RAPP recover [job-id]` | Reconcile durable state; does not confer new permissions. |
| `RAPP retry <job-id>` | Retry only confirmed failed output parts; never successful or uncertain parts. |
| `RAPP resend <part-id>` | Explicitly redeliver one uncertain part **after checking the phone**; the old attempt may still arrive. |
| `RAPP clear files` | Clear the pending file selection and close its intake window. |
| `RAPP help` | Explain routing and these commands. |

When several tasks await approval, bare numbers cannot select one. Use an exact
job id. Bare numbers also require the immediately preceding message in the
chat to be that confirmed approval card: another AI's prompt, a different
conversation turn, or an intervening status reply requires explicit
`RAPP approve <job-id>` instead. Attachment-only messages outside an armed intake window belong to the
rest of the conversation and are not opened, acknowledged, or executed by this
portal. A successful task submission consumes the selected files and closes
the upload window. A task following a still-downloading selected upload waits;
it does not silently run without that input.

Unprefixed wake/restart/shutdown commands retain their existing Claude
lifecycle behavior. A RAPP-addressed task mentioning “restart” must bypass the
legacy lifecycle regexes using the guard below.
The guard also excludes the portal's `[RAPP …]` reply envelopes from lifecycle
matching, including self-chat echoes of help text that mentions “restart”.
Those reply envelopes are never parsed as new portal commands.

For a normal deployment, keep local `artifact_paths:[]`: an ordinary
`RAPP <task>` then requires no report file. Request a file explicitly, for
example `RAPP file report.txt | summarize the selected input`. The transport
passes `artifact_paths:["report.txt"]` separately from the task prose, displays
it in approval, and the runtime's generation instructions tell the worker to
create that exact file in its isolated workspace. Choosing the basename does
not add tools, directories, destinations, or permission flags.

### Transport is not automatic content understanding

Receiving/sending an audio or video file does not itself transcribe, interpret,
play, or stream it. This hook does not implement automatic voice-command
transcription, continuous microphone/video capture, or a livestream. It passes
confined file references to an explicitly approved task. Any transcription,
image/video analysis, extraction, or synthesis requires suitable tools and
permissions in that task's locally configured runtime profile. Do not infer
those capabilities merely because native file delivery succeeds.
Screenshots and short clips can be ordinary attachments when explicitly
requested, approved, and produced with actually available permitted tools.
That is not continuous interactive desktop access or a livestream.

## Private configuration

Create a local mode-`0600` JSON file, outside source control. The configuration
must explicitly bind **both** a normalized sender handle and an exact Messages
chat GUID. Never populate these fields from message text, a model response,
attachment metadata, or display names. Existing allowlist policy is not
expanded by this feature. Obtain and validate the real binding locally.

Example structure only; all identities and absolute placeholders below are
synthetic and must be replaced locally:

```json
{
  "state_dir": "~/.claude/channels/imessage/portal",
  "messages_db": "~/Library/Messages/chat.db",
  "imsg_path": "~/.openrappter/bin/imsg",
  "runtime_argv": [
    "/absolute/path/to/python3.12",
    "/absolute/path/to/rapp_brainstem/agents/copilot_cli_agent.py",
    "--portal-config",
    "/absolute/path/to/private-job-config.json"
  ],
  "authorized": [
    {
      "sender": "owner@example.invalid",
      "chat": "iMessage;-;SYNTHETIC-EXAMPLE",
      "allow_group": false,
      "allow_from_me": false
    }
  ],
  "incoming_roots": ["~/Library/Messages/Attachments"],
  "artifact_root": "~/.brainstem/copilot_jobs",
  "profile": "a-locally-configured-finite-profile",
  "artifact_paths": []
}
```

Set the job adapter's `staging_root` to the hook's private `state_dir/inbox`,
and its `jobs_dir` to this hook's `artifact_root`. Align the two configurations'
byte limits; the 100 MiB transport ceiling does not override a stricter job
profile limit. The native fields `original_path`, `total_bytes`, `uti`, etc.
are never forwarded as task-attachment fields: only the newly staged
`{path,name,mime,size_bytes,sha256}` reference is passed.

Leave default `artifact_paths:[]` for ordinary text tasks. `RAPP file`/`files`
creates an explicit per-task declaration without selecting a different
permission profile. Names are bounded basenames with passive media/document
extensions, not absolute paths, traversal, executables, destinations, or CLI
flags. Deliberately configured default paths are also supported and must have
distinct basenames; they are mandatory outputs for tasks that use them.
Every declaration appears in the normal finite approval card. A missing tool
or permission requires a new approved task under a suitable already-configured
profile, never automatic escalation.
The card displays the local profile's available tools, explicit allow/deny
grants, extra directories and URL grants. Those values come only from the
owner-only runtime configuration, never from model text or attachment metadata.
The hook retains the selected policy snapshot and refuses a preparation that
observes it changing. The runtime independently binds and rechecks the effective
policy at approval/execution. These CLI permissions are not an OS sandbox.

The runtime validates the declared workspace files and publishes a complete
snapshot batch in `jobs_dir/<job_id>/artifacts/` with unique job-prefixed
basenames. The hook sends **those immutable exports**, not a mutable workspace
file or a pathname mined from model text. It checks the original declared
name, stable artifact ID, job-specific export directory, regular-file/link
safety, size and SHA-256 before making its own native outbox copy.
No upload service or public-link fallback exists.

Group chats require `allow_group:true` on the exact sender/chat pair and a
matching current participant roster. A roster change creates a new numbered-
approval context and pauses old-group output delivery rather than sharing
an old task's results with new members. Self-chat input from the local account
requires explicit `allow_from_me:true`, a non-group chat, and a self-only
roster. Messages' `is_from_me` does not prove which device or program authored
a self-chat message; do not mistake this opt-in for device attestation.

Optional bounded settings include `max_file_bytes` (cannot exceed 100 MiB),
`max_files` (default 8), `stable_seconds` (1), `readiness_seconds` (120),
`attachment_window_seconds` (600), `receipt_seconds` (180),
`progress_seconds` (60), `events_per_tick` (32), `parts_per_tick` (4),
`runtime_timeout` (10), and `native_timeout` (30).

## Exact additive install hook — operator deployment only

No installer changes or restarts the live watcher. Preserve its existing
sentinel outbox, heartbeat policy, state files, launch configuration, and
lifecycle implementation. In its **local** source, add:

```bash
# Locally chosen interpreter, checked source checkout, and private configuration:
RAPP_PORTAL_PYTHON="/absolute/path/to/python3.12"
RAPP_PORTAL_SOURCE="/absolute/path/to/this/source-checkout"
RAPP_PORTAL_CONFIG="/absolute/path/to/private-portal.json"
source "$RAPP_PORTAL_SOURCE/scripts/imessage-portal-watcher-hook.sh"
```

In the existing outer polling loop, after its sentinel outbox drain:

```bash
imessage_portal_tick || true
```

Inside the existing per-message loop, after text decoding/trimming and
**before** the legacy wake/restart/shutdown regex branches:

```bash
if imessage_portal_owns_text "$text"; then
  continue
fi
```

All three additions are required. The guard prevents a RAPP task containing a
lifecycle keyword from triggering Claude as well. The hook starts no process
at shell-source time and has no autonomous `run`/daemon mode.

Use `check-config` before deployment:

```bash
python3.12 scripts/imessage-portal.py --config /absolute/private-portal.json check-config
```

At first operator-controlled `tick`, the portal records the current maximum
row id. It does **not** replay pre-install private history. Begin live smoke
inputs only after that initial cursor is established. Subsequent restarts
retain the cursor, GUID ledger, bounded late-chat-join lookback, staged inputs,
approval correspondence, outbox parts, and receipts.
The hook passes a watcher-instance marker to its bounded ticks. Owned
nonterminal tasks are reconciled through the local adapter's `recover` on
watcher restart and periodically, without replaying execution or signalling
stored PIDs.

```bash
python3.12 scripts/imessage-portal.py --config /absolute/private-portal.json tick
python3.12 scripts/imessage-portal.py --config /absolute/private-portal.json transport-status
```

Tick output contains counts/error codes, not handles, chat ids, prompt bodies,
tokens, or attachment contents. A corrupt state file fails closed instead of
resetting deduplication. Do not run a second copy with another state directory.
A future Claude wake/replay cannot bypass the portal's persisted source GUID
and task request-id deduplication; portal replies have non-command `[RAPP …]`
prefixes. Keep the shared-thread ownership rule in any future channel setup.

## Frozen local runtime envelope

The only subprocess entry is the explicitly configured four-element
`[python, copilot_cli_agent.py, "--portal-config", private_config]` argv.
One JSON request is written to stdin, stdin closes, and one bounded JSON
envelope is read. A nonzero process exit can still carry an explicit
`{ok:false,error:{code,message}}`; it is not converted into a success.

`job.job_id`, `job.status`, `job.request_id`, `job.profile`,
`job.model` (`gpt-6-astra`) and `job.artifact_paths` identify the bound task.
`approval.{token,expires_at,binding}` is returned only for submission and is
kept out of model context. Approval always requires a new verified human action
mapped to the exact job/token.

`status` and `result` return `stdout`/`stderr` objects with
`{text,next_offset,total_bytes}` and stable events plus `next_event_offset`.
The hook persists **byte** cursors, not character counts, and bounds automatic
progress messages. `result.result` is `null` until terminal and then contains
`{status,exit_code,error,response,response_truncated,artifacts}`. Each artifact
contains `{id,path,name,size_bytes,sha256}` and optional descriptive `mime`.
No `relative_path` or workspace field is required from the runtime.
The hook derives and validates the approved job export root locally.
Job IDs must match `[0-9]{8}-[0-9]{6}-[0-9a-f]{32}`. An artifact ID must be
`<job_id>:artifact:<index>` for an approved declaration index, its `name`
must match that declaration's basename, and its path must equal
`artifact_root/<job_id>/artifacts/<job_id>-<index:02d>-<name>`.
An arbitrary filename that merely shares the job prefix is not sufficient.

An outer `ok:true` only means the query succeeded. A failed/interrupted task
still displays its error and actual/unknown worker exit code. Unconfirmed
worker cleanup is explicitly reported as potentially continuing execution.
Partial/unsafe declared artifact batches are not published.

## Native media and receipt contract

The managed executable is explicitly pinned to `~/.openrappter/bin/imsg`
**0.12.3**, not an older `imsg` found on `PATH`. Reusing it does not activate an
OpenRappter service. It requires the logged-in Messages session, Full Disk
Access, and Automation permission. No SIP change or private bridge is used.

Native RPC sends specify:

```json
{
  "method": "send",
  "params": {
    "chat_id": "<verified original numeric target>",
    "text": "[RAPP artifact <unique part token>] <safe filename>",
    "file": "<private, verified outbox copy>",
    "service": "imessage",
    "transport": "applescript"
  }
}
```

The actual envelope also carries `jsonrpc:"2.0"` and a request id. The code
passes integer `chat_id`, not the illustrative placeholder above.

**Outbox file parts include an identifying caption, but captions are not the
delivery fix.** An operator's valid file-only audio send returned `-32603`
after the helper observed an unjoined outgoing row; that **same attempt later
joined its chat/attachment and became delivered without any retry**.
`SentMessageVerifier.swift` in pinned upstream skips normal row discovery for
empty text and invokes an early ghost-row heuristic. An error from that
heuristic is therefore not reliable evidence of a failed transfer.

The fix is to persist attempt identity, unique filename, and the pre-send
watermark **before invoking native send**, then reconcile the actual attachment
even after native throws. The low-level client supports file-only requests;
both file-only and caption-plus-file errors have the same conservative unknown
semantics. The outbox's captions help identify results and suppress echoes;
they neither establish delivery nor justify a native Swift fork.

Native text and attachment are separate rows. A returned send GUID can identify
the **caption**, so it is retained only for echo suppression on a file part.
Attachment confirmation requires the exact original chat, a row newer than
the pre-send watermark, an outgoing event within the send window, and the
unique outbox filename. Only that attachment's GUID is queried with
`message.send_status`. Native transcoding may change file bytes/size; original
SHA-256 is used to protect the intentional *input* to Messages, not to demand
byte identity from the delivered/transcoded attachment.

Parts have separate `queued`, `submitting`, `submitted`, `sent`, `delivered`,
`failed`, and `unknown` states. A crash during submission becomes unknown.
An RPC timeout, child/protocol failure after write, or internal native error
never triggers an automatic resend. Later parts in that result wait behind an
unaccepted earlier part. In particular, a file's caption/submission alone
cannot unlock the next file: the exact attachment must reach native `sent` or
`delivered` first. Confirmed failed parts can be retried without
repeating successful ones. An explicit uncertain resend uses a new unique
attempt marker and retains the previous attempt.
An unknown native exception is reconciled during the bounded receipt window
before an automatic “check your phone before resending” notice is queued.
`RAPP status` can show the uncertainty immediately. Late native success can
resolve an unknown attempt to sent/delivered without a second send.

`ok:true` from native send means **submitted**, not delivered. `sent` is not
`delivered`. Native `delivered` is a transport acknowledgement, not evidence
that someone viewed, played, heard, or opened the file on the phone.

Inbound native field names are `original_path`, `total_bytes`, `mime_type`,
`transfer_name`, and optional `missing`; no `path`/`byte_size` assumption.
Only authorized iMessage events can cause an attachment query or file open.
The hook checks confinement, no symlinks, regular-file type, byte limits,
stable metadata/size, and copy-time integrity. Missing/cloud-only files are
waited on for a bounded period; the hook cannot force a Messages download.
It emits an explicit failure rather than inventing file readiness. Optional
native conversion is not enabled: original media remains available to the
approved task.

## Synthetic validation, then separately authorized real acceptance

Run the focused suite with an existing Python 3.10+ pytest environment.
`--noconftest` deliberately avoids unrelated repository fixtures that import
Brainstem. No dependency install is required when pytest is already available.

```bash
mkdir -p .test-artifacts/home
PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 \
  HOME="$PWD/.test-artifacts/home" TMPDIR="$PWD/.test-artifacts" \
  /absolute/path/to/existing-pytest-python -m pytest -q --noconftest \
  -p no:cacheprovider --basetemp=.test-artifacts/pytest \
  python/tests/test_imessage_portal.py
bash -n scripts/imessage-portal-watcher-hook.sh
```

Set `PORTAL_RUNTIME_ENTRY=/absolute/approved/rapp_brainstem/agents/copilot_cli_agent.py`
on the same test invocation to include the three real-local-adapter integration
tests. They create their own private synthetic runtime configuration and fake
Copilot executable, exercise prepare/approve/result and immutable exports, and
use a mocked native sender. Without that variable they are explicitly skipped.
Use the runtime revision with working platform-safe worker supervision; a
platform failure is an actual failed integration, not something to relabel as
an inference or transport success.

Tests use synthetic identities, fixture SQLite, project-local HOME/state,
harmless files, fake native RPC, and a fake job adapter. They do not send,
infer, import Brainstem, read private history, or start services.
`imsg --db <fixture>` isolates reads **but does not sandbox AppleScript sends**;
never invoke native `send` as a fixture-test shortcut.

The operator separately validates real authorized PNG, M4A, MP4, and file
transfers, correlates each actual attachment receipt, and checks phone
rendering/receipt. Stop on ambiguous native failure rather than cascading
unverified sends. Synthetic inbound staging, native submission, native
delivery acknowledgement, and actual phone receipt remain separate claims.

### Operator-reported native qualification, 2026-09-21

The existing native helper—not a deployed portal—was separately exercised
against the existing authorized DM with nonprivate synthetic files:

| File | Immediate native RPC behavior | Subsequent exact attachment receipt |
| --- | --- | --- |
| PNG plus caption | Returned the caption GUID, not the media GUID | Sent and delivered, error 0, transfer state 5 |
| AAC/M4A, file-only | Premature `-32603` unjoined-row exception | The same single attempt later sent and delivered, error 0, transfer state 5 |
| H.264/MP4, file-only | Premature `-32603` unjoined-row exception | The same single attempt later sent and delivered, error 0, transfer state 5 |
| TXT, file-only | Premature `-32603` unjoined-row exception | The same single attempt later sent and delivered, error 0, transfer state 5 |

Each was sent exactly once; there were no blind retries. Native PNG/video
encoding changed byte counts, reinforcing that delivery correlation cannot
require byte identity with the original file. This is native outbound
evidence only. It does not establish portal deployment, the actual inbound
phone path, playback/rendering, automatic transcription, or content analysis.
