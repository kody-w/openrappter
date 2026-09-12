# RAPP Work — conversation first

People speak or type to their **Work Twin**. The Twin fills in the details.
Creating work never opens a blank form.

## Workspace shell

- **Left:** searchable, durable business workspaces, their latest available Twin
  exchange and its saved state (reply pending, needs input, applied, dismissed),
  and a concierge for creating another workspace.
  A business workspace is not an agent or an agent's execution directory.
- **Center:** that workspace's persistent conversation, follow-up questions,
  structured proposal cards, and a text/voice composer.
- **Right:** service-reported local computer/screen availability, routines,
  agents, tasks, and human approval needs. Shortcuts seed the conversation;
  they do not silently send messages or create records.

Tasks, Agents, Routines, and Settings are secondary inspectors. Every create
control seeds and focuses the Twin. Editing a saved agent, routine, or setting
opens a prefilled review. Proposal cards can apply directly or open **Review
details**, clearly labeled as drafted by the Twin. Incomplete or malformed
proposals cannot open a form or apply. Settings patches are merged with the
saved settings to make a complete review without resetting unrelated choices.
Saved tasks also have a prefilled review: their outcome stays immutable, while
assignment can be edited before the first run. Run start and cancellation remain
explicit, scoped controls in the inspector.

Approval proposals are recommendations only. Neither applying a proposal nor
submitting a form can approve an action. **Approve action** and **Deny action**
are separate, explicit human controls bound to the existing approval and exact
operation.

## Host boundary and persistence

`App` accepts `WorkClient`; production uses only the frozen preload's `request`,
`hostState`, and `onEvent`. There is no renderer filesystem access, direct
network connection, arbitrary IPC, credential entry, sample business data, or
renderer-side language-model/keyword simulation.

`src/model.ts` and `src/twin-contract.ts` validate wire data. The latter mirrors
the host's pure business/Twin DTOs so the UI branch can be built independently.
The ordinary work DTOs are imported from the host's pure contract module.
UI/preload parity tests guard the closed RPC allowlist and request shapes.

The exact Twin message envelope is:

```ts
type TwinMessageRequest = {
  workspaceId: string | null;
  message: string;
  target?: "auto" | "workspace" | "task" | "agent" | "automation" | "settings" | "approval";
  history: { role: "user" | "assistant"; content: string }[];
  contextRevision?: number;
};
type TwinDraft = {
  id: string;
  workspaceId: string | null;
  kind: "workspace" | "task" | "agent" | "automation" | "settings" | "approval" | "clarification";
  assistantMessage: string;
  summary: string;
  confidence: number;
  readyForReview: boolean;
  missing: string[];
  draft: object | null;
  basis: object | null;
  createdAt: string;
};
```

- `workspaces.list {}` returns the owner catalog.
- `workspaces.open { workspaceId }` returns the business, snapshot, conversation,
  routines, and computer report.
- `twin.conversation { workspaceId }` loads canonical history. `null` means the
  global concierge, not the first business.
- `twin.message` returns a proposal, never a successful mutation. It sends at
  most 24 history turns, an 8,000-character message, and the conversation's
  context revision within the host's 48 KiB bound.
- `twin.applyProposal { workspaceId, id, proposalHash, editedDraft? }` applies a
  complete, hash-bound draft. The host remains authoritative for stale-context
  rejection, current options, idempotency, permissions, and mutation receipts.
- `twin.dismissProposal { workspaceId, id, proposalHash, reason }` durably
  dismisses a proposal without creating work.
- All workspace operations include a **top-level** `workspaceId`. In particular,
  event subscriptions use `{ workspaceId, scope: { area, entityId? } }` and
  unsubscriptions retain that workspace binding.

Conversations, proposal dispositions, and entities are host-owned. Only the
last selected workspace is a browser preference, namespaced by owner/catalog.
Changing workspaces unmounts composer, dictation, editors, artifact requests,
and subscriptions. Late results cannot enter another conversation. Offline
records are explicitly stale and cannot be mutated. No legacy/single-workspace
fallback maps agents onto business workspaces.

## Dictation and accessibility

Speech uses `SpeechRecognition` / `webkitSpeechRecognition` only after a
microphone-button click. There are explicit starting, listening, interim,
transcript, error, and unavailable states. Only recognized **final** text is
appended, and it is never sent automatically. Stopping, hiding/blurring the
document, opening an inspector, disconnecting, switching workspaces, or
unmounting ends capture and ignores late callbacks.

The browser's speech service may process audio online and is not guaranteed
to work in Chromium/Electron. A visible text fallback remains available; no
transcription is fabricated. Electron grants only foreground, owned,
top-level app-document audio permission. See the desktop permission tests.

Keyboard-accessible navigation, native focus-contained dialogs, skip links,
live status/error announcements, reduced motion, both themes, and responsive
375px–desktop layouts are covered by browser accessibility checks.

## Gates

From the repository root, restore the existing lockfile if needed with `npm ci`.
Then:

```sh
npm --prefix apps/ui run typecheck
npm --prefix apps/ui test
npm --prefix apps/ui run build

mkdir -p apps/ui/.test-scratch
export TMPDIR="$PWD/apps/ui/.test-scratch"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/apps/ui/node_modules/.cache/ms-playwright"
npm exec --workspace @rapp-work/ui -- playwright install chromium
npm --prefix apps/ui run test:browser
```

Browser tests use the **production build** and a test-only, durable injected
bridge. They cover natural-language workspace creation, all proposal kinds,
questions, direct apply, prefilled edits, dismissal, explicit approvals, voice
and unavailable speech, switching/isolation/races, keyboard focus, cold
disconnection, and WCAG checks at 1360px and 375px in both themes. Screenshots
and traces are under ignored `test-results/`.

Those fixtures do not attest to live inference, a real microphone/speech
service, or a running VM. Actual shell, host, scoping, and local persistence
are exercised by the desktop smoke gate after integrating the Twin host.
