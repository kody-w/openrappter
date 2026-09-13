# Frame-derived UI integration contract

This is the handoff contract for the conversation/voice/review UI branch.
The normative definitions are the strict schemas and inferred types in
[`apps/host/src/contracts.ts`](../apps/host/src/contracts.ts), exported through
the **browser-safe `@rapp-work/host/contracts`** package subpath.
Do not maintain another DTO schema, workspace tree, or conversation authority.

```ts
import {
  workspaceOpenSchema, workspaceSummarySchema, workspaceTreeSchema,
  twinDraftSchema, twinAgentApplyResultSchema, twinEvolutionEventSchema,
  computerSchema,
  type WorkspaceSummary, type WorkspaceLineage, type TwinDraft,
  type FrameVerification, type TwinEvolutionEvent, type TwinAgentApplyResult,
  type Computer, type ComputerLeaseStatus,
} from "@rapp-work/host/contracts";
```

The package root, `@rapp-work/host`, exports Node composition services.
**Do not import that root into a renderer.** The `/contracts` entry imports
only Zod; it does not start a host or load the SDK, broker, filesystem, or
credentials. `npm run test:contracts --workspace @rapp-work/host` builds and
checks the public entry and a real browser bundle.

Types below use `ISODate = string` for a validated ISO datetime and
`Hex64 = string` for 64 lowercase hexadecimal characters. IDs are bounded
strings, not capabilities. Runtime schemas reject unknown fields. A successful
schema parse checks wire structure, **not** canonical integrity or authorization.

## 1. Workspace lineage and navigation

Every field in `WorkspaceSummary` is required:

```ts
type WorkspaceSummary = {
  id: string;
  ownerId: string;
  ownerType: "human" | "agent";
  ownerAgentId: string | null;
  parentWorkspaceId: string | null;
  rootWorkspaceId: string;
  lineage: string[];
  depth: number;
  status: "active" | "paused" | "archived";
  parentAccess: "inspect" | "none";
  catalogScope: { agentId: string; workspaceId: string };
  leadAgentId: string;
  name: string;
  purpose: string;
  twin: { name: string; instructions: string };
  approvalPolicy: "always" | "on-risk";
  computerPolicy: "none" | "read-only" | "control";
  organization: WorkspaceOrganization;
  revision: number;
  createdAt: ISODate;
  updatedAt: ISODate;
};
```

`WorkspaceLineage` is an exported `Pick<WorkspaceSummary, ...>` containing
`id`, `ownerId`, `ownerType`, `ownerAgentId`, `parentWorkspaceId`,
`rootWorkspaceId`, `lineage`, `depth`, `status`, `parentAccess`, `catalogScope`,
and `revision`. Use `workspaceSummarySchema` to validate a complete summary;
the narrower TypeScript view is not a second lineage authority.
`TwinIdentity` and `twinIdentitySchema` are also exported.

Invariants:

- A human root has parent/owner-agent `null`, `depth: 0`,
  `rootWorkspaceId === id`, and `lineage: [id]`.
- An agent owns exactly one dedicated child. Its ID is **`Agent.workspaceId`**,
  not `Agent.id`. `ownerAgentId === catalogScope.agentId === Agent.id` and
  `catalogScope.workspaceId === id`.
- `lineage` contains the root through the current workspace, inclusive;
  `lineage.length === depth + 1`. There are no duplicate IDs or cycles.
- `ownerId` remains the root human/store owner, including in agent children.
  An agent-owned workspace's `leadAgentId` is that owning agent; it does not
  recursively create a starter agent merely by existing.
- Depth is bounded at **4**, direct agents/children at **32**, and the whole
  catalog at **1,000** workspaces.
- Agent/child publication is atomic in visibility. A partial bootstrap is
  unresolved and inaccessible, not an openable orphan. The identity is
  mint-once. Retirement disables the agent, archives its child, and makes its
  descendant lineage inactive; it never reassigns the child.
- Parent inspection follows each child's `parentAccess`. Agent credentials
  cannot inspect siblings or impersonate ancestors. Host-issued capabilities,
  not serialized DTO IDs, enforce the exact lineage.

These values are folded from verified workspace/agent source frames, child
bootstraps, and linked parent publications. Reads scan trusted heads and reject
foreign, stale, forked, or rolled-back lineage. Selected-workspace state and
navigation caches are only rebuildable UI projections.

### Navigation RPCs and exact result shapes

