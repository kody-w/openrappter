# rapp-bubbles — RAPP's iMessage bridge for an existing watcher

rapp-bubbles (formerly the RAPP iMessage portal / media hook) is our
BlueBubbles-inspired bridge: RAPP tasks, approvals, media, operator updates,
and Messages health from one authorized iMessage thread.

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
| `RAPP attach` | Open a bounded file-only intake window for this sender/thread. |
| A photo/video/audio/file after `RAPP attach` | Stage it and acknowledge a useful next step; never execute file contents. |
| `RAPP <task>` with files attached | Wait for all observed files, then prepare the task with their references. |
| `1` / `2` | Approve / cancel exactly the task of the confirmed, still-live approval card the number sits right under (or swipe-replies to). |
| `RAPP 1` / `RAPP 2` | Approve / cancel only when the card answered (the one a swipe-reply quotes, else the newest card sent before you typed) is that task's live approval card; otherwise they pick that card's options. |
| `RAPP approve <job-id>` | Approve that exact locally pending job using its stored, finite token. |
| `RAPP status [job-id]` | Worker state and honest native output states. |
| `RAPP list` | Bounded list of jobs scoped by the local adapter to this actor. |
| `RAPP result [job-id]` | Bounded result text and deliberately declared file artifacts. |
| `RAPP stop [job-id]` / `RAPP cancel [job-id]` | Request cancellation, not an invented successful exit. |
| `RAPP resume [job-id]` / `RAPP recover [job-id]` | Reconcile durable state; does not confer new permissions. |
| `RAPP retry <job-id>` | Retry only confirmed failed output parts; never successful or uncertain parts. |
| `RAPP resend <part-id>` | Explicitly redeliver one uncertain part **after checking the phone**; the old attempt may still arrive. |
| `RAPP clear files` | Clear the pending file selection and close its intake window. |
| A reply directly under an operator update with options | Answers that update (numbers pick its options); see the operator feed. |
| `RAPP reply <text>` | Answer the latest open operator update even after other messages. |
| A digit right under (or swiped onto) a card, or `RAPP <n>` for the newest card | Pick that card's numbered option; on a live approval card, 1/2 approve/cancel that task. |
| `RAPP quiet [job]` | Stop a running task's automatic ETA updates; its result still arrives. |
| `RAPP health` | iMessage verdict, free disk, journal size, and outbox states as one card. |
| `RAPP help` | Explain routing and these commands. |

A number answers one card, never "the only pending task". A bare `1`/`2` approves or
cancels the task of the approval card it answers: the message it swipe-replies to (any
bubble of a long card), or else the row directly above it, which must be that confirmed
approval card's last bubble, so two waiting tasks are never confused. Another AI's prompt, a different conversation turn,
or an intervening status reply requires `RAPP 1` / `RAPP 2` (newest card only) or
`RAPP approve <job-id>` instead. A bare number directly under an open operator update
answers that update instead. The latest-card lookup checks the preceding row in the
exact chat, including foreign outbound rows that are not eligible user commands, and
skips tapback reactions, which are not messages. Attachment-only messages outside an armed intake window belong to the
rest of the conversation and are not opened, acknowledged, or executed by this
portal. Task ingestion freezes the preceding upload event identities, rather
than reading a mutable “most recently downloaded files” list later. Inputs
resolve in source-message row order and attachment ordinal order. A task
following a still-downloading selected upload waits; it does not silently run
without that input or absorb a later upload that downloads faster. Later
unconsumed uploads remain available for the next requested task.
For a file-only event awaiting native text decoding, its authorized intake
eligibility and conversation generation are committed on the **source event**
before decoding starts. Another ordinary task closing the intake window
cannot revoke that already-admitted upload. Explicit `RAPP clear files` or
`RAPP attach` advances the generation and invalidates the old pending intake;
rearming cannot retroactively admit earlier out-of-window files. An older
pending record without durable admission evidence fails explicitly and asks
for rearm/resend instead of guessing permission.

Capture completion and its acknowledgement enter the same atomic transport
journal commit. Stable source GUIDs and attachment ordinals prevent a crash
after acknowledgement from appending the captured references again. A
successful task consumes only its frozen selection; it closes the upload
window when no later unconsumed upload remains.

