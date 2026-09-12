import { useEffect, useRef, useState } from "react";
import type { WorkClient } from "./client";
import { Agents, agentAvailability } from "./Agents";
import { Automations } from "./Automations";
import { Avatar, Empty, Icon, Modal, type IconName } from "./components";
import { ComputerPanel } from "./ComputerPanel";
import { ApprovalForm, ExistingReview, ProposalReview } from "./forms";
import type { Agent, Approval, Area, Artifact, Automation, TwinDraft, TwinMessageRequest } from "./model";
import { Settings } from "./Settings";
import { TwinConversation, type IntentSeed } from "./TwinConversation";
import { useWorkspace } from "./useWorkspace";
import { Work } from "./Work";

const areas: { id: Area; label: string; icon: IconName }[] = [
  { id: "work", label: "Work", icon: "work" }, { id: "agents", label: "Agents", icon: "agents" },
  { id: "automations", label: "Automations", icon: "automations" }, { id: "settings", label: "Settings", icon: "settings" },
];
type Editor =
  | { kind: "proposal"; workspaceId: string | null; proposal: TwinDraft }
  | { kind: "agent"; workspaceId: string; existing: Agent }
  | { kind: "automation"; workspaceId: string; existing: Automation }
  | { kind: "approval"; workspaceId: string; approval: Approval; recommendation?: string };
