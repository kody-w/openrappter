import { useEffect, useRef, useState } from "react";
import type { WorkClient } from "./client";
import { Agents, agentAvailability } from "./Agents";
import { Automations } from "./Automations";
import { Avatar, Badge, Empty, formatDate, Icon, Modal, type IconName } from "./components";
import { AgentForm, ApprovalForm, AutomationForm, TaskForm } from "./forms";
import type { Agent, Approval, Area, Artifact, Automation } from "./model";
import { Settings } from "./Settings";
import { useWorkspace } from "./useWorkspace";
import { Work } from "./Work";

const areas: { id: Area; label: string; icon: IconName; description: string }[] = [
  { id: "work", label: "Work", icon: "work", description: "From clear intent to accountable outcomes." },
  { id: "agents", label: "Agents", icon: "agents", description: "A persistent team, configured for your business." },
  { id: "automations", label: "Automations", icon: "automations", description: "Reliable routines with a record of every run." },
  { id: "settings", label: "Settings", icon: "settings", description: "Your workspace, connections, and operating policies." },
];
type Editor = { kind: "task" } | { kind: "agent"; agent?: Agent } | { kind: "automation"; automation?: Automation } | { kind: "approval"; approval: Approval };
const currentArea = (): Area => areas.find((area) => `#${area.id}` === window.location.hash)?.id ?? "work";
export function App({ client }: { client: WorkClient }) {
  const state = useWorkspace(client);
  const { snapshot, status, providers, computer, diagnostics, loading, connected, error, notice, busy, refresh, perform } = state;
  const [area, setArea] = useState<Area>(currentArea);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [artifact, setArtifact] = useState<{ item: Artifact; content: string | null; error: string } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const previousCounts = useRef<{ workspace: string; approvals: number; completed: number } | null>(null);
  const active = areas.find((item) => item.id === area)!;
  useEffect(() => {
    const route = () => { setArea(currentArea()); setMenuOpen(false); };
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, []);
  useEffect(() => { heading.current?.focus(); }, [area]);
  useEffect(() => {
    if (!snapshot) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const override = new URLSearchParams(window.location.search).get("scoutTheme");
      const theme = override === "light" || override === "dark" ? override
        : snapshot.settings.appearance.theme === "system" ? media.matches ? "dark" : "light" : snapshot.settings.appearance.theme;
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.density = snapshot.settings.appearance.density;
    };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [snapshot?.settings.appearance.theme, snapshot?.settings.appearance.density]);
  useEffect(() => {
    if (!snapshot) return;
    const approvals = snapshot.approvals.filter((item) => item.state === "pending").length;
    const completed = snapshot.runs.filter((item) => item.state === "completed").length;
    const previous = previousCounts.current;
    if (previous?.workspace === snapshot.workspaceId) {
      if (snapshot.settings.notifications.approvals && approvals > previous.approvals) setAnnouncement("New actions are waiting for your approval in Work.");
      else if (snapshot.settings.notifications.completedRuns && completed > previous.completed) setAnnouncement("A runtime has reported a completed run. Review its evidence in Work.");
    }
    previousCounts.current = { workspace: snapshot.workspaceId, approvals, completed };
  }, [snapshot]);
  const navigate = (next: Area) => {
    window.location.hash = next;
    setArea(next); setMenuOpen(false);
  };
  const openArtifact = async (item: Artifact) => {
    setArtifact({ item, content: null, error: "" }); setArtifactLoading(true);
    try {
      const result = await client.call("artifacts.read", { id: item.id });
      if (result.artifact.id !== item.id || result.artifact.sha256 !== item.sha256) throw new Error("Artifact identity changed. Refresh the workspace before opening it.");
      setArtifact({ item: result.artifact, content: result.content, error: "" });
    } catch (error) { setArtifact({ item, content: null, error: error instanceof Error ? error.message : "Artifact could not be loaded." }); }
    finally { setArtifactLoading(false); }
  };
  const commonForm = { perform, busy, error, onClose: () => setEditor(null) };
  return <div className="app-shell">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to workspace</a>
    <div className="mobile-bar"><span className="brand"><span className="brand-mark">RW</span>RAPP Work</span><button className="icon-button" aria-label="Toggle navigation" aria-expanded={menuOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" /></button></div>
    <aside className={`sidebar${menuOpen ? " is-open" : ""}`} id="app-sidebar" aria-label="Workspace sidebar">
      <div className="brand desktop-brand"><span className="brand-mark" aria-hidden="true">RW</span><div>RAPP Work<span className="brand-tagline">Your local workspace</span></div></div>
      <div className="workspace-switch"><span className="workspace-avatar">{(snapshot?.settings.workspaceName ?? "Workspace").slice(0, 1).toUpperCase()}</span><div className="min-zero"><strong>{snapshot?.settings.workspaceName ?? "Workspace"}</strong><span>Private · on this Mac</span></div></div>
      <nav aria-label="Primary navigation"><ul>{areas.map((item) => <li key={item.id}>
        <a href={`#${item.id}`} aria-label={item.label} aria-current={area === item.id ? "page" : undefined} onClick={(event) => { event.preventDefault(); navigate(item.id); }}>
          <Icon name={item.icon} /><span>{item.label}</span>
          {item.id === "work" && !!snapshot?.approvals.filter((approval) => approval.state === "pending").length &&
            <span className="nav-count" aria-label="pending approvals">{snapshot.approvals.filter((approval) => approval.state === "pending").length}</span>}
        </a>
      </li>)}</ul></nav>
      <section className="roster" aria-labelledby="roster-title">
        <div className="roster-heading"><h2 id="roster-title">Your agents</h2><button className="icon-button" aria-label="Add an agent" disabled={!connected} onClick={() => setEditor({ kind: "agent" })}><Icon name="plus" size={16} /></button></div>
        {!snapshot?.agents.length ? <p className="roster-empty">Your configured agents will stay here as you move between areas.</p> :
          <ul>{snapshot.agents.map((agent) => <li key={agent.id}><button className="roster-agent" aria-label={`Configure ${agent.name}`} disabled={!connected} onClick={() => setEditor({ kind: "agent", agent })}>
            <Avatar name={agent.name} small /><span className="min-zero"><strong>{agent.name}</strong><small>{agentAvailability(agent, providers, snapshot)}</small></span>
          </button></li>)}</ul>}
      </section>
      <div className="sidebar-bottom"><div className="connection"><span className={`connection-dot${connected ? " connected" : ""}`} /><strong>{connected ? "Host connected" : loading ? "Connecting to host" : "Host not connected"}</strong></div><p>{connected ? "Execution readiness is reported separately." : "No execution is available while disconnected."}</p><div className="sidebar-identity"><span className="owner-mark">L</span><span>Local workspace owner</span><Icon name="shield" size={16} /></div></div>
    </aside>
    <main id="main-content" className="main" tabIndex={-1}>
      <header className="page-header">
        <div><p className="breadcrumb">{snapshot?.settings.workspaceName ?? "Workspace"}<span>/</span>{active.label}</p><h1 ref={heading} tabIndex={-1}>{active.label}</h1><p className="page-description">{active.description}</p></div>
        <div className="header-actions"><button className="button secondary" aria-label="Refresh workspace" onClick={() => { void refresh(); }} disabled={loading || busy}><Icon name="refresh" size={16} /><span className="refresh-label">Refresh</span></button>
          {area !== "settings" && <button className="button primary" disabled={!connected || busy || (area === "automations" && !snapshot?.agents.length)} onClick={() => setEditor({ kind: area === "work" ? "task" : area === "agents" ? "agent" : "automation" })}>
            <Icon name="plus" size={16} />{area === "work" ? "New task" : area === "agents" ? "New agent" : "New schedule"}
          </button>}
        </div>
      </header>
      <div className="content">
        {!editor && error && <div className="message error-message" role="alert"><Icon name="shield" size={18} /><span>{error}</span><button className="text-button" onClick={() => { void refresh(); }}>Retry</button></div>}
        {notice && !editor && <div className="message" role="status"><Icon name="check" size={18} /><span>{notice}</span></div>}
        {announcement && <div className="message" role="status"><Icon name="clock" size={18} /><span>{announcement}</span><button className="icon-button" aria-label="Dismiss work notification" onClick={() => setAnnouncement("")}><Icon name="close" size={16} /></button></div>}
        {loading && <div className="workspace-panel loading-panel" role="status" aria-label="Loading workspace"><span className="loading-line" /><span className="loading-line short" /><p>Connecting to your local workspace…</p></div>}
        {!loading && !snapshot && <div className="workspace-panel"><Empty icon="work" title="Connect your local workspace" action={<button className="button primary" onClick={() => { void refresh(); }}>Try connecting again</button>}>Open RAPP Work desktop to use its owned local host. No sample agents, tasks, or computer results are loaded.</Empty></div>}
        {snapshot && <div aria-busy={busy}>
          {!connected && <p className="inline-note">Showing the last loaded workspace. Actions are disabled until the host reconnects.</p>}
          {area === "work" && <Work snapshot={snapshot} status={status} computer={computer} connected={connected} busy={busy} perform={perform} newTask={() => setEditor({ kind: "task" })} review={(approval) => setEditor({ kind: "approval", approval })} openArtifact={(item) => { void openArtifact(item); }} />}
          {area === "agents" && <Agents snapshot={snapshot} providers={providers} connected={connected} create={() => setEditor({ kind: "agent" })} edit={(agent) => setEditor({ kind: "agent", agent })} />}
          {area === "automations" && <Automations snapshot={snapshot} connected={connected} create={() => setEditor({ kind: "automation" })} edit={(automation) => setEditor({ kind: "automation", automation })} />}
          {area === "settings" && <Settings snapshot={snapshot} status={status} providers={providers} computer={computer} diagnostics={diagnostics} connected={connected} busy={busy} perform={perform} refresh={refresh} />}
        </div>}
        <footer className="workspace-footer"><span>RAPP Work</span><span>Local by design. Evidence by default.</span></footer>
      </div>
    </main>
    {editor && snapshot && <Modal title={editor.kind === "task" ? "Create a task" : editor.kind === "agent" ? editor.agent ? "Configure agent" : "Create an agent" : editor.kind === "automation" ? editor.automation ? "Edit schedule" : "Create a schedule" : "Review approval"} onClose={() => setEditor(null)} busy={busy}>
      {editor.kind === "task" && <TaskForm {...commonForm} agents={snapshot.agents} settings={snapshot.settings} />}
      {editor.kind === "agent" && <AgentForm {...commonForm} agent={editor.agent} providers={providers} />}
      {editor.kind === "automation" && <AutomationForm {...commonForm} automation={editor.automation} agents={snapshot.agents} />}
      {editor.kind === "approval" && <ApprovalForm {...commonForm} approval={editor.approval} />}
    </Modal>}
    {artifact && <Modal title={artifact.item.name} onClose={() => setArtifact(null)} busy={artifactLoading}>
      <div className="form-body"><div className="row between"><Badge>{artifact.item.evidence ? "Service-reported evidence" : "Artifact"}</Badge><span className="muted small-text">{formatDate(artifact.item.createdAt)}</span></div>
        <p className="small-text mono hash">SHA-256 · {artifact.item.sha256}</p>
        {artifactLoading && <p role="status">Loading artifact…</p>}
        {artifact.error && <p className="form-error" role="alert">{artifact.error}</p>}
        {artifact.content !== null && <pre className="artifact-content" tabIndex={0} aria-label="Artifact content">{artifact.content}</pre>}
      </div>
      <footer className="form-footer"><button className="button secondary" disabled={artifactLoading} onClick={() => setArtifact(null)}>Close artifact</button></footer>
    </Modal>}
  </div>;
}
