import { Badge, Icon } from "./components";
import type { Computer, Snapshot, WorkspaceSummary } from "./model";
import type { Perform } from "./useWorkspace";

export function ComputerPanel({ workspace, snapshot, computer, connected, busy, starting, perform, discuss }: {
  workspace: WorkspaceSummary | null; snapshot: Snapshot | null; computer: Computer | null;
  connected: boolean; busy: boolean; starting: boolean; perform: Perform; discuss: () => void;
}) {
  const scoped = workspace !== null && computer?.workspace?.id === workspace.id;
  const machine = scoped ? computer : null;
  const state = machine?.state ?? "unavailable";
  const lease = machine?.lease;
  const held = lease?.state === "held";
  const blocked = !connected || !scoped || busy || !machine?.capabilities.control
    || !["stopped", "running"].includes(state) || lease?.state === "other-workspace" || held;
  const agent = snapshot?.agents.find((item) => item.id === lease?.agentId);
  return <aside className="computer-panel" aria-label="Agent computer panel" tabIndex={0} data-workspace-id={workspace?.id ?? "concierge"}>
    <header><p className="eyebrow">One shared Omarchy VM</p><h2><Icon name="computer" />Agent computer</h2>
      <p>{workspace ? `Scoped to ${workspace.name}` : "Choose a business workspace to enable its computer."}</p></header>
    <button className="button primary start-agent-computer" disabled={blocked}
      onClick={() => { void perform("computer.start", {}, "The broker completed this workspace's computer start request."); }}>
      <Icon name={starting ? "clock" : "computer"} />{starting ? "Starting agent computer…" : "Start agent computer"}
    </button>
    <div className="row between"><span>Service state</span><Badge tone={state === "unresolved" ? "attention" : "neutral"}>{state.charAt(0).toUpperCase() + state.slice(1)}</Badge></div>
    {starting && <p role="status">Start requested. Waiting for the broker’s verified response.</p>}
    <p className="small-text">{machine?.detail ?? "No verified computer status is available for this workspace."}</p>
    <section className="agent-screen" aria-label="Agent screen availability">
      <Icon name="computer" size={42} /><h3>{machine?.display?.state === "available" ? "Display reported available" : "Screen unavailable"}</h3>
      <p>{machine?.display?.detail ?? "No verified display stream has been reported. A running VM is not a live-screen claim."}</p>
    </section>
    <dl className="metadata compact">
      <div><dt>Workspace access</dt><dd>{machine?.workspace?.enabled ? "Enabled for fresh scoped tool leases" : "Not enabled"}</dd></div>
      <div><dt>Current lease</dt><dd>{held ? "Held by this workspace" : lease?.state === "other-workspace" ? "Busy in another workspace"
        : lease?.state === "unresolved" ? "Unresolved — recovery required" : lease ? "Idle — acquired for each action" : "Not reported"}</dd></div>
      <div><dt>Current agent</dt><dd>{held ? agent?.name ?? workspace?.twin.name ?? "Workspace Twin" : "No active agent lease"}</dd></div>
      {held && <div><dt>Lease reference</dt><dd className="mono">{lease.id}</dd></div>}
      <div><dt>Agent access ceiling</dt><dd>{workspace?.computerPolicy === "control" ? "Controlled guest tools"
        : workspace?.computerPolicy === "read-only" ? "Read-only guest tools" : "No computer tools"}</dd></div>
      <div><dt>Approval policy</dt><dd>{!workspace ? "No workspace selected" : workspace.approvalPolicy === "on-risk" ? "Sensitive actions require explicit approval" : "Always require approval"}</dd></div>
      <div><dt>Verification</dt><dd><Badge tone={machine?.verified ? "positive" : "neutral"}>{machine?.verified ? "Service evidence verified" : "Not verified"}</Badge></dd></div>
    </dl>
    <p className="inline-note">Starting enables this workspace, not unrestricted tools. Each action acquires its own broker lease; agent restrictions and exact approvals still apply. No host-shell fallback.</p>
    <button className="button secondary" disabled={!connected || !workspace || busy} onClick={discuss}>Discuss computer access</button>
    <button className="text-button" disabled={blocked || state !== "running"}
      onClick={() => { void perform("computer.stop", {}, "The shared computer stop response was verified."); }}>Stop shared computer</button>
    <p className="small-text muted">Stopping affects every workspace. Switching workspaces never transfers a capability or lease.</p>
  </aside>;
}