Unprefixed wake/restart/shutdown commands retain their existing Claude
lifecycle behavior. A RAPP-addressed task mentioning “restart” must bypass the
legacy lifecycle regexes using the guard below.
The guard also excludes the portal's `[RAPP …]` reply envelopes from lifecycle
matching, including self-chat echoes of help text that mentions “restart”.
Those reply envelopes are never parsed as new portal commands.

Local `artifact_paths` must be omitted or `[]`; a nonempty fixed output list is
rejected at configuration validation. An ordinary `RAPP <task>` always submits
`artifact_paths:[]` and requires no report file. Request one file explicitly, for
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
Preserve the native GUID exactly, including an `any;-;...` or `any;+;...`
scheme when that is what Messages stores; never rewrite it to `iMessage`.
The GUID is identity, not service authentication. New-event polling requires
both the chat's `service_name` and the message's `service` to be iMessage.
Outbound target validation requires the exact configured GUID/numeric chat
mapping and actual iMessage chat service; SMS, RCS, and missing/unknown service
metadata fail closed. Existing DM/group style and group-roster checks still
apply, and native text/receipt lookups retain the exact GUID binding.

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

Leave `artifact_paths:[]` for ordinary text tasks. Only `RAPP file <name> | <task>`
creates an explicit single-file declaration without selecting a different
permission profile. Names are bounded basenames with passive media/document
extensions, not absolute paths, traversal, executables, destinations, or CLI
flags. The plural `RAPP files` command is not supported in this iteration.
Receiving multiple attachments remains supported; it does not declare outputs.
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
python3.12 scripts/rapp-bubbles.py --config /absolute/private-portal.json check-config
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
Status and recovery have finite per-tick budgets and choose the least-recently
checked eligible jobs, rather than the first inserted jobs. Restart recovery
is tracked per job so a batch boundary cannot skip the remaining jobs when
the watcher generation changes.

```bash
python3.12 scripts/rapp-bubbles.py --config /absolute/private-portal.json tick
python3.12 scripts/rapp-bubbles.py --config /absolute/private-portal.json transport-status
```

Tick output contains counts/error codes, not handles, chat ids, prompt bodies,
tokens, or attachment contents. A corrupt state file fails closed instead of
resetting deduplication. Do not run a second copy with another state directory.
A future Claude wake/replay cannot bypass the portal's persisted source GUID
and task request-id deduplication; portal replies have non-command `[RAPP …]`
prefixes. This protects **this portal** against repeated intake; it does not
control a different responder's execution.

### Supported exclusive-inbox cutover and rollback

The lifecycle guard and portal GUID ledger do not control another reader.
Use supported plugin controls and existing reader configuration, not a vendor
cache patch, plugin fork, guessed channel hook, or natural-language request to
ignore RAPP. `dmPolicy:"disabled"` alone is insufficient because self-chat
bypasses it. Omitting channel flags stops pushed events, but does not prevent
history-tool reads or a startup prompt from consuming the inbox.

1. Back up the native plugin setting, watcher startup configuration, and legacy
   reader configuration/checkpoint locally with their private permissions.
   Keep the portal inactive during the ownership transition. Identify and
   exclude existing Claude sessions and plugin reader processes: a setting
   change does not revoke their already-loaded code or admitted work.
2. Disable the official plugin through
   `claude plugin disable imessage@claude-plugins-official --scope user` and
   verify the effective setting is false. This affects **all configured
   inboxes of that plugin**, including groups and self-chat, not just the
   portal owner. Its MCP tools are disabled too; the separate existing
   sentinel/native outbound activity feed remains unaffected.
3. Gate the local Claude wake script on a private portal-enabled marker. While
   it exists, launch a **fresh** session, explicitly set
   `enabledPlugins["imessage@claude-plugins-official"]` to `false` in supported
   per-session settings, and omit channel enablement, `--continue`, `--resume`,
   and history-catch-up prompts. A future wake must not restore the competing
   inbox reader through resumed context or a more specific plugin setting.
4. For an overlapping legacy reader, atomically remove only the portal owner's
   configured raw handle variants from its allowlist, preserving every other
   entry and setting. The resulting allowlist must remain **nonempty**: an
   empty legacy list is a wildcard. Stop that reader through its existing
   controls, observe that it has stopped rather than trusting stale health,
   and establish a fresh current-MAX message fence in its existing checkpoint.
   Then restore its prior start/auto-start behavior for the remaining actors,
   with the portal owner still excluded. This preserves their authorization;
   the fence skips old reader backlog, not old job records. Neither stopping
   the poller nor advancing the fence proves admitted jobs or replies drained.
   Account for that in-flight work separately before activating the new route.
