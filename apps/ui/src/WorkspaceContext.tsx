import { agentAvailability } from "./Agents";
import { describeCadence } from "./Automations";
import { AgentComputer } from "./AgentComputer";
import { Avatar, Badge, Icon } from "./components";
import type { Agent, Area, Computer, Provider, Snapshot, TwinTarget, WorkspaceSummary } from "./model";

export function WorkspaceContext({ workspace, snapshot, computer, providers, open, connected, busy, inspect, askTwin, onReturn, computerAction, computerError, computerNeedsRefresh, startComputer, stopComputer, refreshComputer, directAgents, canCreateAgent, openAgent }: {
  workspace: WorkspaceSummary | null; snapshot: Snapshot | null; computer: Computer | null; providers: Provider[];
  open: boolean; connected: boolean; busy: boolean; inspect: (area: Area) => void;
  askTwin: (text: string, target?: TwinTarget) => void;
  onReturn: () => void;
  computerAction: "starting" | "stopping" | null; computerError: string; computerNeedsRefresh: boolean;
  startComputer: () => void; stopComputer: () => void; refreshComputer: () => void;
  directAgents: Agent[]; canCreateAgent: boolean; openAgent: (agent: Agent) => void;
}) {
  const disabled = !connected || busy;
  const active = snapshot?.tasks.filter((task) => ["queued", "running", "awaiting_approval"].includes(task.state)) ?? [];
  const approvals = snapshot?.approvals.filter((item) => item.state === "pending" && !item.consumedBy) ?? [];
  return <aside id="workspace-context" className={`workspace-context${open ? " is-open" : ""}`} aria-label="Workspace status" tabIndex={-1}>
    <div className="context-heading"><span className="eyebrow">Workspace context</span><Icon name="shield" size={17} /><button className="icon-button context-return" aria-label="Return to Twin conversation" onClick={onReturn}><Icon name="close" size={18} /></button></div>
    {!workspace ? <div className="concierge-context"><span className="surface-icon"><Icon name="work" size={25} /></span><h2>A place for every business</h2><p>Tell the concierge your goal. It drafts a workspace, a dedicated Twin, a lead agent, and starter work for you to approve.</p><ol><li>Describe what you want to run.</li><li>Review the Twin's complete proposal.</li><li>Create your independent workspace.</li></ol><p className="inline-note">No blank setup forms. Nothing is created just by sending a message.</p></div> : <>
      <AgentComputer workspace={workspace} computer={computer} snapshot={snapshot} connected={connected} busy={busy}
        operation={computerAction} error={computerError} needsRefresh={computerNeedsRefresh}
        start={startComputer} stop={stopComputer} refresh={refreshComputer} askTwin={askTwin} />
      {approvals.length > 0 && <section className="context-section approval-context"><div className="row between"><h2>Needs your decision</h2><Badge tone="attention">{approvals.length}</Badge></div><p className="context-detail">Your Twin can advise. Approval and denial are always your explicit choice.</p><button className="button secondary" disabled={disabled} onClick={() => askTwin(`Review pending approval ${approvals[0]!.id} and recommend whether to approve or deny it, with a reason.`, "approval")}>Ask Twin for a recommendation</button><button className="text-button" onClick={() => inspect("work")}>Inspect approvals</button></section>}
      <section className="context-section" aria-labelledby="routines-title"><div className="row between"><h2 id="routines-title">Routines</h2><button className="icon-button" disabled={disabled} aria-label="New routine" onClick={() => askTwin("Create a routine that ", "automation")}><Icon name="plus" size={16} /></button></div>
        {!snapshot?.automations.length ? <p className="context-detail">Describe a repeatable outcome. Your Twin will draft the schedule.</p> :
          <ul className="context-list">{snapshot.automations.slice(0, 4).map((routine) => <li key={routine.id}><button onClick={() => inspect("automations")}><Icon name="clock" size={17} /><span><strong>{routine.name}</strong><small>{describeCadence(routine)} · {routine.enabled ? "Enabled" : "Draft"}</small></span></button></li>)}</ul>}
        <button className="text-button" onClick={() => inspect("automations")}>Inspect routines<Icon name="arrow" size={15} /></button>
      </section>
      <section className="context-section" aria-labelledby="agents-title"><div className="row between"><h2 id="agents-title">Child agents</h2><button className="icon-button" aria-label="New agent" disabled={disabled || !canCreateAgent} onClick={() => askTwin("Create an agent responsible for ", "agent")}><Icon name="plus" size={16} /></button></div>
        {!directAgents.length ? <p className="context-detail">Your Twin will help define the right responsibilities. Each agent receives its own child workspace.</p> :
          <ul className="context-list">{directAgents.slice(0, 5).map((agent) => <li key={agent.id}><button aria-label={`Open ${agent.name}'s workspace`} disabled={!connected}
            onClick={() => openAgent(agent)}><Avatar name={agent.name} small /><span><strong>{agent.name}</strong><small>{snapshot ? agentAvailability(agent, providers, snapshot) : "Not loaded"} · Child workspace</small></span></button></li>)}</ul>}
        <button className="text-button" onClick={() => inspect("agents")}>Inspect agents<Icon name="arrow" size={15} /></button>
      </section>
      <section className="context-section" aria-labelledby="tasks-title"><div className="row between"><h2 id="tasks-title">Active tasks</h2><button className="icon-button" aria-label="New task" disabled={disabled} onClick={() => askTwin("Create a task to ", "task")}><Icon name="plus" size={16} /></button></div>
        {!active.length ? <p className="context-detail">No active tasks reported. Tell your Twin what should happen next.</p> :
          <ul className="context-list">{active.slice(0, 4).map((task) => <li key={task.id}><button onClick={() => inspect("work")}><Icon name="work" size={17} /><span><strong>{task.title}</strong><small>{task.state.replaceAll("_", " ")}</small></span></button></li>)}</ul>}
        <button className="text-button" onClick={() => inspect("work")}>Inspect tasks & evidence<Icon name="arrow" size={15} /></button>
      </section>
      <button className="button secondary context-settings" onClick={() => inspect("settings")}><Icon name="settings" size={16} />Workspace settings</button>
    </>}
    <p className="context-footer">Local frame integrity is not factual accuracy, authorship, or external trust.</p>
  </aside>;
}