const currentArea = (): Area => areas.find((area) => `#${area.id}` === window.location.hash)?.id ?? "work";
export function App({ client }: { client: WorkClient }) {
  const state = useWorkspace(client);
  const { snapshot, workspace, selectedId, workspaces, conversation, status, providers, computer,
    diagnostics, loading, connected, error, notice, busy, refresh, perform } = state;
  const [area, setArea] = useState<Area>(currentArea);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [seed, setSeed] = useState<IntentSeed | null>(null);
  const [artifact, setArtifact] = useState<{ workspaceId: string; item: Artifact; content: string | null; error: string } | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const artifactRequest = useRef(0);
  const active = areas.find((item) => item.id === area)!;
  useEffect(() => {
    const route = () => { setArea(currentArea()); setMenuOpen(false); };
    window.addEventListener("hashchange", route);
    return () => window.removeEventListener("hashchange", route);
  }, []);
  useEffect(() => { heading.current?.focus(); }, [area]);
  useEffect(() => {
    setEditor(null); setArtifact(null); setArtifactLoading(false); artifactRequest.current++;
  }, [selectedId]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const override = new URLSearchParams(window.location.search).get("scoutTheme");
      const selected = snapshot?.settings.appearance.theme ?? "system";
      document.documentElement.dataset.theme = override === "light" || override === "dark" ? override
        : selected === "system" ? media.matches ? "dark" : "light" : selected;
      document.documentElement.dataset.density = snapshot?.settings.appearance.density ?? "comfortable";
    };
    apply(); media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [snapshot?.settings.appearance.theme, snapshot?.settings.appearance.density]);
  const navigate = (next: Area) => { window.location.hash = next; setArea(next); setMenuOpen(false); };
  const intent = (target: TwinMessageRequest["target"], message = "", id = selectedId) => {
    if (id !== selectedId) state.selectWorkspace(id);
    setEditor(null); setSeed((previous) => ({ id: (previous?.id ?? 0) + 1, workspaceId: id, target, message }));
  };
  const selectWorkspace = (id: string | null) => {
    const latest = conversation?.proposals.at(-1);
    const pendingDocument = selectedId === null && id !== null && latest?.kind === "clarification"
      && latest.missing.some((field) => /workspace/i.test(field))
      ? [...(conversation?.turns ?? [])].reverse().find((turn) => turn.role === "user" && /(?:^|\n)\s*#/.test(turn.content))?.content : undefined;
    state.selectWorkspace(id); setMenuOpen(false);
    if (pendingDocument) setSeed((previous) => ({ id: (previous?.id ?? 0) + 1, workspaceId: id, target: "agent", message: pendingDocument }));
  };
  const review = (proposal: TwinDraft) => {
    if (proposal.workspaceId !== selectedId) return;
    if (proposal.kind === "approval") {
      const approval = snapshot?.approvals.find((item) => item.id === proposal.draft.approvalId && item.operationHash === proposal.draft.operationHash);
      if (approval && selectedId) setEditor({ kind: "approval", workspaceId: selectedId, approval, recommendation: proposal.draft.reason });
    } else if (proposal.readyForReview) setEditor({ kind: "proposal", workspaceId: selectedId, proposal });
  };
  const openArtifact = async (item: Artifact) => {
    const workspaceId = selectedId;
    if (!workspaceId) return;
    const request = ++artifactRequest.current;
    setArtifact({ workspaceId, item, content: null, error: "" }); setArtifactLoading(true);
    try {
      const result = await client.call("artifacts.read", { workspaceId, id: item.id });
      if (!state.isCurrent(workspaceId) || request !== artifactRequest.current) return;
      if (result.artifact.id !== item.id || result.artifact.sha256 !== item.sha256) throw new Error("Artifact identity changed. Refresh before opening it.");
      setArtifact({ workspaceId, item: result.artifact, content: result.content, error: "" });
    } catch (error) {
      if (state.isCurrent(workspaceId) && request === artifactRequest.current) setArtifact({
        workspaceId, item, content: null, error: error instanceof Error ? error.message : "Artifact unavailable.",
      });
    } finally { if (state.isCurrent(workspaceId) && request === artifactRequest.current) setArtifactLoading(false); }
  };
  const selectedName = workspace?.name ?? workspaces.find((item) => item.id === selectedId)?.name ?? "Owner concierge";
  return <div className="app-shell twin-shell" data-layout="three-column-twin">
    <a className="skip-link" href="#main-content">Skip to workspace</a>
    <div className="mobile-bar"><span className="brand"><span className="brand-mark">RW</span>RAPP Work</span>
      <button className="icon-button" aria-label="Toggle navigation" aria-expanded={menuOpen} aria-controls="app-sidebar" onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" /></button></div>
    <aside className={`sidebar${menuOpen ? " is-open" : ""}`} id="app-sidebar" aria-label="Workspace sidebar">
      <div className="brand desktop-brand"><span className="brand-mark" aria-hidden="true">RW</span><div>RAPP Work<span className="brand-tagline">Intent. Review. Evidence.</span></div></div>
      <section className="workspace-catalog" aria-label="Business workspaces">
        <button className="workspace-choice" aria-pressed={selectedId === null} onClick={() => selectWorkspace(null)}>Owner concierge</button>
        {workspaces.map((item) => <button key={item.id} className="workspace-choice" aria-label={`Open ${item.name}`}
          aria-pressed={selectedId === item.id} onClick={() => selectWorkspace(item.id)}>{item.name}</button>)}
        <button className="button secondary" disabled={!connected} onClick={() => intent("workspace", "", null)}><Icon name="plus" size={16} />New workspace</button>
      </section>
      <nav aria-label="Primary navigation"><ul>{areas.map((item) => <li key={item.id}>
        <a href={`#${item.id}`} aria-label={item.label} aria-current={area === item.id ? "page" : undefined}
          onClick={(event) => { event.preventDefault(); navigate(item.id); }}><Icon name={item.icon} /><span>{item.label}</span></a>
      </li>)}</ul></nav>
      <section className="roster" aria-labelledby="roster-title"><div className="roster-heading"><h2 id="roster-title">Your agents</h2>
        <button className="icon-button" aria-label="Add an agent conversationally" disabled={!connected || !workspace}
          onClick={() => intent("agent")}><Icon name="plus" size={16} /></button></div>
        {!snapshot?.agents.length ? <p className="roster-empty">Describe the role or paste its complete instruction document. The Twin prepares the configuration.</p> :
          <ul>{snapshot.agents.map((agent) => <li key={agent.id}><button className="roster-agent" aria-label={`Review ${agent.name}`} disabled={!connected}
            onClick={() => setEditor({ kind: "agent", workspaceId: snapshot.workspaceId, existing: agent })}>
            <Avatar name={agent.name} small /><span className="min-zero"><strong>{agent.name}</strong><small>{agentAvailability(agent, providers, snapshot)}</small></span>
          </button></li>)}</ul>}
      </section>
      <div className="sidebar-bottom"><div className="connection"><span className={`connection-dot${connected ? " connected" : ""}`} /><strong>{connected ? "Host connected" : loading ? "Connecting to host" : "Host not connected"}</strong></div>
        <p>Connections and execution readiness are reported, never assumed.</p></div>
    </aside>
    <main id="main-content" className="main" tabIndex={-1}>
      <header className="page-header"><div><p className="breadcrumb">{selectedName}<span>/</span>{active.label}</p>
        <h1 ref={heading} tabIndex={-1}>{active.label}</h1><p className="page-description">Speak or type intent. Your Twin drafts; you decide.</p></div>
        <div className="header-actions"><button className="button secondary" aria-label="Refresh workspace" disabled={loading || busy}
          onClick={() => { void refresh(); }}><Icon name="refresh" size={16} /></button>
          <button className="button primary" disabled={!connected || busy || (selectedId === null && area !== "work")}
            onClick={() => intent(selectedId === null ? "workspace" : area === "work" ? "task" : area === "agents" ? "agent" : area === "automations" ? "automation" : "settings")}>
            <Icon name="plus" size={16} />{area === "settings" ? "Discuss settings" : selectedId === null ? "Describe a workspace" : area === "work" ? "New task" : area === "agents" ? "New agent" : "New routine"}
          </button></div>
      </header>
      <div className="content">
        {error && !editor && <div className="message error-message" role="alert">{error}</div>}
        {notice && !editor && <div className="message" role="status">{notice}</div>}
        {loading && <p role="status" aria-label="Loading workspace">Loading the selected workspace and its own conversation…</p>}
        {!connected && !loading && !snapshot && <div className="workspace-panel"><Empty icon="work" title="Connect your local workspace"
          action={<button className="button secondary" onClick={() => { void refresh(); }}>Try connecting again</button>}>
          The desktop host is required. No sample work or AI fallback is loaded.</Empty></div>}
        <TwinConversation key={selectedId ?? "concierge"} workspaceId={selectedId} name={workspace?.twin.name ?? "RAPP Work Twin"}
          conversation={conversation} connected={connected && !loading} busy={busy} seed={seed} send={state.sendMessage}
          review={review} dismiss={(proposal) => { void state.dismissProposal(proposal); }} />
        {!status?.ready && providers.map((provider) => !provider.configured && <p className="inline-note" key={provider.id}>{provider.detail}</p>)}
        {snapshot && <section className="workspace-activity" aria-label="Selected workspace records" aria-busy={busy}>
          {!connected && <p className="inline-note">Showing the last loaded workspace. Actions are disabled until the host reconnects.</p>}
          {area === "work" && <Work key={snapshot.workspaceId} snapshot={snapshot} status={status} computer={computer} connected={connected} busy={busy}
            perform={perform} newTask={() => intent("task")} review={(approval) => setEditor({ kind: "approval", workspaceId: snapshot.workspaceId, approval })}
            openArtifact={(item) => { void openArtifact(item); }} />}
          {area === "agents" && <Agents snapshot={snapshot} providers={providers} connected={connected} create={() => intent("agent")}
            edit={(existing) => setEditor({ kind: "agent", workspaceId: snapshot.workspaceId, existing })} />}
          {area === "automations" && <Automations snapshot={snapshot} connected={connected} create={() => intent("automation")}
            edit={(existing) => setEditor({ kind: "automation", workspaceId: snapshot.workspaceId, existing })} />}
          {area === "settings" && <Settings snapshot={snapshot} status={status} providers={providers} computer={computer} diagnostics={diagnostics}
            connected={connected} busy={busy} perform={perform} refresh={refresh} discuss={() => intent("settings")} />}
        </section>}
        <footer className="workspace-footer"><span>RAPP Work</span><span>Conversation first. Evidence by default.</span></footer>
      </div>
    </main>
    <ComputerPanel workspace={workspace} snapshot={snapshot} computer={computer} connected={connected && !loading} busy={busy}
      starting={state.pending === "computer.start"} perform={perform}
      discuss={() => intent("settings", "Review the computer access policy for this workspace and keep explicit approvals.")} />
    {editor?.workspaceId === selectedId && editor.kind === "proposal" && <ProposalReview proposal={editor.proposal} workspace={workspace} snapshot={snapshot}
      busy={busy} error={error} onClose={() => setEditor(null)} apply={state.applyProposal} />}
    {editor?.workspaceId === selectedId && (editor.kind === "agent" || editor.kind === "automation") && snapshot &&
      <ExistingReview kind={editor.kind} existing={editor.existing} snapshot={snapshot} busy={busy} error={error} onClose={() => setEditor(null)} perform={perform} />}
    {editor?.workspaceId === selectedId && editor.kind === "approval" && <ApprovalForm approval={editor.approval} recommendation={editor.recommendation}
      perform={perform} busy={busy} error={error} onClose={() => setEditor(null)} />}
    {artifact?.workspaceId === selectedId && <Modal title={artifact.item.name} onClose={() => setArtifact(null)} busy={artifactLoading}>
      <div className="form-body">{artifactLoading && <p role="status">Loading artifact…</p>}
        {artifact.error && <p role="alert">{artifact.error}</p>}
        {artifact.content !== null && <pre className="artifact-content" aria-label="Artifact content" tabIndex={0}>{artifact.content}</pre>}</div>
      <footer className="form-footer"><button className="button secondary" onClick={() => setArtifact(null)}>Close artifact</button></footer>
    </Modal>}
  </div>;
}