5. Activate only the existing watcher's portal hook after the exclusions and
   cutover checks. No Grail edit, core-process restart, new bot, or network
   service is required. Background native delivery and actual phone ingress
   are separate acceptance checks, not consequences of a plugin setting.

For rollback, first stop portal intake and exclude its active dispatch before
restoring any competing reader. Preserve the transport journal and unresolved
send records; do not reset them or blindly resend. Restore the backed-up
native startup/reader configuration and private permissions under the same
single-owner cutover discipline, then remove the marker/session override.
If the plugin was previously enabled, restore it through
`claude plugin enable imessage@claude-plugins-official --scope user` and verify
the effective setting. Do not bypass the marker or enable both inbox owners
at once. Native outbound feed configuration remains independent throughout.

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

MIME is descriptive, not an exact transport gate. A validated approved `.m4a`
export is accepted with Python's `audio/mp4a-latm`, Messages'
`audio/x-m4a`, `audio/mp4`, or another advisory alias without changing its
extension/container. Native `send` receives the verified file, not a MIME
override. The focused tests independently generate/probe harmless AAC/M4A
fixtures with existing ffmpeg/ffprobe before checking these aliases.
The transport does not claim to analyze every file's codecs: production
content/container qualification remains with the approved media-generation
tools and the separately verified native transfer, rather than trusting the
MIME string as proof of valid media.

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
the pre-send watermark, an outgoing event created within the persisted attempt window, and the
unique outbox filename. Only that attachment's GUID is queried with
`message.send_status`. Native transcoding may change file bytes/size; original
SHA-256 is used to protect the intentional *input* to Messages, not to demand
byte identity from the delivered/transcoded attachment.

Each attempt commits its actual start and both creation-time bounds before
native send: `[submitted_at - 2 seconds, submitted_at + receipt_seconds)`,
matching the native start-inclusive/end-exclusive filter. Native receipt
history is queried with both bounds. Later discovery
of an in-window row may still resolve an unknown attempt after the window has
elapsed; a row **created** outside the window cannot, even if its filename
matches. Restart or later configuration changes do not extend a persisted
attempt window. This does not authorize an automatic resend.

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

For modern `m.text=NULL` messages, the hook uses the pinned native helper's
decoder, not its own typedstream string heuristic. Authorization precedes the
lookup; it is bounded to the exact configured chat/sender, a short timestamp
window, and the exact row/GUID, with `attachments:false`. The helper is passed
the configured database explicitly. Decode readiness is journaled across
ticks/restarts and times out with an explicit error rather than silently
discarding a potentially addressed message. Known audio-message metadata is
kept as attachment input and is never promoted from automatic transcription
into an approval/command. Actual phone-path acceptance remains separate.

## iTUI: messages laid out like a terminal UI

Every rapp-bubbles message is plain iMessage text framed as a small terminal card (the
owner named it "iTUI"). The design is the majority solution of eight independent
strategy reviews (failure modes, competitors, phone journeys, red team, SRE, simplicity,
test oracle, agent-first).

```text
[RAPP 9c1e] ● ~4m left
▰▰▰▰▱▱▱▱▱▱ est
6m of ~10m (5 runs)
──────────────
render the promo video
──────────────
[1] Details
[2] Stop
[3] Quiet
next ~5m · ref 3fa9c1
```