| Method and parameters | Result |
| --- | --- |
| `workspaces.list {}` | `{ ownerId, conciergeWorkspaceId, workspaces: WorkspaceSummary[] }`, parent before child |
| `workspaces.children { workspaceId }` | `{ parent: WorkspaceSummary, children: WorkspaceSummary[] }` |
| `workspaces.tree { workspaceId: string \| null }` | `{ maxDepth: 4, roots: string[], nodes: { workspace: WorkspaceSummary, children: string[] }[] }` |
| `workspaces.breadcrumb { workspaceId }` | `{ workspaceId, ancestors: { id, name, ownerType, ownerAgentId, depth }[] }`, current included |
| `workspaces.open { workspaceId }` | `{ workspace, snapshot, twin, routines, computer, breadcrumb }` |
| `agents.openWorkspace { workspaceId: parentId, id: agentId }` | Child `WorkspaceSummary` |
| `agents.save { workspaceId, ...AgentInput, parentRevision? }` | `Agent`, including its dedicated `workspaceId` |
| `agents.retire { workspaceId, id, parentRevision? }` | Retired/disabled `Agent`, retaining its `workspaceId` |

The matching exports are `workspaceListSchema`, `workspaceChildrenSchema`,
`workspaceTreeSchema`, `workspaceBreadcrumbSchema`, `workspaceOpenSchema`,
and their `WorkspaceList/Children/Tree/Breadcrumb/Open` types.
`workspaceOpenSchema` binds the nested types to `WorkspaceSummary`, `Snapshot`,
`TwinConversation`, `Automation[]`, `Computer`, and `WorkspaceBreadcrumb`.
`rpcParameterSchemas` exports the exact shared input schemas.

`workspaceId: null` explicitly selects the human owner concierge/catalog; it
never means “use the most recent workspace.” Normal Work/agent/task/run/
approval/routine/settings/computer-control RPCs require a non-null authorized
workspace. Global workspace-creation conversation is stored in the physical
owner concierge scope, not a shared business conversation.

At every depth, render the same three-column shell and owner/parent breadcrumb.
Agent cards navigate to `Agent.workspaceId` via the authorized open API.
Child snapshots include their owner agent as an executor plus direct sub-agents;
do not render the owner as its own child card. A parent sees its delegated work,
not unrelated child-private tasks or conversation.

## 2. Twin messages and verification projections

The shared top-level request and envelope are unchanged:

```ts
type TwinMessageRequest = {
  workspaceId: string | null;
  message: string;
  target?: "auto" | "workspace" | "task" | "agent" | "automation" | "settings" | "approval";
  history: { role: "user" | "assistant"; content: string }[];
  contextRevision?: number;
};

// Envelope view; imported TwinDraft is a stricter discriminated union.
type TwinDraftEnvelope = {
  id: string;
  workspaceId: string | null;
  kind: "workspace" | "task" | "agent" | "automation" | "settings" | "approval" | "clarification";
  assistantMessage: string;
  summary: string;
  confidence: number;
  readyForReview: boolean;
  missing: string[];
  draft: object | null;
  basis: TwinBasis | null;
  createdAt: ISODate;
};

type TwinBasis = {
  schema: "rapp-work/twin-basis/1";
  ownerId: string;
  workspaceId: string | null;
  revision: number;
  heads: {
    scope: { agentId: string; workspaceId: string };
    heads: { body: Hex64 | null; memory: Hex64 | null; swarm: Hex64 | null };
  }[];
  optionsHash: Hex64;
  proposalHash: Hex64;
  instructionDocument?: { turnId: string; contentHash: Hex64 };
  verification?: FrameVerification;
};

type FrameVerification =
  | {
      state: "verified";
      sourceFrameHash: Hex64;
      evidenceFrameHash: Hex64;
      publicationFrameHash: Hex64;
      workspaceId: string | null;
      sourceWorkspaceId: string;
      heads: { body: Hex64 | null; memory: Hex64 | null; swarm: Hex64 | null };
      trust: {
        classification: "integrity-only";
        factualTruth: false;
        authorship: false;
        promotionGrade: false;
      };
    }
  | { state: "unverified"; detail: string }
  | { state: "unavailable"; detail: string };
```

