import { useState, type FormEvent } from "react";
import { Field, FormFooter, StatusBadge } from "./components";
import type { Agent, AgentInput, Approval, Automation, AutomationInput, Provider, Settings } from "./model";
import type { Perform } from "./useWorkspace";

interface FormProps { perform: Perform; busy: boolean; error: string; onClose: () => void }
function FormError({ error }: { error: string }) {
  return error ? <p className="form-error" role="alert">{error}</p> : null;
}
export function TaskForm({ agents, settings, perform, busy, error, onClose }: FormProps & { agents: Agent[]; settings: Settings }) {
  const [requestId] = useState(() => crypto.randomUUID());
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (await perform("work.createTask", {
      requestId, title: String(fields.get("title")), instructions: String(fields.get("instructions")),
      agentId: String(fields.get("agentId")) || null,
      priority: fields.get("priority") === "high" ? "high" : "normal",
    }, "Task created. It will run only when you start it.")) onClose();
  };
  return <form onSubmit={(event) => { void submit(event); }}>
    <div className="form-body">
      <p className="muted">Define a clear outcome. Work remains queued until an available runtime accepts it.</p>
      <Field id="task-title" label="Task title"><input id="task-title" name="title" required maxLength={160} data-autofocus placeholder="What needs to get done?" /></Field>
      <Field id="task-instructions" label="Instructions and expected outcome"><textarea id="task-instructions" name="instructions" required maxLength={16000} rows={5} placeholder="Include context, constraints, and the evidence you expect." /></Field>
      <div className="form-grid">
        <Field id="task-agent" label="Assign to"><select id="task-agent" name="agentId">
          <option value="">Unassigned</option>{agents.filter((agent) => agent.enabled).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </select></Field>
        <Field id="task-priority" label="Priority"><select id="task-priority" name="priority" defaultValue={settings.work.defaultPriority}>
          <option value="normal">Normal</option><option value="high">High</option>
        </select></Field>
      </div>
      <FormError error={error} />
    </div><FormFooter busy={busy} onClose={onClose} label="Create task" />
  </form>;
}
export function AgentForm({ agent, providers, perform, busy, error, onClose }: FormProps & { agent?: Agent; providers: Provider[] }) {
  const [id] = useState(() => agent?.id ?? crypto.randomUUID());
  const [providerId, setProvider] = useState(agent?.providerId ?? "");
  const [model, setModel] = useState(agent?.model ?? "");
  const provider = providers.find((item) => item.id === providerId);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const input: AgentInput = {
      id, name: String(fields.get("name")), role: String(fields.get("role")), instructions: String(fields.get("instructions")),
      providerId: providerId || null, model,
      computerPolicy: fields.get("computerPolicy") as AgentInput["computerPolicy"],
      approvalPolicy: fields.get("approvalPolicy") as AgentInput["approvalPolicy"],
      enabled: fields.has("enabled"),
    };
    if (await perform("agents.save", input, "Agent configuration saved.")) onClose();
  };
  return <form onSubmit={(event) => { void submit(event); }}>
    <div className="form-body">
      <div className="form-grid">
        <Field id="agent-name" label="Agent name"><input id="agent-name" name="name" defaultValue={agent?.name} required maxLength={160} data-autofocus placeholder="Operations analyst" /></Field>
        <Field id="agent-role" label="Role"><input id="agent-role" name="role" defaultValue={agent?.role} maxLength={240} placeholder="Responsibilities or team" /></Field>
      </div>
      <Field id="agent-instructions" label="Agent instructions"><textarea id="agent-instructions" name="instructions" defaultValue={agent?.instructions} required rows={4} maxLength={16000} placeholder="Define responsibilities, boundaries, and review expectations." /></Field>
      <div className="form-grid">
        <Field id="agent-provider" label="Provider"><select id="agent-provider" value={providerId} onChange={(event) => {
          setProvider(event.target.value); setModel(providers.find((item) => item.id === event.target.value)?.models[0] ?? "");
        }}><option value="">Not connected</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}{!item.configured && " · needs setup"}</option>)}</select></Field>
        <Field id="agent-model" label="Model"><select id="agent-model" value={model} disabled={!provider?.models.length} onChange={(event) => setModel(event.target.value)}>
          <option value="">Select a model</option>{provider?.models.map((item) => <option key={item}>{item}</option>)}
          {model && !provider?.models.includes(model) && <option value={model}>{model} · unavailable</option>}
        </select></Field>
      </div>
      {!provider?.configured && <p className="inline-note">You can save this agent now. A connected provider and runtime are required before it can execute work.</p>}
      <div className="form-grid">
        <Field id="agent-computer" label="Computer access"><select id="agent-computer" name="computerPolicy" defaultValue={agent?.computerPolicy ?? "none"}>
          <option value="none">No computer access</option><option value="read-only">Read-only access</option><option value="control">Control with approval policy</option>
        </select></Field>
        <Field id="agent-approval" label="Approval policy"><select id="agent-approval" name="approvalPolicy" defaultValue={agent?.approvalPolicy ?? "always"}>
          <option value="always">Always require approval</option><option value="on-risk">Require for sensitive actions</option>
        </select></Field>
      </div>
      <p className="field-help">The workspace approval policy can be stricter than the agent policy.</p>
      <label className="checkbox-row"><input type="checkbox" name="enabled" defaultChecked={agent?.enabled ?? true} />Enable this agent for assignment</label>
      <FormError error={error} />
    </div><FormFooter busy={busy} onClose={onClose} label={agent ? "Save agent" : "Create agent"} />
  </form>;
}
export function AutomationForm({ automation, agents, perform, busy, error, onClose }: FormProps & { automation?: Automation; agents: Agent[] }) {
  const [id] = useState(() => automation?.id ?? crypto.randomUUID());
  const [kind, setKind] = useState<AutomationInput["cadence"]["kind"]>(automation?.cadence.kind ?? "daily");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const cadence: AutomationInput["cadence"] = kind === "interval"
      ? { kind, minutes: Number(fields.get("minutes")) }
      : kind === "weekly"
        ? { kind, at: String(fields.get("at")), timezone: String(fields.get("timezone")), weekday: Number(fields.get("weekday")) }
        : { kind, at: String(fields.get("at")), timezone: String(fields.get("timezone")) };
    if (await perform("automations.save", {
      id, name: String(fields.get("name")), taskTitle: String(fields.get("taskTitle")),
      instructions: String(fields.get("instructions")), agentId: String(fields.get("agentId")),
      cadence, enabled: fields.has("enabled"),
    }, "Schedule saved.")) onClose();
  };
  const scheduled = automation?.cadence && automation.cadence.kind !== "interval" ? automation.cadence : null;
  return <form onSubmit={(event) => { void submit(event); }}>
    <div className="form-body">
      <Field id="automation-name" label="Schedule name"><input id="automation-name" name="name" defaultValue={automation?.name} required maxLength={160} data-autofocus /></Field>
      <Field id="automation-task" label="Task title"><input id="automation-task" name="taskTitle" defaultValue={automation?.taskTitle} required maxLength={160} /></Field>
      <Field id="automation-instructions" label="Task instructions"><textarea id="automation-instructions" name="instructions" defaultValue={automation?.instructions} required maxLength={16000} rows={3} /></Field>
      <div className="form-grid">
        <Field id="automation-agent" label="Assigned agent"><select id="automation-agent" name="agentId" required defaultValue={automation?.agentId ?? ""}>
          <option value="" disabled>Select an agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}{!agent.enabled && " · paused"}</option>)}
        </select></Field>
        <Field id="automation-cadence" label="Repeat"><select id="automation-cadence" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
          <option value="daily">Daily</option><option value="weekly">Weekly</option><option value="interval">At an interval</option>
        </select></Field>
      </div>
      {kind === "interval" ? <Field id="automation-minutes" label="Every (minutes)" help="From 15 minutes to 7 days.">
        <input id="automation-minutes" name="minutes" type="number" min={15} max={10080} step={1} required aria-describedby="automation-minutes-help" defaultValue={automation?.cadence.kind === "interval" ? automation.cadence.minutes : 60} />
      </Field> : <div className="form-grid">
        <Field id="automation-at" label="Local time"><input id="automation-at" name="at" type="time" required defaultValue={scheduled?.at ?? "09:00"} /></Field>
        <Field id="automation-timezone" label="Time zone (IANA)"><input id="automation-timezone" name="timezone" required maxLength={100} defaultValue={scheduled?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone} placeholder="America/New_York" /></Field>
        {kind === "weekly" && <Field id="automation-weekday" label="Day of week"><select id="automation-weekday" name="weekday" defaultValue={automation?.cadence.kind === "weekly" ? automation.cadence.weekday : 1}>
          {["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((day, index) => <option key={day} value={index}>{day}</option>)}
        </select></Field>}
      </div>}
      <label className="checkbox-row"><input type="checkbox" name="enabled" defaultChecked={automation?.enabled ?? false} />Enable this schedule</label>
      <p className="inline-note">Disabled schedules are saved as drafts. Enabling requires a connected scheduling runtime to confirm the next run. Keep RAPP Work open for local scheduling.</p>
      <FormError error={error} />
    </div><FormFooter busy={busy} onClose={onClose} label="Save schedule" />
  </form>;
}
export function ApprovalForm({ approval, perform, busy, error, onClose }: FormProps & { approval: Approval }) {
  const [decision, setDecision] = useState<"approved" | "denied">("approved");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(new FormData(event.currentTarget).get("reason"));
    if (await perform("approvals.decide", { id: approval.id, decision, reason }, "Approval decision recorded. Execution status is reported separately by the runtime.")) onClose();
  };
  return <form onSubmit={(event) => { void submit(event); }}><div className="form-body">
    <div className="row between"><h3>{approval.action}</h3><StatusBadge state={approval.state} /></div>
    <p>{approval.reason}</p>
    <dl className="metadata"><div><dt>Risk</dt><dd>{approval.risk}</dd></div><div><dt>Run</dt><dd className="mono">{approval.runId}</dd></div></dl>
    <dl className="metadata"><div><dt>Agent workspace</dt><dd className="mono">{approval.workspaceId}</dd></div><div><dt>Exact operation</dt><dd className="mono">{approval.operationHash}</dd></div></dl>
    <Field id="approval-decision" label="Decision"><select id="approval-decision" value={decision} onChange={(event) => setDecision(event.target.value as typeof decision)}>
      <option value="approved">Approve this action only</option><option value="denied">Deny this action</option>
    </select></Field>
    <Field id="approval-reason" label="Decision reason"><textarea id="approval-reason" name="reason" required rows={3} maxLength={2000} data-autofocus placeholder="Record why this action is approved or denied." /></Field>
    <FormError error={error} />
  </div><FormFooter busy={busy} onClose={onClose} label={decision === "approved" ? "Approve action" : "Deny action"} /></form>;
}