- **Line one is the lock-screen line**: the `[RAPP <ref>]` envelope (which the legacy
  watcher's guard ignores), a status glyph (`? ○ ● ■ ✓ ✗ ! ·`, text presentation only),
  and the live status. Structural lines stay within 28 characters and nothing relies on
  right-aligned borders, because iOS Messages uses a proportional font.
- **Every card ends with numbered options, under one digit rule.** A bare reply belongs
  to rapp-bubbles only when it answers one of our messages: the bubble it swipe-replies
  to (iOS inline reply), or else the message directly above it (GUID adjacency).
  Tapbacks in between do not count as messages. A swipe-reply to another AI's message
  is left alone even when our card sits right above it, and so is anything else, even
  a `1` or `2` while an approval waits. A task's live menu stays open while the task
  runs, an approval card only while its approval is live, and other menus for an hour
  after they were sent. A digit under one of our cards that no longer offers it gets
  one live card (`Expired` for an approval that lapsed, else "Card closed") and never
  runs a stale option.
- **Read guard.** One rule decides whether Approve, Cancel, Stop, or an answer to an
  agent's update could have been meant for the card it lands under, for a bare digit and
  for `RAPP <n>` alike:
  - A swipe-reply names a bubble the owner has seen, so it always counts.
  - Otherwise the card must be confirmed on the phone (sent or delivered). If it is not,
    nothing runs and the card comes again saying `Not confirmed on your phone`.
  - The reply must be typed at least 3 seconds after the card's last bubble left the
    Mac (by the message's chat.db time; measured from when the send returned, so a slow
    send does not use up the window). A pick typed sooner, or before the card existed,
    still runs when the card the owner could read by then offered the same thing under
    that number (a heartbeat or a re-offer of the same task), so a fast replier is never
    refused over and over. That needs the earlier card confirmed on the phone and, for a
    bare reply, nothing between the two cards in chat.db but our own bubbles and the
    owner's messages to us: another AI's question in between may be what the number
    answers. Otherwise nothing runs and the card comes again saying `nothing ran`, so
    sending the pick again answers the card that is now newest.
  - An answer to an agent's update typed as it landed is not recorded; a number gets one
    `Not answered` card (swipe-reply to answer it), other text is left alone.
  - A row with no chat.db time is judged by position alone. A card from before a group's
    members changed is never re-sent to the changed group.
- **`RAPP <n>`** answers the card a swipe-reply quotes (nothing runs if the quoted
  message is not one of our cards), else the newest card sent before you typed,
  operator posts included, and never falls back to an older card. A newest card whose delivery is
  unknown counts as closed ("check your phone"). `RAPP 1`/`RAPP 2` approve or cancel
  only when that newest card is the task's live approval card (`approval_expired`
  after it lapses), and `RAPP <n>` never picks Stop while an approval is waiting or
  just expired, since `RAPP 2` may have meant Cancel. `RAPP 1 …` with extra words runs
  nothing. An error card is itself the newest card, so refusals name a command that
  still works (`RAPP approve 0001`, a swipe-reply on the card) rather than `RAPP 1`.
  Attachment bubbles belong to their card: an unconfirmed attachment does not close a
  delivered card's options, while an image post (a single attachment bubble) is its own
  card.
  Options only map to existing commands (`status`, `stop`, `result`, `list`, `help`,
  `retry`) plus `RAPP quiet [job]`, so a number can never grant anything new. A handled
  reply is recorded before dispatch, so the reader's late-row window never repeats it.
- **Short refs**: the four characters in `[RAPP 9c1e]` work wherever a job id does
  (`RAPP status 9c1e`, `RAPP approve 9c1e`); `RAPP resend` accepts a unique 6+ character
  part ref.
- **Running tasks keep sending ETAs** until they end: a card when the task starts, then
  heartbeats about 2, 5, 10, 20, 35, and 60 minutes in and every 30 minutes after, plus
  milestones (a new state, forward worker progress by a quarter, running past its usual
  time, stalling or resuming), at least 90 seconds apart and at most 10 per task. A
  milestone counts against what the owner was last shown, so one held back by that
  spacing or by a pause still goes out on the next poll.
  Heartbeats follow time slots, so a gap produces one catch-up card instead of a burst,
  and milestones never spend the last three updates. Updates pause, spending nothing,
  while iMessage is verified down or the disk is critical. The footer always states what
  happens next (`next ~5m`, `result next`, `result only`, `updates paused`). Replying does not stop them;
  `RAPP quiet` does, and the final result always arrives. A newer update replaces a
  still-queued one and the final replaces any queued update, so an outage never releases
  a burst; progress cards are never retried or flagged for delivery attention.
- **ETAs are honest about their basis**: worker progress markers
  (`{"type": "progress", "done": n, "total": m}` events) give a step count and
  extrapolated time left; otherwise the median of the last 20 finished runs of the
  profile (once there are 3) gives `~Xm left` and a time-based bar labelled `est` that
  never fills before the task ends; otherwise the card says `Xm in · no ETA yet`. A task
  past its usual time says `long · Xm`. A worker that went inactive, or has produced no
  output for 10 minutes (or half its usual run), is shown as `stalled · Xm` with no ETA.
  Only a running task can stall: time spent waiting for approval or queued is not
  worker silence, and liveness starts fresh at approval. Each finished run records its
  duration and the error of its first estimate.

## Operator feed, Messages health, and the doctor