`FrameVerification` is exported with `frameVerificationSchema`; non-verified
`detail` is at most 512 characters. `sourceFrameHash` identifies the canonical
memory source, `evidenceFrameHash` its linked `body.pulse`, and
`publicationFrameHash` the enclosing Work publication evidence.
`workspaceId` is the logical conversation binding; `sourceWorkspaceId` is the
physical source workspace, including the concierge for a null logical binding.
Proof `heads` belong to that publication, not arbitrary later read heads.
They are distinct from the proposal's complete captured `basis.heads` set.

**There is no self-referential proposal hash.** The persisted proposal source
contains the immutable draft **without** `basis.verification`.
`LocalTwin.projectDraft()` decorates a read projection after scanning the
source and evidence. Semantic `proposalHash()` excludes both
`basis.proposalHash` and `basis.verification`. Do not copy projection metadata
into a new canonical source or recompute a hash from the decorated JSON.
The apply path independently reads/verifies actual canonical sources and
current heads; a client cannot claim verification by sending these fields.

`TwinConversation` is:

```ts
type TwinConversation = {
  workspaceId: string | null;
  revision: number;
  turns: TwinTurn[];
  proposals: TwinDraft[];
  events: TwinEvent[];
};

type TwinTurn = {
  id: string;
  workspaceId: string | null;
  role: "user" | "assistant";
  content: string;
  proposalId: string | null;
  createdAt: ISODate;
  verification?: FrameVerification;
};
```

Reads return at most 500 turns, 250 proposals, and 500 events; older frames
remain durable. Supplied `history` is untrusted supplemental context, not
another source of canonical assistant turns.

### Review and voice rules

Only a complete, ready proposal with a matching selected workspace, canonical
hash, and `basis.verification.state === "verified"` may open a creation review
or be applied. Missing proof means **unverified**; loss of the authenticated
host means **unavailable**, not a retained actionable “verified” UI state.
Label the success state **verified local integrity**. It does not establish
factual truth, authorship, or promotion-grade trust.

Forms are generated work, never initial intake. “New agent,” workspace/task/
routine creation, and settings edits focus the Twin conversation. Necessary
clarifications have `readyForReview: false`, nonempty `missing`, and `draft: null`.
An existing-record revision also obtains a new complete verified proposal.
Never show an empty create form or use optimistic proposal objects as authority.

Voice transcript text is untrusted input until the canonical user
`memory.chat-turn` commits. Transcript success/recognition booleans do not
substitute for this frame. Capture the originating workspace for async voice,
model, approval, and computer callbacks; switching workspaces must not redirect
their results into the new selection. Clear/restore voice, review, proposal,
routine, and computer state by exact workspace.

### Exact input bounds and raw text

| Field | Limit and transformation |
| --- | --- |
| `message`, agent/lead-agent `instructions`, turn `content` | Nonblank; 64,000 JS string characters and 128 KiB UTF-8; **no trim or text transformation** |
| Supplemental `history` | At most 24 entries; each trimmed, nonempty, at most 8,000 characters; serialized total at most 48 KiB |
| Serialized Twin request | At most 256 KiB |
| RPC request envelope/body | At most 512 KiB |
| Assistant reply / summary | At most 8,000 / 2,000 characters |
| Task/routine and workspace Twin instructions | Trimmed, nonempty, at most 16,000 characters |

Send a long pasted Markdown document in `message`, not in `history`.
`history: []` is valid because the host owns canonical conversation history.
Keep raw whitespace and line endings; never truncate oversized input silently.
The host binds the original instruction document by
`basis.instructionDocument.{turnId,contentHash}` and preserves locked phrases.
It rejects rewritten documents, conflicting inferred names, relaxed restrictions,
and forbidden activation. Provider/model values come only from verified options;
GPT-6 Astra with `max` reasoning and `long_context` is required, never fabricated
when unavailable. No tool execution or fake AI fallback exists in drafting.

## 3. Applying an agent proposal returns its dedicated child

Request:

```ts
{ workspaceId, id: proposal.id, proposalHash: proposal.basis.proposalHash, editedDraft? }
```

`editedDraft`, when present, is the complete kind-specific object, not a partial
authority patch. Resource identity and bound instruction restrictions cannot
be changed. The canonical Work APIs and their permissions, approvals, and
fresh-head checks still run.

For an agent proposal, use the exact exported
`twinAgentApplyResultSchema` / `TwinAgentApplyResult`:

