import { Badge, Icon, StatusBadge } from "./components";
import type { Computer, Snapshot, WorkspaceSummary } from "./model";

export function AgentComputer({ workspace, computer, snapshot, connected, busy, operation, error, needsRefresh, start, stop, refresh, askTwin }: {
  workspace: WorkspaceSummary; computer: Computer | null; snapshot: Snapshot | null;
  connected: boolean; busy: boolean; operation: "starting" | "stopping" | null;
  error: string; needsRefresh: boolean; start: () => void; stop: () => void; refresh: () => void;
  askTwin: (message: string, target?: "settings") => void;
}) {
  const scoped = computer?.workspace?.id === workspace.id;
  const report = scoped ? computer : null;
  const enabled = Boolean(report?.workspace?.enabled);
  const lease = report?.lease;
  const ownLease = lease?.state === "held" && lease.workspaceId === workspace.id && scoped;
  const otherLease = lease?.state === "other-workspace" || lease?.state === "held" && !ownLease;
  const unresolved = needsRefresh || report?.state === "unresolved" || lease?.state === "unresolved";
  const locked = !connected || !scoped || workspace.status !== "active" || busy || unresolved || Boolean(operation)
    || otherLease || ownLease || report?.state === "starting" || Boolean(lease?.operation);
  const policy = report?.workspace?.computerPolicy ?? workspace.computerPolicy;
  const approval = report?.workspace?.approvalPolicy ?? workspace.approvalPolicy;
  const agent = ownLease ? snapshot?.agents.find((item) => item.id === lease.agentId)?.name
    ?? (lease.agentId === workspace.catalogScope.agentId ? workspace.twin.name : lease.agentId) : null;
  return <section className="context-section agent-computer" aria-labelledby="computer-title">
    <div className="row between"><h2 id="computer-title">Agent computer</h2><StatusBadge state={unresolved ? "unresolved" : operation === "starting" ? "starting" : report?.state ?? "unavailable"} /></div>
    <p className="shared-computer-label">One shared Omarchy VM · managed by ComputerBroker</p>
    <button className="button primary start-agent-computer" aria-label="Start agent computer" disabled={locked || enabled && report?.state === "running"} onClick={start} aria-busy={operation === "starting"}>
      <Icon name="computer" size={18} />{operation === "starting" ? "Starting agent computer…" : "Start agent computer"}
    </button>
    <p className="context-detail">{!scoped ? "Workspace-bound broker status is unavailable. No computer capability or lease is assumed." : operation === "starting"
      ? "Requesting provisioning/start and a lease for this workspace. Running is not yet confirmed."
      : report?.detail ?? "The broker has not reported computer state for this workspace."}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {unresolved && <p className="inline-note">Computer work is unresolved. Do not replay it or reuse a lease. Refresh the broker and review its evidence before recovery.</p>}
    <div className="local-screen" aria-label="Computer screen status"><Icon name="computer" size={37} />
      <strong>{report?.display?.state === "available" ? "Display reported available" : "Display unavailable"}</strong>
      <span>{report?.display?.detail ?? "No verified screen/display stream has been reported. Guest tools do not imply a live screen."}</span>
    </div>
    <dl className="computer-scope">
      <div><dt>Workspace access</dt><dd>{enabled && report?.state === "running" ? "Enabled for this workspace" : "Not enabled for this workspace"}</dd></div>
      <div><dt>Agent tools</dt><dd>{policy === "none" ? "No computer tools allowed" : policy === "read-only" ? "Read-only guest tools" : "Guest control, subject to approval"}</dd></div>
      <div><dt>Approval policy</dt><dd>{approval === "always" ? "Always require human approval" : "Human approval for sensitive actions"}</dd></div>
      <div><dt>Current lease</dt><dd>{ownLease ? <span className="mono">{lease.id}</span>
        : otherLease ? "Reserved elsewhere — no lease shared here" : lease?.state === "idle" ? "Idle — acquire afresh for each action" : "Not reported"}</dd></div>
      <div><dt>Lease agent</dt><dd>{agent ?? "No current workspace lease holder"}</dd></div>
      {ownLease && <div><dt>Lease workspace</dt><dd className="mono">{lease.workspaceId}</dd></div>}
    </dl>
    <div className="row wrap"><Badge tone={report?.verified ? "positive" : "neutral"}>{report?.verified ? "Local broker integrity verified" : "Not verified"}</Badge><span className="small-text muted">{report?.evidenceIds.length ?? 0} evidence references</span></div>
    <p className="context-detail">Start enables only this workspace. Agent tools acquire their own scoped leases; no per-agent VM or host-shell fallback is created.</p>
    <div className="computer-actions">
      <button className="button secondary small-button" disabled={!connected || busy} onClick={refresh}>Refresh broker state</button>
      <button className="text-button" disabled={locked || !enabled || report?.state !== "running"} onClick={stop}>{operation === "stopping" ? "Stopping…" : "Stop shared computer"}</button>
    </div>
    <button className="text-button" disabled={!connected || busy} onClick={() => askTwin("Review this workspace's agent computer policy and propose the least access needed for its work.", "settings")}>Review access with Twin<Icon name="arrow" size={15} /></button>
  </section>;
}
