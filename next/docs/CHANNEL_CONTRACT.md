# Binding private-channel contract

Copilot CLI/stdio is primary. iMessage is optional and **default off**. It is a
continuity transport into the same selected root conversation, not another bot,
memory store, agent runtime, workspace identity or source of tool authority.

## Exact identity and private runtime custody

The owner binds the **existing full canonical body-stream RAPPID** and its
existing root conversation. No UUID, `scope.agentId`, child locator, contact,
thread or source directory can mint/select a replacement root. The frozen
iMessage reference's UUID convention is explicitly not adopted.

Actual contact/permission material, private Shortcut selection and credentials
live only in `<canonical-profile>.runtime`, a same-parent **runtime sibling**.
The directory must be same-user 0700; files must be bounded, same-user,
non-linked 0600 with real ancestors. Symlinks, hard links, foreign profile/root
bindings and permissive modes refuse; permissions are never silently repaired.
This directory stores no conversation, queue, policy, attention or outcome.

Canonical `channel.bound` stores only an opaque binding reference, public
bounded policy and exact root authority. The reference is derived from the
root/owner operation, **not** an enumerable contact, and grants no permission.
Private material never enters new frames, artifacts, settings, projections or
Egg. Old contact-bearing fixture/history frames remain immutable but cannot
activate delivery; a fresh owner/runtime binding is required. General Egg
transfer still refuses without adopted authority.

`channels.bind` does not request TCC permission, inspect Messages, resolve a
contact, invoke a Shortcut or enable the production port. `DisabledIMessage`
remains the production default. A real bridge requires separate controlled
owner setup, exact contact/root mapping and authenticated transport provenance.

## Incoming continuity

`channels.receive` is **owner-only** local ingress, not a restricted AI/MCP tool.
The injected transport authenticates; the core checks the exact private binding
and active full root again at canonical publication. Raw authentication,
sender/thread and credential metadata are stripped.

The accepted `memory.chat-turn` data has `origin:external-imessage`, `role:user`,
`proposalId:null`, public text and the canonical binding wave. It has **no**
`replyTo` or `answerTo`. Projections retain explicit
`attribution:{origin:external,channel:imessage,approvalAuthority:false}` and
pending `external-inbox` attention. A repeated bound transport message returns
the original occurrence; changed payload under that ID refuses.

External text never enters the CLI `Conversation.converse` dispatcher. “yes”,
“confirm”, a gauntlet answer and “Where were we?” are inbox data, not commands.
They make no model/tool/channel call, cannot confirm organization, clear a
clarification, auto-restore a hidden root or acquire an owner capability.
`channels.review-inbound` is a separate genuine owner acknowledgment, not an
approval of the text. The pending inbox is bounded to 32 records and 4000 UTF-8
bytes per public input.

Only genuine CLI authority settles a native/CLI clarification: either owner
`conversation.answer` with the exact source-wave reference, or a confirmed
`draft.resolves` through the same canonical organization fold. Organization
resolution requires a genuine CLI input source and exact reviewed confirmation.
An unconfirmed proposal or external input does not settle it; a settled
question cannot trigger duplicate delivery.

## Canonical reporting and automatic question queueing

`conversation.report` is a pure owner/CLI producer: one bounded assistant
publication, **zero model, guest or channel effects**. An optional
`rapp-work.clarify/1` marker names `human-question` or `gauntlet`, one to three
irreducible questions and `requires:copilot-cli`. Its `turnId` must equal the
assistant's operation ID in the **same canonical frame**. Native conversation
proposals with human questions emit the equivalent marker in their own
assistant publication; they do not invoke a second notification model.

The shared repository post-publication signal runs only after canonical
publication and lock release. A coalescing root-local consumer reconstructs
verified sources. Both CLI reports and native/gauntlet publications use this
path; no LocalTwin-only hook or UI callback is authority. Callback failure is
reported without altering the committed result. Channel-owned publications
are filtered, and canonical source/binding IDs deduplicate queues to prevent
feedback loops.