```ts
type AgentWorkspaceResult = {
  agent: Agent;
  workspace: WorkspaceSummary;
};

type TwinAgentApplyResult = {
  id: string;
  workspaceId: string; // The proposal's PARENT workspace, not its new child.
  kind: "agent";
  status: "applied";
  result: AgentWorkspaceResult;
  createdAt: ISODate;
};

type Agent = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  providerId: string | null;
  model: string;
  computerPolicy: "none" | "read-only" | "control";
  approvalPolicy: "always" | "on-risk";
  enabled: boolean;
  workspaceId: string; // Mint-once dedicated child ID.
  updatedAt: ISODate;
  retiredAt?: ISODate | null;
};
```

`agentWorkspaceResultSchema` validates the pair, including exact agent/child
ownership. `twinAgentApplyResultSchema` also verifies that the outer
`workspaceId` is the child's parent. The host validates this shape before
publishing the acceptance. For other kinds, the established
`twinApplyResultSchema` retains its general `result` object.

After acceptance, open `result.workspace.id` through the authorized workspace
API and refresh the tree. Never create a workspace separately on the client,
reassign its identity, or assume the parent response binding is the child ID.
Retries of the same applied request return the original result; different
edits or stale bases conflict. Approval recommendations cannot be applied:
`approvals.decide` still requires an explicit human decision.

Agent drafts may include `suggestedRoutines?: AutomationInput[]`, at most eight,
with unique IDs, the proposed agent's ID, and `enabled: false`. Saving suggestions
requires automation-write permission; enabling is a later reviewed action.
An enabled schedule still uses the existing runtime/policy/approval gates.

## 4. Conversation-scoped internal evolution

```ts
type WorkspaceOrganization = {
  twinSummary: string;
  sections: {
    id: string;
    title: string;
    description: string;
    kind: "tasks" | "notes" | "routines";
    taskIds: string[];
  }[];
  suggestedRoutines: (AutomationInput & { enabled: false })[];
  defaultFocus: "conversation" | "work" | "agents" | "automations" | "settings";
};

type AutomationInput = {
  id: string;
  name: string;
  taskTitle: string;
  instructions: string;
  agentId: string;
  cadence:
    | { kind: "daily"; at: string; timezone: string }
    | { kind: "weekly"; at: string; timezone: string; weekday: number }
    | { kind: "interval"; minutes: number };
  enabled: boolean;
};

type TwinEvolutionReferences = {
  conversationFrameHash: Hex64;
  proposalFrameHash: Hex64;
  proposalHash: Hex64;
  evolutionFrameHash: Hex64;
};

type TwinEvolutionEvent = {
  id: string;
  workspaceId: string | null;
  proposalId: string | null;
  kind: "evolution";
  actorId: string;
  detail: string;
  createdAt: ISODate;
  references: TwinEvolutionReferences;
};
```

Exports: `workspaceOrganizationSchema`, `automationInputSchema`,
`twinEvolutionReferencesSchema`, `twinEvolutionEventSchema`, and matching types.
Summary is at most 2,000 characters; sections at most eight with unique IDs,
titles 1–160 characters, descriptions at most 1,000, and at most 100 task IDs
each. Suggested routines are at most eight with unique IDs. Daily/weekly `at`
is `HH:mm`, timezone is a valid IANA zone, weekday is 0–6, and interval minutes
is an integer from 15 through 10,080.

The general `TwinEvent` union of kinds is
`proposal | accept | dismiss | error | evolution`; its references are optional
for compatibility with other events. **The narrowed evolution schema requires
all four references.** Production evolution receipts carry them and use
`detail: "Workspace evolved from this conversation"`.

The hashes identify the exact triggering user chat source, proposal save source,
semantic proposal hash, and workspace evolution source. The canonical evolution
source additionally links the triggering conversation publication/evidence.
Render a subtle receipt; do not invent one from an updated UI section alone.

`evolution` is an optional internal model-response field, not a new top-level
`TwinDraft` property. It may organize only the selected workspace: summary,
verified task views, disabled routine suggestions, and default focus.
It cannot enable schedules, expand provider/tools, decide approvals, or start
computers. Those actions retain their existing gates and canonical operations.

## 5. Shared-computer state and lease DTOs

RPCs remain `computer.start { workspaceId }`,
`computer.stop { workspaceId }`, and
`computer.inspect { workspaceId: string | null }`.
Start/stop require a non-null authorized active workspace.

