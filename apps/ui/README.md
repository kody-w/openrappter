# RAPP Work — conversation first, at every depth

People speak or type to their **Work Twin**. The Twin fills in the details.
Forms are never initial intake, and creating work never opens a blank form.

## The same three-column workspace everywhere

- **Left:** searchable workspace hierarchy, ownership/status, and the latest
  available Twin exchange. The concierge creates human-owned business roots.
- **Center:** the selected workspace's persistent conversation, source-verified
  proposals, necessary follow-ups, and text/voice composer.
- **Right:** a prominent **Start agent computer** control, scoped computer and
  lease state, approval policy, child agents, routines, and active work.

Every agent owns one mint-once child workspace. Agent cards, mentions, and the
hierarchy open that workspace through `agents.openWorkspace`; owner agents are
not displayed as their own children. Breadcrumbs and the owner/parent header
come from the host's frame-derived lineage. The UI honors the depth-four and
32-child limits, inherited pauses, and archived/read-only workspaces.

Selecting a different workspace unmounts its composer, voice capture, editors,
artifact requests, and subscriptions. Late results cannot enter another scope.
Only the selected workspace ID is a browser preference, namespaced by owner and
catalog. Conversations, tree structure, routines, and proposals have no parallel
renderer JSON authority.
Failed action messages remain visible through background refreshes; a live
state update never turns a rejected mutation into an apparent success.

## Complete, verified proposals — not form intake

Tasks, Agents, Routines, and Settings are secondary inspectors. Every create
control seeds and focuses the Twin. Proposal cards support direct application
or **Review details**. All creation review components require both a complete
draft and its actual ready, workspace-bound, verified Twin proposal.

Mutable proposal reviews and application require
`basis.verification.state === "verified"`, the correct workspace/source binding,
and the canonical source/evidence/publication references. Missing or unverified
proof fails closed; disconnect makes verification unavailable. The host always
reloads and verifies canonical sources rather than trusting caller proof fields.

The badge is **Verified local integrity**. It is explicitly **not** factual
accuracy, authorship, or promotion-grade trust, and is separate from model
confidence and runtime execution status.

Existing records can be inspected in prefilled sheets. Changes to an agent,
routine, or setting return to the Twin for a fresh verified proposal; they do
not call an unverified save directly. Saved task details are read-only, with a
conversational change action. Existing agent instructions use the host's
verified `instructionsRef`, so people never have to re-enter a document.

Approval proposals are recommendations only. **Approve action** and **Deny
action** remain separate explicit controls for the pending, unexpired, exact
operation. Submitting an approval form or accepting another proposal cannot
make that decision.

## Instruction documents and internal evolution

Paste a complete Markdown instruction block directly into the composer. Primary
input accepts up to 64,000 JS string characters and 128 KiB UTF-8. Whole-document
paste preserves CRLF, trailing whitespace, and locked evidence phrases. Oversized
input remains visible with an error; it is not silently truncated or sent.

Document-backed proposal instructions are shown read-only and submitted
verbatim. The host infers the name, role, verified provider/model, conservative
policies, enabled state, and optional complete routines. Suggested routines are
always disabled until separately reviewed.

The Twin may evolve internal sections, summaries, task views, default focus,
and disabled suggestions. The subtle **Workspace evolved from this
conversation** receipt is shown only when its exact conversation and proposal
frame/hash references match this workspace's verified conversation. Expand the
receipt to inspect all four canonical references. Evolution never enables
schedules, expands tools/providers, approves actions, or starts a computer.

## One shared agent computer

`computer.start { workspaceId }` delegates provisioning/start to the existing
ComputerBroker. The broker acquires a fresh scoped operation lease, starts the
one pinned shared Omarchy VM, releases that short lease, and records enablement
for this workspace. Each subsequent agent tool acquires its own scoped lease.
An idle lease does not mean the workspace is disabled.

A running VM can still be **not enabled** for the selected workspace. Its own
Start action is necessary. A shared stop invalidates prior enablements. Starting
does not relax agent or inherited policies. Paused/archived lineage cannot
execute. Missing/foreign `computer.workspace` binding fails closed; foreign
lease handles and agent IDs are never displayed or reused.

The panel distinguishes unavailable, starting, running, stopped, and unresolved
work. Unresolved work is not replayed automatically. Headless Tart explicitly
reports no display stream: `capabilities.view` is not a screen/iframe promise.
There is no per-agent unmanaged VM or host-shell fallback.

## One authoritative wire contract

`src/model.ts` and the desktop preload use the pure schemas and
`rpcParameterSchemas` exported by `apps/host/src/contracts.ts`. There are no
independent copies of the host wire schemas. The original `TwinDraft` and
`TwinMessageRequest` envelopes are unchanged; lineage, proof, and document
binding are the host's defined projections.

All normal work calls include a top-level `workspaceId`. Subscriptions use
`{ workspaceId, scope: { area, entityId? } }`, and unsubscription retains that
binding. Supplemental history is at most 24 turns, 8,000 characters per turn,
and 48 KiB total; long canonical documents are not resent or truncated into
history. A Twin request is at most 256 KiB; RPC has a 512 KiB body bound.

No renderer filesystem access, arbitrary IPC, credential entry, direct network
connection, production fixtures, or renderer-side model/keyword simulation is
provided.

## Dictation and accessibility

Speech uses `SpeechRecognition` / `webkitSpeechRecognition` only after an
explicit microphone-button click. Starting, listening, interim text, final
transcript, errors, and unavailable speech have visible states. Only final
recognized text is appended, and it is never auto-sent. Capture stops on
blur/hiding, disconnect, navigation, inspection, or unmount; late callbacks are
ignored.

Transcripts remain untrusted, unsent input until a canonical user message
commits. The browser speech service may process audio online and is not
guaranteed to work in Chromium/Electron. Text fallback remains available.
Electron microphone permission is restricted to its owned foreground main
document, with no camera, subframe, foreign-document, or background permission.

Named controls, focus-contained native dialogs, skip navigation, live status,
reduced motion, both themes, and 375px–desktop layouts are covered by browser
accessibility checks.

## Gates and evidence boundaries

From the repository root, restore the existing lockfile with `npm ci` if needed:

```sh
npm --prefix apps/ui run typecheck
npm --prefix apps/ui test
npm --prefix apps/ui run build

mkdir -p apps/ui/.test-scratch
export TMPDIR="$PWD/apps/ui/.test-scratch"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/apps/ui/node_modules/.cache/ms-playwright"
npm exec --workspace @rapp-work/ui -- playwright install chromium
npm --prefix apps/ui run test:browser
npm --prefix apps/ui run test:canonical
```

Unit/browser fixtures exercise UI interaction only and never enter production.
They are not RAPP/1 conformance evidence. The separate canonical gate drives the
UI's real `BridgeClient` and review preparation against the real authenticated
host with injected model/guest transports. It scans nonzero canonical
`memory.chat-turn`, `memory.save`, `memory.tool-call`, and linked evidence, then
rebuilds the complete tree, conversations, proposals, agents, routines, and
evolution from frames and checks restart equivalence.

The host/root acceptance suite covers the other canonical lifecycle and lineage
invariants. Desktop smoke exercises the actual Electron boundary and persistence.
Neither mocked UI nor canonical tests claim live AI generation, real speech
transcription, factual inventory truth, or real guest/VM execution. Screenshots
and gate reports are retained in ignored `test-results/`.
