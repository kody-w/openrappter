import { useState } from "react";
import { Avatar, Badge, Empty, Icon } from "./components";
import type { Agent, Provider, Snapshot } from "./model";

export function agentAvailability(agent: Agent, providers: Provider[], snapshot: Snapshot): string {
  if (!agent.enabled) return "Paused";
  if (snapshot.runs.some((run) => run.agentId === agent.id && ["running", "awaiting_approval"].includes(run.state))) return "Working";
  const provider = providers.find((item) => item.id === agent.providerId);
  if (!provider?.configured || !provider.models.includes(agent.model)) return "Needs provider";
  return "Configured";
}
export function Agents({ snapshot, providers, edit, create, open, connected }: {
  snapshot: Snapshot; providers: Provider[]; edit: (agent: Agent) => void; create: () => void; open: (agent: Agent) => void; connected: boolean;
}) {
  const [query, setQuery] = useState("");
  const agents = snapshot.agents.filter((agent) => `${agent.name} ${agent.role}`.toLowerCase().includes(query.toLowerCase()));
  return <section className="workspace-panel">
    <div className="section-header"><div><h2>Your team of agents</h2><p className="muted">Defined responsibilities. Explicit access. Accountable work.</p></div><Badge>{snapshot.agents.length} agents</Badge></div>
    <div className="list-toolbar"><div className="search-field"><Icon name="search" size={18} /><label className="sr-only" htmlFor="agent-search">Search agents</label><input id="agent-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by name or role" /></div></div>
    {!agents.length ? <Empty icon="agents" title={snapshot.agents.length ? "No matching agents" : "Build a team with clear responsibilities"} action={!snapshot.agents.length && <button className="button primary" onClick={create} disabled={!connected}><Icon name="plus" size={16} />Create your first agent</button>}>
      {snapshot.agents.length ? "Try another name or role." : "Describe an agent or paste its complete instructions. The Twin prepares every field for review."}
    </Empty> : <div className="agent-grid">{agents.map((agent) => <article key={agent.id} className="agent-card">
      <div className="row between"><Avatar name={agent.name} /><Badge tone={agentAvailability(agent, providers, snapshot) === "Working" ? "positive" : "neutral"}>{agentAvailability(agent, providers, snapshot)}</Badge></div>
      <h3>{agent.name}</h3><p className="muted">{agent.role || "No role specified"}</p><p className="clamp agent-instructions">{agent.instructions || "No instructions configured."}</p>
      <p className="mono small-text" title="This agent's independently minted workspace">{agent.workspaceId}</p>
      <dl className="metadata compact"><div><dt>Model</dt><dd>{agent.model || "Not connected"}</dd></div><div><dt>Computer</dt><dd>{agent.computerPolicy === "none" ? "No access" : agent.computerPolicy === "read-only" ? "Read-only" : "Controlled access"}</dd></div><div><dt>Approval</dt><dd>{agent.approvalPolicy === "always" ? "Always required" : "Sensitive actions"}</dd></div></dl>
      <button className="button primary" disabled={!connected} onClick={() => open(agent)}>Open agent workspace<Icon name="arrow" size={16} /></button>
      <button className="text-button" disabled={!connected || Boolean(agent.retiredAt)} onClick={() => edit(agent)}>Review agent definition</button>
    </article>)}</div>}
  </section>;
}