```ts
type ComputerWorkspaceStatus = {
  id: string;
  enabled: boolean;
  computerPolicy: "none" | "read-only" | "control";
  approvalPolicy: "always" | "on-risk";
};

type ComputerLeaseStatus = {
  state: "idle" | "held" | "other-workspace" | "unresolved";
  id: string | null;
  workspaceId: string | null;
  agentId: string | null;
  agentWorkspaceId: string | null;
  operation: "starting" | "stopping" | "executing" | null;
};

type ComputerDisplayStatus = {
  state: "available" | "unavailable";
  detail: string;
};

type Computer = {
  state: "unavailable" | "stopped" | "starting" | "running" | "unresolved" | "error";
  detail: string;
  verified: boolean;
  verifiedAt: ISODate | null;
  evidenceIds: string[];
  capabilities: { view: boolean; control: boolean };
  workspace?: ComputerWorkspaceStatus | null;
  lease?: ComputerLeaseStatus;
  display?: ComputerDisplayStatus;
};
```

Exports: `computerSchema`, `computerWorkspaceSchema`, `computerLeaseSchema`,
`computerDisplaySchema`, and the four types above. `lease.id` is a UUID;
computer `detail` is at most 2,000 characters, display `detail` at most 1,000,
and `evidenceIds` at most 200. `verified: true` structurally requires
`state: "running"`, non-null `verifiedAt`, and nonempty evidence IDs.
The boolean alone is not evidence of source integrity or execution authority.

The optional subobjects preserve adapter compatibility. **Production populates
all three**; concierge inspection has `workspace: null`. An adapter omission
or mismatched `computer.workspace.id` must fail closed for selected-workspace
controls. Keep a prominent **Start agent computer** control in every level's
right-side panel and show the explicit workspace policy, lease, and display
state rather than infer them from the global VM state.

Lease semantics:

- There is one shared, pinned Omarchy VM through the existing ComputerBroker,
  not an unmanaged VM per agent and never host-shell fallback.
- Start acquires a short-lived workspace-scoped broker lease, provisions/starts
  the shared computer, releases the operation lease, and canonically records
  workspace enablement. Therefore a successful start normally returns
  `lease.state: "idle"` with `workspace.enabled: true`.
- **Enablement is not a lease or capability.** Every later autonomous tool
  operation obtains a fresh agent-scoped lease and the exact required permit/
  approval. Start never relaxes inherited or agent-specific restrictions.
- `lease.workspaceId` is the operation's selected workspace;
  `agentWorkspaceId` is the executing/catalog agent's physical scope.
  During start/stop, `agentId` can be the selected workspace's catalog agent.
- For `other-workspace`, lease/agent/workspace identifiers are all `null`.
  Only the operation category is shown; no foreign capability is exposed.
  Switching workspaces must never carry over an ID, enablement, or lease.
- The VM may be `running` while the selected workspace is not enabled.
  Shared stop invalidates earlier enablement. Paused/archived lineage cannot
  start or execute computer actions.
- Orphaned leases/uncertain outcomes are `unresolved`, not automatically
  stolen, resumed, or reported as successful.
- The current driver is **headless**: production `display.state` is
  `unavailable`. `capabilities.view` does not promise a live screen. Do not
  simulate a desktop, screen stream, or verified guest execution.

## 6. Canonical source/evidence boundary

| Lifecycle | Canonical source and linkage |
| --- | --- |
| User, voice-transcript, or Twin turn | `memory.chat-turn` + linked `body.pulse` |
| Proposal/clarification | `memory.save` + linked evidence and Work publication |
| Apply/edit/dismiss | Request-bound `memory.tool-call` intent/outcome + linked evidence |
| Workspace create/evolve/rename/pause/archive | Typed workspace-domain sources + evidence |
| Agent create/configure/retire | Agent-domain sources linked atomically to child bootstrap/publication |
| Routine draft/enable/pause/fire | Routine-domain sources and gated operation receipts |
| Computer lease/start/stop/tool operation | Canonical request, write-ahead intent, terminal receipt, and evidence through the broker |

The profile is `rapp-work/lifecycle/1` in
`packages/domain/src/lifecycle.ts`. Body Work outcomes carry source references,
not parallel authoritative domain JSON. Source/evidence/publishing failures
remain unresolved. Caches are discardable; no JSON workspace-tree, draft,
routine, or conversation store may authorize work.

## 7. Real-host acceptance integration

Public Node exports:

```ts
import { createLocalServices, createHost } from "@rapp-work/host";
```