### Operator feed (`post`, `feed-status`)

Local agents post progress into the authorized direct thread through the same
durable outbox and receipt reconciliation used for task results:

```bash
python3.12 scripts/rapp-bubbles.py --config /absolute/private-portal.json post \
  --text "Loop 01 · pick one" --file /absolute/card.png --options 3 --ttl 300 --channel loop
python3.12 scripts/rapp-bubbles.py --config /absolute/private-portal.json feed-status --id post-…
```

- Every post's text or caption begins with `[RAPP <channel>] ` followed by its own
  first line (the lock-screen line), so an echoed update can never trigger the legacy
  watcher's lifecycle words.
- A newer post in a channel replaces older posts there that have not left the
  Mac, so an outage never releases a burst of stale cards.
- Posts with `--options N` (1–9) collect one answer. The owner's next message is
  captured only when it directly follows that post in the chat (GUID adjacency, so a
  newer card that is still queued cannot take it) and was not typed as the post landed
  (the read guard), including a bare number while a task approval waits; lifecycle words
  (restart, wake up, shut down, …) are never captured. After an intervening
  message, `RAPP reply <text>` answers the latest open post explicitly (or, as a
  swipe-reply on an update, that update). The reply
  window starts at delivery and lasts `--ttl` seconds. Answers are read back
  only through `feed-status`.

### Messages health gate

Before submitting queued parts, the outbox checks Messages. If Messages is not
running it is relaunched. If it does not answer Apple Events for 3 minutes, that
one PID is restarted (at most every 10 minutes, doubling to 2 hours). If the
iMessage account does not answer (`imessage_account_blocked`) or is not
connected, parts stay queued instead of becoming unknown. A probe that cannot
run at all (for example, Automation consent is missing) fails open to the
ungated behavior. Healthy results are cached for 120 s and unhealthy ones for
45 s; nothing is probed while the outbox is empty. `transport-status` reports the
verdict under `imessage`.

### Disk, outage, and gap cards

rapp-bubbles tells the owner about its own trouble with one `[RAPP sys]` card per
event, each ending with `[1] Health` and `[2] Recent jobs`:

- **Disk pressure**: every tick checks free space on the state volume. Below 10 GB (or
  5%) is `Disk low`; below 2 GB (or 2%) is `Disk critical`: automatic ETA updates pause
  and new task preparation is refused with `disk_low` (status, stop, and results keep
  working). Refusing tasks and pausing updates follow the disk right now, so freeing
  space works at once. Only the cards use hysteresis, so a disk hovering at a line
  cannot flap: a worse level always alerts at once; a better one is announced only
  after it has held for 10 minutes with 2 GB and 1 point of headroom above the line
  (12 GB and 6% to leave low; 4 GB and 3% to leave critical). Each time the disk worsens
  again within six hours of a resolve card, the next hold doubles (up to six hours), so
  a flapping disk sends fewer and fewer cards. A level still in force is re-announced at
  most every six hours, and only while the disk is really at that level. Every alert
  ends with one resolve card (`✓ Disk ok`, saying `tasks resume` after a critical
  spell, or a `Disk low` card saying `tasks resume` when critical eases to low).
  `RAPP health` shows the level right now (`low · easing from critical` while a card
  waits out its hold). Hovering at either line writes the journal at most once. The
  overnight disk-full that silently failed 343 ticks now names itself.
- **iMessage back**: when the health gate has held sends for five minutes or more and
  iMessage reconnects, one card reports how long it was down, the verdict, and how many
  queued parts are now sending. It goes out first: sending waits one tick for it, and
  system cards always lead the queue.
- **Back online**: each successful tick touches a tiny `heartbeat` file; a gap of five
  minutes or more (failed ticks, a stopped watcher, a full disk) is reported once.

### Bounded journal and idle ticks

Idle ticks no longer rewrite the journal: re-read late-window rows and job polls that
learned nothing save nothing. Recovery runs once per watcher instance (after a restart);
every status poll already reconciles its job runtime-side, so it no longer runs on a
timer. Settled feed posts are skipped.
Receipts back off with age: fresh parts are checked every 5 seconds, then every tenth of
their age, at most hourly. A part more than a day old that was already checked after
its receipt window stops auto-polling (a part never checked, because the bridge was
down, still gets its one look). `RAPP resend` and `retry` always look again first, so a
late arrival is never duplicated. A tick reports `ok` when it completed; stuck parts are
reported as `delivery_attention` rather than failing every tick. Once an hour, delivered or
permanently failed parts older than 14 days, their staged files, handled inbox records,
and ended jobs older than 30 days are removed, but only past the reader's late window
(cursor − 256), so deduplication can never replay a row. Uncertain and retryable parts
are always kept. `transport-status` reports `journal_bytes` and `resources`.

