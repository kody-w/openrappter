import { useState, type FormEvent } from "react";
import { describeCadence } from "./Automations";
import { Field, FormFooter, StatusBadge } from "./components";
import { agentInputSchema, automationInputSchema, settingsSchema, taskInputSchema, taskSchema, workspaceInputSchema, type Agent, type AgentInput, type Approval, type AutomationInput, type Provider, type Settings, type Task, type TaskInput, type WorkspaceInput } from "./model";

export type ReviewSource = "twin" | "existing";
interface ReviewProps<T> {
  draft: T;
  source: ReviewSource;
  onSave: (input: T) => Promise<boolean>;
  busy: boolean;
  error: string;
  onClose: () => void;
}
export function ReviewNote({ source }: { source: ReviewSource }) {
  return <p className="review-note">{source === "twin"
    ? "Drafted by your Work Twin. Every detail is prefilled. Review or make small edits before applying."
    : "Prefilled from the saved workspace record. Review or make small edits; nothing changes until you save."}</p>;
}
function FormError({ error }: { error: string }) {
  return error ? <p className="form-error" role="alert">{error}</p> : null;
}
function IncompleteReview() {
  return <p className="form-body form-error" role="alert">This draft is incomplete. Return to your Twin to finish it; no blank form is available.</p>;
}
export function TaskForm({ draft, source, agents, onSave, busy, error, onClose }: ReviewProps<TaskInput> & { agents: Agent[] }) {
  if (!taskInputSchema.safeParse(draft).success) return <IncompleteReview />;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (await onSave({
      ...draft, title: String(fields.get("title")), instructions: String(fields.get("instructions")),
      agentId: String(fields.get("agentId")) || null,
      priority: fields.get("priority") === "high" ? "high" : "normal",
    })) onClose();
  };
  return <form onSubmit={(event) => { void submit(event); }}>
    <div className="form-body">
      <ReviewNote source={source} />
      <Field id="task-title" label="Task title"><input id="task-title" name="title" defaultValue={draft.title} required maxLength={160} data-autofocus /></Field>
      <Field id="task-instructions" label="Instructions and expected outcome"><textarea id="task-instructions" name="instructions" defaultValue={draft.instructions} required maxLength={16000} rows={5} /></Field>
      <div className="form-grid">
        <Field id="task-agent" label="Assign to"><select id="task-agent" name="agentId" defaultValue={draft.agentId ?? ""}>
          <option value="">Unassigned — do not run yet</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{!agent.enabled && " · paused"}</option>)}
        </select></Field>
        <Field id="task-priority" label="Priority"><select id="task-priority" name="priority" defaultValue={draft.priority}>
          <option value="normal">Normal</option><option value="high">High</option>
        </select></Field>
      </div>
      <p className="inline-note">Applying creates a queued task, not a completed or verified outcome.</p>
      <FormError error={error} />
    </div><FormFooter busy={busy} onClose={onClose} label={source === "twin" ? "Approve & create task" : "Save task"} />
  </form>;
}
export function SavedTaskForm({ task, agents, assignable, onAssign, busy, error, onClose }: {
  task: Task; agents: Agent[]; assignable: boolean; onAssign: (agentId: string) => Promise<boolean>;
  busy: boolean; error: string; onClose: () => void;
}) {
  const [agentId, setAgent] = useState(task?.agentId ?? "");
  if (!taskSchema.safeParse(task).success) return <IncompleteReview />;
  return <form onSubmit={(event) => {
    event.preventDefault();
    if (assignable && agentId) void onAssign(agentId).then((saved) => { if (saved) onClose(); });
  }}><div className="form-body">
    <ReviewNote source="existing" />
    <Field id="saved-task-title" label="Task title"><input id="saved-task-title" value={task.title} readOnly data-autofocus /></Field>
    <Field id="saved-task-instructions" label="Instructions and expected outcome"><textarea id="saved-task-instructions" value={task.instructions} readOnly rows={4} /></Field>
    <div className="form-grid">
      <Field id="saved-task-priority" label="Priority"><input id="saved-task-priority" value={task.priority} readOnly /></Field>
      <Field id="saved-task-agent" label="Assign to"><select id="saved-task-agent" value={agentId} onChange={(event) => setAgent(event.target.value)} disabled={!assignable}>
        <option value="">Unassigned</option>{agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.enabled}>{agent.name}{!agent.enabled && " · paused"}</option>)}
      </select></Field>
    </div>
    <p className="inline-note">{assignable ? "The saved outcome stays unchanged. Assignment can be reviewed before the first run." : "This task already has execution history; its assignment cannot be changed."} To plan a different outcome, return to your Twin.</p>
    <FormError error={error} />
  </div><footer className="form-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>Close</button>
    {assignable && <button type="submit" className="button primary" disabled={busy || !agentId || !agents.some((agent) => agent.id === agentId && agent.enabled)}>{busy ? "Saving…" : "Save assignment"}</button>}
  </footer></form>;
}
export function AgentForm(props: ReviewProps<AgentInput> & { providers: Provider[] }) {
  if (!agentInputSchema.safeParse(props.draft).success) return <IncompleteReview />;
  return <AgentReview {...props} />;
}
function AgentReview({ draft, source, providers, onSave, busy, error, onClose }: ReviewProps<AgentInput> & { providers: Provider[] }) {
  const [providerId, setProvider] = useState(draft.providerId ?? "");
  const [model, setModel] = useState(draft.model);
  const provider = providers.find((item) => item.id === providerId);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const input: AgentInput = {
      ...draft, name: String(fields.get("name")), role: String(fields.get("role")), instructions: String(fields.get("instructions")),
      providerId: providerId || null, model,
      computerPolicy: fields.get("computerPolicy") as AgentInput["computerPolicy"],
      approvalPolicy: fields.get("approvalPolicy") as AgentInput["approvalPolicy"],
      enabled: fields.has("enabled"),
    };
    if (await onSave(input)) onClose();
  };
  return <form onSubmit={(event) => { void submit(event); }}>
    <div className="form-body">
      <ReviewNote source={source} />
      <div className="form-grid">
        <Field id="agent-name" label="Agent name"><input id="agent-name" name="name" defaultValue={draft.name} required maxLength={160} data-autofocus /></Field>
        <Field id="agent-role" label="Role"><input id="agent-role" name="role" defaultValue={draft.role} maxLength={240} /></Field>
      </div>
      <Field id="agent-instructions" label="Agent instructions"><textarea id="agent-instructions" name="instructions" defaultValue={draft.instructions} required rows={4} maxLength={16000} /></Field>
      <div className="form-grid">
        <Field id="agent-provider" label="Provider"><select id="agent-provider" value={providerId} onChange={(event) => {
          setProvider(event.target.value); setModel(providers.find((item) => item.id === event.target.value)?.models[0] ?? "");
        }}><option value="">Not connected</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}{!item.configured && " · needs setup"}</option>)}
          {providerId && !provider && <option value={providerId}>{providerId} · unavailable</option>}
        </select></Field>
        <Field id="agent-model" label="Model"><select id="agent-model" value={model} disabled={!provider?.models.length} onChange={(event) => setModel(event.target.value)}>
          <option value="">No model connected</option>{provider?.models.map((item) => <option key={item}>{item}</option>)}
          {model && !provider?.models.includes(model) && <option value={model}>{model} · unavailable</option>}
        </select></Field>
      </div>
      {!provider?.configured && <p className="inline-note">A connected provider and runtime are required before this agent can execute work.</p>}
      <div className="form-grid">
        <Field id="agent-computer" label="Computer access"><select id="agent-computer" name="computerPolicy" defaultValue={draft.computerPolicy}>
          <option value="none">No computer access</option><option value="read-only">Read-only access</option><option value="control">Control with approval policy</option>
        </select></Field>
        <Field id="agent-approval" label="Approval policy"><select id="agent-approval" name="approvalPolicy" defaultValue={draft.approvalPolicy}>
          <option value="always">Always require approval</option><option value="on-risk">Require for sensitive actions</option>
        </select></Field>
      </div>
      <p className="field-help">The stricter workspace or agent approval policy applies.</p>
      <label className="checkbox-row"><input type="checkbox" name="enabled" defaultChecked={draft.enabled} />Enable this agent for assignment</label>
      <FormError error={error} />
    </div><FormFooter busy={busy} onClose={onClose} label={source === "twin" ? "Approve & create agent" : "Save agent"} />
  </form>;
}
export function AutomationForm(props: ReviewProps<AutomationInput> & { agents: Agent[] }) {
  if (!automationInputSchema.safeParse(props.draft).success) return <IncompleteReview />;
  return <AutomationReview {...props} />;
}
function AutomationReview({ draft, source, agents, onSave, busy, error, onClose }: ReviewProps<AutomationInput> & { agents: Agent[] }) {
  const [kind, setKind] = useState<AutomationInput["cadence"]["kind"]>(draft.cadence.kind);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const cadence: AutomationInput["cadence"] = kind === "interval"
      ? { kind, minutes: Number(fields.get("minutes")) }
      : kind === "weekly"
        ? { kind, at: String(fields.get("at")), timezone: String(fields.get("timezone")), weekday: Number(fields.get("weekday")) }
        : { kind, at: String(fields.get("at")), timezone: String(fields.get("timezone")) };
    if (await onSave({
      ...draft, name: String(fields.get("name")), taskTitle: String(fields.get("taskTitle")),
      instructions: String(fields.get("instructions")), agentId: String(fields.get("agentId")),
      cadence, enabled: fields.has("enabled"),
    })) onClose();
  };
  const scheduled = draft.cadence.kind !== "interval" ? draft.cadence : null;
  return <form onSubmit={(event) => { void submit(event); }}>
    <div className="form-body">
      <ReviewNote source={source} />
      <Field id="automation-name" label="Routine name"><input id="automation-name" name="name" defaultValue={draft.name} required maxLength={160} data-autofocus /></Field>
      <Field id="automation-task" label="Task title"><input id="automation-task" name="taskTitle" defaultValue={draft.taskTitle} required maxLength={160} /></Field>
      <Field id="automation-instructions" label="Task instructions"><textarea id="automation-instructions" name="instructions" defaultValue={draft.instructions} required maxLength={16000} rows={3} /></Field>
      <div className="form-grid">
        <Field id="automation-agent" label="Assigned agent"><select id="automation-agent" name="agentId" required defaultValue={draft.agentId}>
          {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{!agent.enabled && " · paused"}</option>)}
        </select></Field>
        <Field id="automation-cadence" label="Repeat"><select id="automation-cadence" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="interval">At an interval</option>
        </select></Field>
      </div>
      {kind === "interval" ? <Field id="automation-minutes" label="Every (minutes)" help="From 15 minutes to 7 days.">
        <input id="automation-minutes" name="minutes" type="number" min={15} max={10080} step={1} required aria-describedby="automation-minutes-help" defaultValue={draft.cadence.kind === "interval" ? draft.cadence.minutes : 60} />
      </Field> : <div className="form-grid">
        <Field id="automation-at" label="Local time"><input id="automation-at" name="at" type="time" required defaultValue={scheduled?.at ?? "09:00"} /></Field>
        <Field id="automation-timezone" label="Time zone (IANA)"><input id="automation-timezone" name="timezone" required maxLength={100} defaultValue={scheduled?.timezone ?? "UTC"} /></Field>
        {kind === "weekly" && <Field id="automation-weekday" label="Day of week"><select id="automation-weekday" name="weekday" defaultValue={draft.cadence.kind === "weekly" ? draft.cadence.weekday : 1}>
          {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => <option key={day} value={index}>{day}</option>)}
        </select></Field>}
      </div>}
      <label className="checkbox-row"><input type="checkbox" name="enabled" defaultChecked={draft.enabled} />Enable this routine</label>
      <p className="inline-note">Disabled routines remain drafts. Activation and the next run must be confirmed by the scheduling runtime.</p>
      <FormError error={error} />
    </div><FormFooter busy={busy} onClose={onClose} label={source === "twin" ? "Approve & create routine" : "Save routine"} />
  </form>;
}
export function SettingsForm({ draft, source, onSave, busy, error, onClose }: ReviewProps<Settings>) {
  if (!settingsSchema.safeParse(draft).success) return <IncompleteReview />;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (await onSave({
      workspaceName: String(fields.get("workspaceName")),
      appearance: { theme: fields.get("theme") as Settings["appearance"]["theme"], density: fields.get("density") as Settings["appearance"]["density"] },
      work: { defaultPriority: fields.get("defaultPriority") as Settings["work"]["defaultPriority"], approvalPolicy: fields.get("approvalPolicy") as Settings["work"]["approvalPolicy"] },
      notifications: { approvals: fields.has("approvals"), completedRuns: fields.has("completedRuns") },
    })) onClose();
  };
  return <form onSubmit={(event) => { void submit(event); }}><div className="form-body">
    <ReviewNote source={source} />
    <Field id="settings-name" label="Workspace name"><input id="settings-name" name="workspaceName" required maxLength={160} defaultValue={draft.workspaceName} data-autofocus /></Field>
    <div className="form-grid">
      <Field id="settings-theme" label="Theme"><select id="settings-theme" name="theme" defaultValue={draft.appearance.theme}><option value="system">Follow system</option><option value="light">Light</option><option value="dark">Dark</option></select></Field>
      <Field id="settings-density" label="Density"><select id="settings-density" name="density" defaultValue={draft.appearance.density}><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select></Field>
      <Field id="settings-priority" label="Default task priority"><select id="settings-priority" name="defaultPriority" defaultValue={draft.work.defaultPriority}><option value="normal">Normal</option><option value="high">High</option></select></Field>
      <Field id="settings-policy" label="Require approval"><select id="settings-policy" name="approvalPolicy" defaultValue={draft.work.approvalPolicy}><option value="always">For all actions</option><option value="on-risk">For sensitive actions</option></select></Field>
    </div>
    <label className="checkbox-row"><input type="checkbox" name="approvals" defaultChecked={draft.notifications.approvals} />New approval requests</label>
    <label className="checkbox-row"><input type="checkbox" name="completedRuns" defaultChecked={draft.notifications.completedRuns} />Completed runs</label>
    <FormError error={error} />
  </div><FormFooter busy={busy} onClose={onClose} label={source === "twin" ? "Approve & apply settings" : "Save settings"} /></form>;
}
export function WorkspaceForm({ draft, source, onSave, busy, error, onClose }: ReviewProps<WorkspaceInput>) {
  if (!workspaceInputSchema.safeParse(draft).success) return <IncompleteReview />;
  return <form onSubmit={(event) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    void onSave({
      ...draft, name: String(fields.get("name")), purpose: String(fields.get("purpose")),
      twin: { name: String(fields.get("twinName")), instructions: String(fields.get("twinInstructions")) },
    }).then((saved) => { if (saved) onClose(); });
  }}><div className="form-body">
    <ReviewNote source={source} />
    <Field id="workspace-name" label="Workspace name"><input id="workspace-name" name="name" defaultValue={draft.name} required maxLength={160} data-autofocus /></Field>
    <Field id="workspace-purpose" label="Workspace purpose"><textarea id="workspace-purpose" name="purpose" defaultValue={draft.purpose} required maxLength={4000} rows={4} /></Field>
    <Field id="workspace-twin-name" label="Twin name"><input id="workspace-twin-name" name="twinName" defaultValue={draft.twin.name} required maxLength={160} /></Field>
    <Field id="workspace-twin-instructions" label="Twin instructions"><textarea id="workspace-twin-instructions" name="twinInstructions" defaultValue={draft.twin.instructions} required maxLength={16000} rows={4} /></Field>
    <details className="proposal-details"><summary>Prefilled team, policies & starter work</summary>
      <dl className="metadata"><div><dt>Lead agent</dt><dd>{draft.leadAgent.name} · {draft.leadAgent.role}</dd></div>
        <div><dt>Instructions</dt><dd className="preserve">{draft.leadAgent.instructions}</dd></div>
        <div><dt>Model</dt><dd>{draft.leadAgent.providerId ?? "Not connected"} · {draft.leadAgent.model || "Not connected"}</dd></div>
        <div><dt>Computer</dt><dd>Workspace: {draft.computerPolicy} · Agent: {draft.leadAgent.computerPolicy}</dd></div>
        <div><dt>Approval</dt><dd>Workspace: {draft.approvalPolicy} · Agent: {draft.leadAgent.approvalPolicy}</dd></div>
        <div><dt>Agent assignment</dt><dd>{draft.leadAgent.enabled ? "Enabled" : "Paused"}</dd></div>
        <div><dt>Starter task</dt><dd>{draft.starterTask ? `${draft.starterTask.title} — ${draft.starterTask.instructions} (${draft.starterTask.priority} priority, assigned to ${draft.leadAgent.name}, queued until started)` : "None proposed"}</dd></div>
        <div><dt>Routines</dt><dd>{draft.starterRoutines.length ? `${draft.starterRoutines.length} complete routines, detailed below` : "None proposed"}</dd></div>
      </dl>
      {draft.starterRoutines.length > 0 && <ul className="starter-routines">{draft.starterRoutines.map((routine) => <li key={routine.id}>
        <h3>{routine.name}</h3><p>{describeCadence(routine)}</p>
        <p>{routine.enabled ? "Requests activation on creation" : "Disabled draft"} · Assigned to {draft.leadAgent.name}</p>
        <p><strong>{routine.taskTitle}</strong></p><p className="preserve">{routine.instructions}</p>
      </li>)}</ul>}
    </details>
    <p className="inline-note">This creates a separate business workspace with its own Twin conversation, agents, tasks, routines, and settings.</p>
    <FormError error={error} />
  </div><FormFooter busy={busy} onClose={onClose} label="Approve & create workspace" /></form>;
}
export function ApprovalForm({ approval, recommendation, initialReason, onDecide, busy, error, onClose }: {
  approval: Approval; recommendation?: string; initialReason: string;
  onDecide: (decision: "approved" | "denied", reason: string) => Promise<boolean>;
  busy: boolean; error: string; onClose: () => void;
}) {
  const [reason, setReason] = useState(initialReason);
  const pending = approval.state === "pending" && !approval.consumedBy && new Date(approval.expiresAt).getTime() > Date.now();
  const decide = async (decision: "approved" | "denied") => { if (await onDecide(decision, reason.trim())) onClose(); };
  return <form onSubmit={(event) => event.preventDefault()}><div className="form-body">
    <p className="review-note">{recommendation ? "Your Twin drafted a recommendation and reason. It cannot approve or deny this action for you." : "Prefilled from the existing approval request. The decision is yours alone."}</p>
    <div className="row between"><h3>{approval.action}</h3><StatusBadge state={approval.state} /></div>
    <p>{approval.reason}</p>
    {recommendation && <p className="inline-note">Twin recommendation: {recommendation}. Not a recorded decision.</p>}
    <dl className="metadata"><div><dt>Risk</dt><dd>{approval.risk}</dd></div><div><dt>Run</dt><dd className="mono">{approval.runId}</dd></div><div><dt>Workspace</dt><dd className="mono">{approval.workspaceId}</dd></div><div><dt>Exact operation</dt><dd className="mono">{approval.operationHash}</dd></div></dl>
    <Field id="approval-reason" label="Decision reason"><textarea id="approval-reason" value={reason} onChange={(event) => setReason(event.target.value)} required rows={3} maxLength={2000} data-autofocus /></Field>
    {!pending && <p role="status">This request is no longer pending or has expired. Refresh before making a decision.</p>}
    <FormError error={error} />
  </div><footer className="form-footer">
    <button type="button" className="button secondary" onClick={onClose} disabled={busy}>Close</button>
    <button type="button" className="button danger" disabled={busy || !pending || !reason.trim()} onClick={() => { void decide("denied"); }}>Deny action</button>
    <button type="button" className="button primary" disabled={busy || !pending || !reason.trim()} onClick={() => { void decide("approved"); }}>Approve action</button>
  </footer></form>;
}
