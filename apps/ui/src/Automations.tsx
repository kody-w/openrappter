import { Badge, Empty, formatDate, Icon } from "./components";
import type { Automation, Snapshot } from "./model";

export function describeCadence(automation: Automation): string {
  const cadence = automation.cadence;
  if (cadence.kind === "interval") return `Every ${cadence.minutes} minutes`;
  const day = cadence.kind === "weekly" ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][cadence.weekday] : "Every day";
  return `${day} at ${cadence.at} · ${cadence.timezone}`;
}
export function Automations({ snapshot, edit, create, connected }: {
  snapshot: Snapshot; edit: (automation: Automation) => void; create: () => void; connected: boolean;
}) {
  return <section className="workspace-panel">
    <div className="section-header"><div><h2>Work on a schedule</h2><p className="muted">Repeat the work, not the setup. Each execution remains a traceable task.</p></div><Badge>{snapshot.automations.filter((automation) => automation.enabled).length} enabled</Badge></div>
    {!snapshot.automations.length ? <Empty icon="automations" title="Build a dependable routine" action={<button className="button primary" disabled={!connected || !snapshot.agents.length} onClick={create}><Icon name="plus" size={16} />Create a schedule</button>}>
      {snapshot.agents.length ? "Save daily, weekly, or interval-based tasks. A scheduling runtime must confirm activation." : "Create an agent first, then define when its work should repeat."}
    </Empty> : <div className="card-list">{snapshot.automations.map((automation) => <article className="automation-card" key={automation.id}>
      <div className="row between wrap"><div className="row"><span className="surface-icon"><Icon name="automations" /></span><div><h3>{automation.name}</h3><p className="muted small-text">{describeCadence(automation)}</p></div></div><Badge tone={automation.enabled ? "positive" : "neutral"}>{automation.enabled ? "Enabled" : "Draft"}</Badge></div>
      <div className="automation-body"><div><p className="strong">{automation.taskTitle}</p><p className="clamp muted">{automation.instructions}</p></div><dl className="metadata compact"><div><dt>Assigned to</dt><dd>{snapshot.agents.find((agent) => agent.id === automation.agentId)?.name ?? "Unavailable agent"}</dd></div><div><dt>Next run</dt><dd>{automation.enabled ? formatDate(automation.nextRunAt) : "Not scheduled"}</dd></div></dl></div>
      <div className="row between wrap"><p className="field-help">Local schedules require RAPP Work and its runtime to remain available.</p><button className="button secondary" disabled={!connected} onClick={() => edit(automation)}>Edit schedule<Icon name="arrow" size={16} /></button></div>
    </article>)}</div>}
  </section>;
}
