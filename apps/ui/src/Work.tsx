import { useState } from "react";
import { Avatar, Badge, Empty, formatDate, Icon, Modal, StatusBadge, TabPanel, Tabs } from "./components";
import type { Approval, Artifact, Computer, Run, Snapshot, Status } from "./model";
import type { Perform } from "./useWorkspace";

export type WorkTab = "tasks" | "runs" | "approvals" | "artifacts" | "computer";
interface Props {
  snapshot: Snapshot; status: Status | null; computer: Computer | null;
  connected: boolean; busy: boolean; perform: Perform; newTask: () => void;
  review: (approval: Approval) => void; openArtifact: (artifact: Artifact) => void;
}
export function Work({ snapshot, status, computer, connected, busy, perform, newTask, review, openArtifact }: Props) {
  const [tab, setTab] = useState<WorkTab>("tasks");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cancelRun, setCancelRun] = useState<Run | null>(null);
  const pending = snapshot.approvals.filter((approval) => approval.state === "pending");
  const active = snapshot.tasks.filter((task) => ["queued", "running", "awaiting_approval"].includes(task.state));
  const tasks = snapshot.tasks.filter((task) =>
    (filter === "all" || task.state === filter) &&
    `${task.title} ${task.instructions}`.toLowerCase().includes(query.toLowerCase()));
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0];
  const canExecute = connected && status?.checks.runtime.state === "ready";
  return <>
    <section className="metrics" aria-label="Work overview">
      <div><span className="metric-icon"><Icon name="work" /></span><dl><dt>Active work</dt><dd>{active.length}<span>tasks</span></dd></dl></div>
      <button onClick={() => setTab("approvals")}><span className="metric-icon"><Icon name="shield" /></span><dl><dt>Needs your approval</dt><dd>{pending.length}<span>actions</span></dd></dl><Icon name="arrow" /></button>
      <div><span className="metric-icon"><Icon name="check" /></span><dl><dt>Completed</dt><dd>{snapshot.tasks.filter((task) => task.state === "completed").length}<span>tasks</span></dd></dl></div>
    </section>
    <div className="workspace-panel">
      <Tabs label="Work views" selected={tab} onChange={setTab} tabs={[
        { id: "tasks", label: "Tasks", count: snapshot.tasks.length }, { id: "runs", label: "Runs" },
        { id: "approvals", label: "Approvals", count: pending.length },
        { id: "artifacts", label: "Artifacts & evidence" }, { id: "computer", label: "Local computer" },
      ]} />
      <TabPanel id={tab}>
        {tab === "tasks" && <>
          <div className="list-toolbar">
            <div className="search-field"><Icon name="search" size={18} /><label className="sr-only" htmlFor="task-search">Search tasks</label><input id="task-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tasks" /></div>
            <label className="filter-label">Status<select aria-label="Filter task status" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">All statuses</option><option value="queued">Queued</option><option value="running">Running</option><option value="awaiting_approval">Needs approval</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label>
          </div>
          {!tasks.length ? <Empty icon="work" title={snapshot.tasks.length ? "No matching tasks" : "Make room for meaningful work"} action={!snapshot.tasks.length && <button className="button primary" onClick={newTask} disabled={!connected}><Icon name="plus" size={16} />Create your first task</button>}>
            {snapshot.tasks.length ? "Try a different search or status filter." : "Define an outcome, assign an agent, and keep decisions and evidence together."}
          </Empty> : <div className="work-split">
            <ul className="task-list" aria-label="Tasks">{tasks.map((task) => {
              const agent = snapshot.agents.find((agent) => agent.id === task.agentId);
              return <li key={task.id}><button className={`task-item${selected?.id === task.id ? " selected" : ""}`} onClick={() => setSelectedId(task.id)} aria-pressed={selected?.id === task.id}>
                <div className="row between"><span className="task-title">{task.title}</span>{task.priority === "high" && <Badge tone="attention">High</Badge>}</div>
                <p className="clamp">{task.instructions}</p>
                <div className="row between"><span className="agent-label">{agent && <Avatar name={agent.name} small />}{agent?.name ?? "Unassigned"}</span><StatusBadge state={task.state} /></div>
              </button></li>;
            })}</ul>
            {selected && <section className="task-detail" aria-label="Selected task">
              <div className="row between"><span className="eyebrow">Task detail</span><StatusBadge state={selected.state} /></div>
              <h2>{selected.title}</h2><p className="preserve">{selected.instructions}</p>
              <dl className="metadata">
                <div><dt>Assigned to</dt><dd>{snapshot.agents.find((agent) => agent.id === selected.agentId)?.name ?? "Unassigned"}</dd></div>
                <div><dt>Created</dt><dd>{formatDate(selected.createdAt)}</dd></div>
                <div><dt>Priority</dt><dd>{selected.priority === "high" ? "High" : "Normal"}</dd></div>
              </dl>
              {["queued", "failed", "cancelled"].includes(selected.state) && <div className="action-block">
                <form className="assignment-form" onSubmit={(event) => {
                  event.preventDefault();
                  const agentId = String(new FormData(event.currentTarget).get("agentId"));
                  void perform("work.assignTask", { id: selected.id, agentId }, "Task assignment saved.");
                }}>
                  <label htmlFor="task-assignee" className="sr-only">Assign this task to</label>
                  <select id="task-assignee" name="agentId" key={`${selected.id}:${selected.agentId}`} defaultValue={selected.agentId ?? ""} required disabled={!connected || busy}>
                    <option value="" disabled>Select an agent</option>{snapshot.agents.filter((agent) => agent.enabled).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                  <button type="submit" className="button secondary" disabled={!connected || busy || !snapshot.agents.some((agent) => agent.enabled)}>Assign</button>
                </form>
                <button className="button primary" disabled={!canExecute || busy || !selected.agentId} onClick={() => { void perform("runs.start", { id: selected.id }, "Run accepted by the connected runtime."); }}><Icon name="arrow" size={16} />Start task</button>
                {!canExecute && <p className="field-help">A ready runtime and configured provider are required to start work.</p>}
                {!selected.agentId && <p className="field-help">This task has no assigned agent.</p>}
              </div>}
              <h3 className="section-label">Run history</h3>
              {snapshot.runs.filter((run) => run.taskId === selected.id).length === 0 ? <p className="muted small-text">No runtime has accepted this task yet.</p> :
                <ul className="timeline">{snapshot.runs.filter((run) => run.taskId === selected.id).map((run) => <li key={run.id}>
                  <div className="row between"><StatusBadge state={run.state} /><time dateTime={run.startedAt}>{formatDate(run.startedAt)}</time></div><p>{run.summary}</p>
                  <div className="row wrap"><StatusBadge state={run.verification} /><span className="muted small-text">{run.evidenceIds.length} evidence references</span></div>
                </li>)}</ul>}
              <h3 className="section-label">Related evidence</h3>
              {!snapshot.artifacts.some((artifact) => artifact.taskId === selected.id) ? <p className="muted small-text">No artifacts or evidence have been reported.</p> : <div className="stack">
                {snapshot.artifacts.filter((artifact) => artifact.taskId === selected.id).map((artifact) => <button key={artifact.id} className="text-button" onClick={() => openArtifact(artifact)} disabled={!connected}><Icon name="document" size={16} />{artifact.name}</button>)}
              </div>}
            </section>}
          </div>}
        </>}
        {tab === "runs" && (!snapshot.runs.length ? <Empty icon="clock" title="Every run, accounted for">Once a runtime accepts a task, its progress, decisions, and verification will appear here.</Empty> :
          <div className="table-scroll"><table><caption className="sr-only">Task runs and reported verification</caption><thead><tr><th scope="col">Task / run</th><th scope="col">Status</th><th scope="col">Verification</th><th scope="col">Started</th><th scope="col">Action</th></tr></thead><tbody>{snapshot.runs.map((run) => <tr key={run.id}>
            <td><button className="text-button strong" onClick={() => { setSelectedId(run.taskId); setTab("tasks"); }}>{snapshot.tasks.find((task) => task.id === run.taskId)?.title ?? "Task"}</button><span className="subline mono">{run.id.slice(0, 12)}</span></td>
            <td><StatusBadge state={run.state} /></td><td><StatusBadge state={run.verification} /><span className="subline">{run.evidenceIds.length} evidence references</span></td><td>{formatDate(run.startedAt)}</td>
            <td>{["running", "awaiting_approval"].includes(run.state) ? <button className="button secondary small-button" onClick={() => setCancelRun(run)} disabled={!connected || busy}>Cancel run</button> : <span className="muted">—</span>}</td>
          </tr>)}</tbody></table></div>)}
        {tab === "approvals" && (!snapshot.approvals.length ? <Empty icon="shield" title="Decisions stay in your hands">Actions that require review will wait here. Approval applies only to the exact action and run shown.</Empty> :
          <div className="card-list">{snapshot.approvals.map((approval) => <article className="approval-card" key={approval.id}>
            <div className="row between wrap"><div className="row"><span className="surface-icon"><Icon name="shield" /></span><div><h3>{approval.action}</h3><p className="muted small-text">{snapshot.tasks.find((task) => task.id === approval.taskId)?.title ?? "Task"} · {formatDate(approval.createdAt)}</p></div></div><StatusBadge state={approval.state} /></div>
            <p>{approval.reason}</p><div className="row between wrap"><Badge tone={approval.risk === "high" ? "attention" : "neutral"}>{approval.risk} risk</Badge>
              {approval.state === "pending" ? <button className="button secondary" disabled={!connected || busy} onClick={() => review(approval)}>Review action<Icon name="arrow" size={16} /></button> :
                <p className="muted small-text">{approval.decisionReason}</p>}</div>
          </article>)}</div>)}
        {tab === "artifacts" && (!snapshot.artifacts.length ? <Empty icon="document" title="Outputs with a paper trail">Documents and execution evidence appear only when reported by the connected services. Nothing is marked verified by assumption.</Empty> :
          <div className="artifact-grid">{snapshot.artifacts.map((artifact) => <article className="artifact-card" key={artifact.id}>
            <div className="row between"><span className="surface-icon"><Icon name="document" size={24} /></span>{artifact.evidence && <Badge>Evidence</Badge>}</div>
            <h3>{artifact.name}</h3><p className="muted small-text">{snapshot.tasks.find((task) => task.id === artifact.taskId)?.title ?? "Task"}</p>
            <p className="small-text">{artifact.mediaType} · {new Intl.NumberFormat().format(artifact.bytes)} bytes</p><time dateTime={artifact.createdAt}>{formatDate(artifact.createdAt)}</time>
            <button className="button secondary" onClick={() => openArtifact(artifact)} disabled={!connected}>View artifact<Icon name="arrow" size={16} /></button>
          </article>)}</div>)}
        {tab === "computer" && <div className="computer-layout">
          <section className="computer-preview" aria-label="Local computer availability"><Icon name="computer" size={64} />
            <h2>{computer?.state === "running" ? "Computer service reports running" : "Your local computer workspace"}</h2>
            <p>{computer?.detail ?? "Computer status has not been reported by a connected service."}</p>
            <StatusBadge state={computer?.state ?? "unavailable"} />
          </section>
          <section className="computer-details"><h3>Access & verification</h3>
            <dl className="metadata">
              <div><dt>View capability</dt><dd>{computer?.capabilities.view ? "Reported available" : "Not available"}</dd></div>
              <div><dt>Control capability</dt><dd>{computer?.capabilities.control ? "Reported available" : "Not available"}</dd></div>
              <div><dt>Verification</dt><dd><StatusBadge state={computer?.verified ? "passed" : "not_checked"} /></dd></div>
              <div><dt>Verified at</dt><dd>{formatDate(computer?.verifiedAt ?? null)}</dd></div>
              <div><dt>Evidence references</dt><dd>{computer?.evidenceIds.length ?? 0}</dd></div>
            </dl>
            <p className="inline-note">A connected service must report real computer state and evidence. Agent access is governed by its configuration and approval policy.</p>
            <div className="row wrap">
              <button className="button primary" disabled={!connected || busy || computer?.state !== "stopped" || !computer.capabilities.control || status?.checks.computer.state !== "ready"}
                onClick={() => { void perform("computer.start", {}, "Computer start response received. Review the service-reported state."); }}>Start computer</button>
              <button className="button secondary" disabled={!connected || busy || computer?.state !== "running" || !computer.capabilities.control}
                onClick={() => { void perform("computer.stop", {}, "Computer stop response received."); }}>Stop computer</button>
            </div>
          </section>
        </div>}
      </TabPanel>
    </div>
    {cancelRun && <Modal title="Cancel this run?" onClose={() => setCancelRun(null)} busy={busy}>
      <div className="form-body"><p>The connected runtime will be asked to cancel this run. Existing artifacts and evidence will remain available.</p><p className="mono">{cancelRun.id}</p></div>
      <footer className="form-footer"><button className="button secondary" onClick={() => setCancelRun(null)} disabled={busy}>Keep running</button><button className="button danger" disabled={busy} onClick={() => {
        void perform("runs.cancel", { id: cancelRun.id }, "Cancellation confirmed by the runtime.").then((done) => { if (done) setCancelRun(null); });
      }}>{busy ? "Cancelling…" : "Cancel run"}</button></footer>
    </Modal>}
  </>;
}