### Poison records and failing polls

One bad item can no longer stop every tick:
- **Poison messages.** An unexpected error while handling one message sets that message
  aside: it is marked failed (`internal:<Type>`), nothing runs, the cursor moves on, and
  the owner gets one `! Skipped` card. The rest of the tick still runs. Known failures
  (for example, Messages unavailable) and chat.db errors (a locked database) still fail
  the tick and are retried, so a transient problem never drops a message. A journal that
  cannot be written (a full disk) always fails the tick.
- **Poison parts and stages.** A part that breaks the send pump or its receipt check is
  set aside (retryable with `RAPP retry` when its send was never attempted); the parts
  behind it still go out. Each tick stage (disk,
  recovery, receipts, polls, sends, outage, attention, compaction) runs even when an
  earlier one broke; the tick result lists what was set aside under `quarantined`.
- **Undecodable text.** chat.db text that is not valid UTF-8 is read with replacement
  characters instead of stopping the reader.
- **Failing polls back off.** A job whose status poll fails is polled again after 10 s,
  then 20 s, 40 s, … up to 10 minutes, and normally again after one success. A job the
  runtime no longer knows (`not_found` five times, about five minutes) and one that keeps
  failing internally (three times) are no longer followed, with one card; each kind is
  counted on its own, so a timeout or two never makes one `not_found` fatal. A finished
  job whose result can never render (a deleted or invalid declared output, a malformed
  result) gets its text with `Output files unavailable (<code>)` after two tries instead
  of being retried forever; a transient failure (a timeout, a full disk, reported as
  `disk_full`) keeps backing off with its files intact.
- **Errors are kept once per code**, with a count and first and last time, so one
  repeating failure cannot push every other cause out of the 100-entry ring. `RAPP
  health` shows the last error.

### Doctor (read-only)

```bash
(cd scripts && python3.12 -m rapp_bubbles.doctor)
python3.12 scripts/rapp-bubbles.py --config /absolute/private-portal.json doctor
```

It samples only same-user iMessage processes (Messages, imagent,
identityservicesd, transparencyd, syncdefaultsd, callservicesd, accountsd) for
one second, recognizes synchronous XPC waits, and names the lowest unresponsive
link and its fix. It restarts nothing and reads no message data.

### Runbook: iMessage wedged after a disk-full (2026-09-22)

- Symptoms: Messages hangs at launch, or answers `get name` but not the account
  query; sends return `ok` but no chat.db row appears. The doctor reports
  `dasd_unresponsive`: imagent, syncdefaultsd, and transparencyd block in
  `-[_DASScheduler submitTaskRequest…]` and identityservicesd waits on
  transparencyd.
- Restarting Messages or the per-user iMessage daemons cannot help.
- `sudo launchctl kickstart -k system/com.apple.dasd` is refused while System
  Integrity Protection is on (error 150). What worked: an administrator stops the
  dasd process by PID (`sudo kill -TERM <pid>`, then `-KILL` if it lingers);
  launchd relaunches it and every daemon unblocked within seconds, with no other
  restarts. A reboot also works; plan the FileVault unlock.
- The trigger was the disk filling up; keep free space monitored.

### What we took from BlueBubbles

BlueBubbles (Apache-2.0) confirms AppleScript sends by awaiting chat.db rows
with heuristic text matching, restarts Messages with quit/reopen, and offers a
Private API that requires SIP to be disabled and still depends on imagent. It
has no remedy for a wedged dasd. rapp-bubbles keeps exact-identity
reconciliation, never automatically resends a part that may have left the Mac,
and adds the health gate and the doctor.

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
  python/tests/test_rapp_bubbles.py
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
Set `PORTAL_NATIVE_READER=/absolute/approved/imsg` to additionally exercise the
installed native UTF-16/typedstream decoder against synthetic fixture SQLite.
Those tests invoke only native version/read operations, with no message send
and no private chat database. The ordinary suite also covers a foreign AI's
intervening outbound SQL row, fresh-tail initialization, and durable pending
downloads from regular single-link mode-0644 media files.

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