Only explicitly enabled owner policy permits automatic **internal queueing**.
Ordinary assistant/progress text, external replies, success/reversal/outcome
records or an unpaired marker cannot become automatic questions. Queue frames
contain exact original source references, not copied question/activity bodies.
`channels.consider` reconstructs eligible source markers explicitly after a
missed invalidation/restart. Read-only recap/inspection never queues or sends.

## Delivery, cancellation and preflight generations

Delivery is a **separate approval-gated irreversible operation**. The owner
supplies exact queue IDs to `channels.deliver` or `channels.flush`; no background
pump invokes either. A digest contains at most four compatible questions under
the same binding and preflight generation.

1. Commit an owner-approved canonical preflight intent with exact IDs, binding,
   generation and expiry. Reserving this intent is not a physical attempt.
2. Read the strict private runtime and run an explicitly **non-sending**
   preflight. Disabled/unavailable/deferred results record a known no-send
   outcome for the **entire batch**. No physical attempt budget is spent.
   Both private binding retrieval and readiness consume the original canonical
   preflight deadline; no fresh lease starts after a slow binding read.
3. Recheck root visibility, binding, current question/CLI answer state,
   cancellation, quiet hours, expiry, generation and rate immediately before
   issuing an attempt. Late deferral finalizes all selected queue IDs, not only
   the last marker.
   Final attempt publication also checks the original preflight `expiresUtc`;
   expiry records a canonical no-send deferral and requires fresh approval.
4. Commit the irreversible attempt, then invoke the bounded transport with an
   opaque stable attempt ID and source-derived text. Record `delivered`,
   `uncertain`, or a proven `not-submitted` outcome. Only opaque receipts enter
   frames; raw errors and private transport material do not.

Cancellation sets its in-memory fence and abort signal **before awaiting a
lock, private runtime or readiness**. Its canonical successor preserves the
original queue/source. An already-dispatched effect cannot be recalled by
internal correction. A non-cooperative preflight/send retains its local fence
until it settles; a recorded uncertain attempt blocks replacement across restart.

Only proven no-send state can advance a fresh preflight generation. An expired
abandoned preflight with no attempt can be resumed under a new explicit approval;
an uncertain physical attempt cannot. Duplicate approval IDs do not rerun work.
Mixed-generation digests refuse rather than silently excluding a question.

## Bounds and read-only recap

Owner policy specifies an IANA timezone and optional partial-day quiet interval;
UTC source times and timezone conversion handle DST, including repeated hours.
It also sets 1–8 physical attempts/hour, 0–3600 second minimum interval/backoff,
1–4 batch entries, 1–32 pending notifications, 60–86400 second source expiry and
1–30 second preflight/transport deadline. Preflight generations cap at 32;
outbound source-derived text caps at 8192 UTF-8 bytes. No-send generations do not
spend physical rate budget; uncertain attempts do.

Recap reconstructs original public sources, external pending input, delivery
status, preflight generation and batch outcomes from canonical frames. It is not
a copied message/queue database. Restart, read, Catch-me-up and inspection do not
send, infer or replay an uncertain effect.

## Synthetic evidence and future channels

`SyntheticIMessage` is an injected **test-only** port: no Apple APIs, private
scanning, contact lookup, native database access or real sending occurs.
Tests additionally cover same-publication markers, external confirmation/gauntlet
refusal, private sibling modes/links/root custody, callback failure, native and
CLI publication coverage, cancellation before lock/readiness, late two-question
deferral/restart, no-send generations, uncertainty, quiet hours/DST and rate
budgets. `npm --prefix next run imessage:gate` launches the real owner stdio
producer, checks nonzero signed canonical frames and demonstrates only a
separately approved **synthetic** delivery. No live TCC/contact setup is run.

The private stopped handoff at `e36d9116402af87f94f12c40c25015666a1ea2a2`
informed these semantics. Its 318 relevant tests and guarded 180-frame dogfood
are historical evidence, not greenfield acceptance. No UUID codec, schema,
current-app implementation or private handoff contents are merged.

Future channels must feed this same conversation and canonical delivery
boundary with explicitly adopted capabilities. Adding a new transport is not
permission to expand tools, merge memory, auto-send, or introduce a channel
database.
