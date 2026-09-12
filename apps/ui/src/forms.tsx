import { useState, type FormEvent } from "react";
import { Badge, Field, FormFooter, Modal } from "./components";
import {
  agentInputSchema, agentSchema, automationInputSchema, automationSchema, twinDraftSchema, twinProposalSchema,
  type Approval, type Snapshot, type TwinDraft, type WorkspaceSummary,
} from "./model";
import type { Perform } from "./useWorkspace";

type EditableKind = "workspace" | "task" | "agent" | "automation" | "settings";
interface EditorProps {
  kind: EditableKind;
  initial: Record<string, unknown>;
  document: boolean;
  busy: boolean;
  error: string;
  onClose: () => void;
  submit: (value: Record<string, unknown>) => Promise<boolean>;
  label: string;
}
const asRecord = (value: unknown) => value as Record<string, unknown>;
function ReviewFields({ kind, initial, document, busy, error, onClose, submit, label }: EditorProps) {
  const [draft, setDraft] = useState(() => structuredClone(initial));
  const [localError, setLocalError] = useState("");
  const value = (path: string[]) => path.reduce<unknown>((current, key) => asRecord(current)[key], draft);
  const change = (path: string[], next: unknown) => setDraft((current) => {
    const updated = structuredClone(current);
    const parent = path.slice(0, -1).reduce<unknown>((item, key) => asRecord(item)[key], updated);
    asRecord(parent)[path.at(-1)!] = next;
    return updated;
  });
  const text = (path: string[], title: string, multiline = false, readonly = false) => {
    const id = `review-${path.join("-")}`;
    const current = value(path);
    if (typeof current !== "string") throw new Error("Review fields require complete existing values.");
    if (readonly && multiline) return <section className="field" key={id}><h3>{title}</h3>
      <pre className="instruction-document" aria-label="Preserved instruction document" tabIndex={0}>{current}</pre>
      <p className="field-help">Preserved verbatim. Submit a revised document to change its instructions or restrictions.</p></section>;
    return <Field id={id} label={title} key={id}>{multiline
      ? <textarea id={id} value={current} rows={5} required readOnly={readonly} onChange={(event) => change(path, event.target.value)} />
      : <input id={id} value={current} required readOnly={readonly} onChange={(event) => change(path, event.target.value)} />}</Field>;
  };
  const select = (path: string[], title: string, options: string[]) => <Field id={`review-${path.join("-")}`} label={title}>
    <select id={`review-${path.join("-")}`} value={String(value(path))} onChange={(event) => change(path, event.target.value)}>
      {options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>
  </Field>;
  const checkbox = (path: string[], title: string) => <label className="checkbox-row">
    <input type="checkbox" checked={value(path) === true} onChange={(event) => change(path, event.target.checked)} />{title}
  </label>;
  const agent = kind === "workspace" ? asRecord(draft.leadAgent) : kind === "agent" ? draft : null;
  const submitReview = async (event: FormEvent) => {
    event.preventDefault(); setLocalError("");
    try { if (await submit(draft)) onClose(); }
    catch (error) { setLocalError(error instanceof Error ? error.message : "The reviewed draft is invalid."); }
  };
  return <form aria-label={`Review ${kind} values`} onSubmit={(event) => { void submitReview(event); }}>
    <div className="form-body">
      <p className="inline-note">Every value below comes from the complete proposal or the existing record. Make small edits, or ask the Twin to revise it.</p>
      {kind === "workspace" && <>
        {text(["name"], "Workspace name")}{text(["purpose"], "Workspace purpose", true)}
        {text(["twin", "name"], "Twin name")}{text(["twin", "instructions"], "Twin instructions", true)}
        {text(["leadAgent", "name"], "Lead agent name", false, document)}
        {text(["leadAgent", "role"], "Lead agent role")}{text(["leadAgent", "instructions"], "Lead agent instructions", true, document)}
        <p className="small-text">Computer policy: {String(draft.computerPolicy)} · Approval policy: {String(draft.approvalPolicy)}</p>
        <p className="small-text">{draft.starterTask ? "Includes a complete starter task." : "No starter task."} {Array.isArray(draft.starterRoutines) ? draft.starterRoutines.length : 0} starter routines.</p>
      </>}
      {kind === "task" && <>
        {text(["title"], "Task title")}{text(["instructions"], "Instructions and expected outcome", true)}
        {select(["priority"], "Priority", ["normal", "high"])}
        <p className="small-text">Assigned agent: {draft.agentId === null ? "Unassigned, as drafted" : String(draft.agentId)}</p>
      </>}
      {kind === "agent" && <>
        {text(["name"], "Agent name", false, document)}{text(["role"], "Role")}
        {text(["instructions"], "Agent instructions", true, document)}
        {checkbox(["enabled"], "Enable this agent after review")}
        {Array.isArray(draft.suggestedRoutines) && draft.suggestedRoutines.length > 0 && <section>
          <h3>Suggested routines</h3><p className="muted small-text">These are saved disabled. Enabling them requires another explicit review.</p>
          <ul>{draft.suggestedRoutines.map((routine) => <li key={String(asRecord(routine).id)}>{String(asRecord(routine).name)} · disabled</li>)}</ul>
        </section>}
      </>}
      {agent && <dl className="metadata compact">
        <div><dt>Verified provider</dt><dd>{String(agent.providerId)}</dd></div><div><dt>Selected model</dt><dd>{String(agent.model)}</dd></div>
        <div><dt>Computer / tools</dt><dd>{String(agent.computerPolicy)} · {agent.computerPolicy === "none" ? "no computer tools" : "scoped guest tools only"}</dd></div>
        <div><dt>Approval policy</dt><dd>{String(agent.approvalPolicy)}</dd></div>
      </dl>}
      {kind === "automation" && <>
        {text(["name"], "Routine name")}{text(["taskTitle"], "Task title")}{text(["instructions"], "Task instructions", true)}
        <p className="small-text">Assigned agent: {String(draft.agentId)}</p>
        <pre className="review-data" aria-label="Drafted cadence">{JSON.stringify(draft.cadence, null, 2)}</pre>
        {checkbox(["enabled"], "Enable this routine after review")}
      </>}
      {kind === "settings" && <>
        {text(["workspaceName"], "Workspace name")}
        <div className="form-grid">{select(["appearance", "theme"], "Theme", ["system", "light", "dark"])}
          {select(["appearance", "density"], "Density", ["comfortable", "compact"])}</div>
        {select(["work", "defaultPriority"], "Default task priority", ["normal", "high"])}
        {select(["work", "approvalPolicy"], "Require approval", ["always", "on-risk"])}
        {checkbox(["notifications", "approvals"], "New approval requests")}{checkbox(["notifications", "completedRuns"], "Completed runs")}
        {draft.computerPolicy !== undefined && <p>Proposed computer policy: {String(draft.computerPolicy)}</p>}
        {draft.parentAccess !== undefined && <p>Proposed parent inspection policy: {String(draft.parentAccess)}</p>}
      </>}
      {(error || localError) && <p className="form-error" role="alert">{localError || error}</p>}
    </div><FormFooter busy={busy} onClose={onClose} label={label} />
  </form>;
}

export function ProposalReview({ proposal, workspace, snapshot, busy, error, onClose, apply }: {
  proposal: TwinDraft | undefined; workspace: WorkspaceSummary | null; snapshot: Snapshot | null;
  busy: boolean; error: string; onClose: () => void;
  apply: (proposal: TwinDraft, editedDraft?: Record<string, unknown>) => Promise<boolean>;
}) {
  const parsed = twinDraftSchema.safeParse(proposal);
  if (!parsed.success || !parsed.data.readyForReview || !parsed.data.basis || parsed.data.kind === "approval"
    || parsed.data.workspaceId !== (workspace?.id ?? null)
    || (parsed.data.kind !== "workspace" && (!snapshot || snapshot.workspaceId !== workspace?.id))) {
    return <p role="alert">A complete, workspace-bound proposal is required before a creation review can open.</p>;
  }
  const reviewed = parsed.data;
  const kind = reviewed.kind;
  let initial = asRecord(reviewed.draft);
  if (kind === "settings") {
    const settings = snapshot!.settings, patch = reviewed.draft;
    initial = { ...settings, ...patch, appearance: { ...settings.appearance, ...patch.appearance },
      work: { ...settings.work, ...patch.work }, notifications: { ...settings.notifications, ...patch.notifications } };
  }
  return <Modal title={`Review ${kind === "automation" ? "routine" : kind} draft`} onClose={onClose} busy={busy}>
    <div className="review-summary"><Badge>Ready for review</Badge><p>{reviewed.summary}</p>
      <p className="small-text muted">Model confidence: {Math.round(reviewed.confidence * 100)}%. The host rechecks hashes, current heads, and verified options before applying.</p></div>
    <ReviewFields key={reviewed.id} kind={kind} initial={initial} document={Boolean(reviewed.basis!.instructionDocument)}
      busy={busy} error={error} onClose={onClose} label="Approve draft" submit={async (draft) => {
        const valid = twinProposalSchema.safeParse({
          kind, draft, assistantMessage: reviewed.assistantMessage, summary: reviewed.summary,
          confidence: reviewed.confidence, readyForReview: true, missing: [],
        });
        if (!valid.success) throw new Error("The review must retain a complete draft. Ask the Twin to revise it.");
        return apply(reviewed, draft);
      }} />
  </Modal>;
}
export function ExistingReview({ kind, existing, snapshot, busy, error, onClose, perform }: {
  kind: "agent" | "automation"; existing: unknown; snapshot: Snapshot; busy: boolean; error: string;
  onClose: () => void; perform: Perform;
}) {
  const [parentRevision] = useState(snapshot.revision);
  const parsed = kind === "agent" ? agentSchema.safeParse(existing) : automationSchema.safeParse(existing);
  const records = kind === "agent" ? snapshot.agents : snapshot.automations;
  if (!parsed.success || !records.some((item) => item.id === parsed.data.id && item.workspaceId === parsed.data.workspaceId)) {
    return <p role="alert">A complete existing record in this workspace is required for review.</p>;
  }
  const { workspaceId: _workspaceId, updatedAt: _updatedAt, ...rest } = parsed.data;
  const initial = { ...rest } as Record<string, unknown>;
  delete initial.nextRunAt;
  delete initial.originWorkspaceId;
  delete initial.retiredAt;
  return <Modal title={`Review existing ${kind === "automation" ? "routine" : "agent"}`} onClose={onClose} busy={busy}>
    <ReviewFields kind={kind} initial={initial} document={false} busy={busy} error={error} onClose={onClose}
      label="Save reviewed changes" submit={async (value) => kind === "agent"
        ? perform("agents.save", { ...agentInputSchema.parse(value), parentRevision }, "Existing agent updated.")
        : perform("automations.save", automationInputSchema.parse(value), "Existing routine updated.")} />
  </Modal>;
}
export function ApprovalForm({ approval, perform, busy, error, onClose, recommendation }: {
  approval: Approval; perform: Perform; busy: boolean; error: string; onClose: () => void; recommendation?: string;
}) {
  const [reason, setReason] = useState(recommendation ?? "I reviewed this exact operation and its scope.");
  const decide = async (decision: "approved" | "denied") => {
    if (await perform("approvals.decide", { id: approval.id, decision, reason }, "Your explicit approval decision was recorded.")) onClose();
  };
  return <Modal title="Review approval decision" onClose={onClose} busy={busy}><div className="form-body">
    <h3>{approval.action}</h3><p>{approval.reason}</p><p className="mono">{approval.operationHash}</p>
    <p className="inline-note">A Twin recommendation does not decide or execute this action. Choose an explicit decision below.</p>
    <Field id="approval-reason" label="Decision reason"><textarea id="approval-reason" value={reason} maxLength={2000} required
      onChange={(event) => setReason(event.target.value)} /></Field>
    {error && <p role="alert" className="form-error">{error}</p>}
  </div><footer className="form-footer"><button className="button secondary" disabled={busy} onClick={onClose}>Close review</button>
    <button className="button danger" disabled={busy || !reason.trim()} onClick={() => { void decide("denied"); }}>Deny action</button>
    <button className="button primary" disabled={busy || !reason.trim()} onClick={() => { void decide("approved"); }}>Approve action</button>
  </footer></Modal>;
}