`createLocalServices` accepts the application directory and private token plus
explicit injected Copilot/command transports and persistence fault hooks.
Tests still exercise actual Work, WorkspaceStore, and canonical RAPP/1 code.
These injections are test seams, not production model/computer fallbacks.

The existing Node test helper is
`apps/host/test/production-fixture.ts`:

```ts
productionFixture({ computer?, commands?, directory?, bootstrap? })
// => directory, services, host, commands, copilot, workspace,
//    context(workspaceId?), catalogContext(), rpc, rawRpc,
//    failPersistence(), failAfterCommits(), close(remove = true)
```

Use `bootstrap: false` for an initially empty concierge. `rpc` and `rawRpc`
return JSON-RPC envelopes; `rawRpc` needs explicit complete parameters, while
`rpc` adds the fixture workspace unless overridden. To reopen real persistence:
save `f.directory`, call `await f.close(false)`, then
`await productionFixture({ directory, bootstrap: false })`. Finally close the
reopened fixture with removal enabled. All fixture files stay in the project
scratch directory.

Adapt this authenticated RPC wrapper into a **Node-side test DesktopBridge**.
Never expose the private token or service object to the production renderer.
Use `services.persistence.rebuildFromFrames()` after stopping runtime activity
to discard projections. Assert actual nonzero scanned sources and linked
evidence, not fixture success booleans.

Existing acceptance and regression coverage:

- `tests/acceptance/canonical-workspaces.test.ts`: reconstructs tree,
  conversations, proposals, agents, routines, and evolution from frames alone,
  then repeats after restart.
- `apps/host/test/canonical-lifecycle.test.ts`: scanned native kinds,
  publication/source links, mutation/tamper rejection, stale heads.
- `apps/host/test/recursive-workspaces.test.ts`: exact child lineage,
  recursion limits, sibling/ancestor isolation, retirement, atomic failure,
  and source-linked evolution.
- `apps/host/test/computer-workspaces.test.ts`: real canonical broker receipts
  with injected guest transport, exclusive shared VM, scoped activation/leases.
- `apps/host/test/instruction-document.test.ts`: long Inventory Visibility
  Markdown and locked evidence phrases preserved verbatim.
- `apps/host/test/ui-contract.test.ts` and `test/contracts-smoke.mjs`: exported
  nested DTO validation and browser-safe public package boundary.

## 8. Existing UI/desktop overlap to reconcile

The host branch already includes coherent, tested UI/desktop integration from
the later cross-cutting requirements. The baseline before this work was
`040fac60d0e795050bb95a2cf1554dd551c491d1`; the completed canonical implementation
commit was `bb47605bba4b0a07edd077cd61a59373085cb3d6`.
This contract-export/documentation follow-up makes **no additional UI or
desktop edits**.

The existing overlap is **19 UI files and 8 desktop files**:

| Area | Files already changed |
| --- | --- |
| UI shell, selection, RPC | `src/App.tsx`, `src/useWorkspace.ts`, `src/model.ts`, `src/client.ts` |
| UI conversation/review | `src/TwinConversation.tsx`, `src/forms.tsx`, `src/WorkspaceOrganization.tsx` |
| UI navigation/computer/work | `src/Agents.tsx`, `src/ComputerPanel.tsx`, `src/Settings.tsx`, `src/Work.tsx`, `src/styles.css` |
| UI tests/docs | `README.md`, `e2e/fixture.ts`, `e2e/workspace.spec.ts`, `test/app.test.tsx`, `test/client.test.ts`, `test/fixture.ts`, `test/setup.ts` |
| Desktop boundary/build | `src/contract.ts`, `scripts/build-shell.mjs`, `package.json`, `tsconfig.build.json` |
| Desktop tests/docs | `README.md`, `test/contract.test.ts`, `test/rpc.test.ts`, `test/smoke.mjs` |

Paths in the UI rows are relative to `apps/ui`; desktop rows to `apps/desktop`.
Inspect the full overlap with:

```sh
git diff 040fac60d0e795050bb95a2cf1554dd551c491d1..HEAD -- apps/ui apps/desktop
```

Reconcile the other branch's conversation/voice/review improvements rather
than overwrite either side wholesale. Preserve verified-proposal-only review,
lossless input, callback workspace capture, recursive navigation, and the
shared-computer panel. The final handoff reports the final commit hash and
exact gate results; no live Copilot generation or Omarchy execution is implied
by injected acceptance transports.
