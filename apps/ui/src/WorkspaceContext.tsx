import { agentAvailability } from "./Agents";
import { describeCadence } from "./Automations";
import { Avatar, Badge, Icon, StatusBadge } from "./components";
import type { Area, Computer, Provider, Snapshot, TwinTarget, WorkspaceSummary } from "./model";

export function WorkspaceContext({ workspace, snapshot, computer, providers, open, connected, busy, inspect, askTwin, onReturn }: {
  workspace: WorkspaceSummary | null; snapshot: Snapshot | null; computer: Computer | null; providers: Provider[];
  open: boolean; connected: boolean; busy: boolean; inspect: (area: Area) => void;
  askTwin: (text: string, target?: TwinTarget) => void;
  onReturn: () => void;
}) {
  const disabled = !connected || busy;
  const active = snapshot?.tasks.filter((task) => ["queued", "running", "awaiting_approval"].includes(task.state)) ?? [];
  const approvals = snapshot?.approvals.filter((item) => item.state === "pending" && !item.consumedBy) ?? [];
  return <aside id="workspace-context" className={`workspace-context${open ? " is-open" : ""}`} aria-label="Workspace status" tabIndex={-1}>
    <div className="context-heading"><span className="eyebrow">Workspace context</span><Icon name="shield" size={17} /><button className="icon-button context-return" aria-label="Return to Twin conversation" onClick={onReturn}><Icon name="close" size={18} /></button></div>
    {!workspace ? <div className="concierge-context"><span className="surface-icon"><Icon name="work" size={25} /></span><h2>A place for every business</h2><p>Tell the concierge your goal. It drafts a workspace, a dedicated Twin, a lead agent, and starter work for you to approve.</p><ol><li>Describe what you want to run.</li><li>Review the Twin's complete proposal.</li><li>Create your independent workspace.</li></ol><p className="inline-note">No blank setup forms. Nothing is created just by sending a message.</p></div> : <>
      <section className="context-section" aria-labelledby="computer-title">
        <div className="row between"><h2 id="computer-title">Local computer</h2><StatusBadge state={computer?.state ?? "unavailable"} /></div>
        <div className="local-screen" aria-label="Computer screen status"><Icon name="computer" size={45} /><strong>{computer?.state === "running" ? "Service reports running" : "Screen not connected"}</strong><span>No live screen stream is available.</span></div>
        <p className="context-detail">{computer?.detail ?? "Waiting for a service report for this workspace."}</p>
        <div className="row wrap"><Badge tone={computer?.verified ? "positive" : "neutral"}>{computer?.verified ? "Evidence verified" : "Not verified"}</Badge><span className="small-text muted">{computer?.evidenceIds.length ?? 0} evidence references</span></div>
        <button className="text-button" disabled={disabled} onClick={() => askTwin("Help me check this workspace's local computer and explain the next safe setup step.")}>Discuss computer setup<Icon name="arrow" size={15} /></button>
      </section>
      {approvals.length > 0 && <section className="context-section approval-context"><div className="row between"><h2>Needs your decision</h2><Badge tone="attention">{approvals.length}</Badge></div><p className="context-detail">Your Twin can advise. Approval and denial are always your explicit choice.</p><button className="button secondary" disabled={disabled} onClick={() => askTwin(`Review pending approval ${approvals[0]!.id} and recommend whether to approve or deny it, with a reason.`, "approval")}>Ask Twin for a recommendation</button><button className="text-button" onClick={() => inspect("work")}>Inspect approvals</button></section>}
      <section className="context-section" aria-labelledby="routines-title"><div className="row between"><h2 id="routines-title">Routines</h2><button className="icon-button" disabled={disabled} aria-label="New routine" onClick={() => askTwin("Create a routine that ", "automation")}><Icon name="plus" size={16} /></button></div>
        {!snapshot?.automations.length ? <p className="context-detail">Describe a repeatable outcome. Your Twin will draft the schedule.</p> :
          <ul className="context-list">{snapshot.automations.slice(0, 4).map((routine) => <li key={routine.id}><button onClick={() => inspect("automations")}><Icon name="clock" size={17} /><span><strong>{routine.name}</strong><small>{describeCadence(routine)} · {routine.enabled ? "Enabled" : "Draft"}</small></span></button></li>)}</ul>}
        <button className="text-button" onClick={() => inspect("automations")}>Inspect routines<Icon name="arrow" size={15} /></button>
      </section>
      <section className="context-section" aria-labelledby="agents-title"><div className="row between"><h2 id="agents-title">Agents</h2><button className="icon-button" aria-label="New agent" disabled={disabled} onClick={() => askTwin("Create an agent responsible for ", "agent")}><Icon name="plus" size={16} /></button></div>
        {!snapshot?.agents.length ? <p className="context-detail">Your Twin will help define the right responsibilities.</p> :
          <ul className="context-list">{snapshot.agents.slice(0, 5).map((agent) => <li key={agent.id}><button onClick={() => inspect("agents")}><Avatar name={agent.name} small /><span><strong>{agent.name}</strong><small>{agentAvailability(agent, providers, snapshot)}</small></span></button></li>)}</ul>}
        <button className="text-button" onClick={() => inspect("agents")}>Inspect agents<Icon name="arrow" size={15} /></button>
      </section>
      <section className="context-section" aria-labelledby="tasks-title"><div className="row between"><h2 id="tasks-title">Active tasks</h2><button className="icon-button" aria-label="New task" disabled={disabled} onClick={() => askTwin("Create a task to ", "task")}><Icon name="plus" size={16} /></button></div>
        {!active.length ? <p className="context-detail">No active tasks reported. Tell your Twin what should happen next.</p> :
          <ul className="context-list">{active.slice(0, 4).map((task) => <li key={task.id}><button onClick={() => inspect("work")}><Icon name="work" size={17} /><span><strong>{task.title}</strong><small>{task.state.replaceAll("_", " ")}</small></span></button></li>)}</ul>}
        <button className="text-button" onClick={() => inspect("work")}>Inspect tasks & evidence<Icon name="arrow" size={15} /></button>
      </section>
      <button className="button secondary context-settings" onClick={() => inspect("settings")}><Icon name="settings" size={16} />Workspace settings</button>
    </>}
    <p className="context-footer">Local by design. Evidence by default.</p>
  </aside>;
}
