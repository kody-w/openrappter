import { useCallback, useEffect, useState } from "react";
import type { WorkClient } from "./client";
import { Icon } from "./components";
import { conversationPhase } from "./proposals";
import { useWorkspaces } from "./useWorkspace";
import { WorkspaceSession, type TwinIntent } from "./WorkspaceSession";

export function App({ client }: { client: WorkClient }) {
  const catalog = useWorkspaces(client);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [intent, setIntent] = useState<TwinIntent | null>(null);
  const [previews, setPreviews] = useState<Record<string, { content: string; phase: string; revision: number }>>({});
  const ownerKey = `${catalog.catalog?.ownerId ?? "offline"}:${catalog.catalog?.conciergeWorkspaceId ?? "unknown"}`;
  const workspaces = catalog.catalog?.workspaces ?? [];
  const selected = workspaces.find((item) => item.id === catalog.selectedId) ?? null;
  const visible = workspaces.filter((item) => `${item.name} ${item.purpose}`.toLowerCase().includes(query.toLowerCase()));
  const onExchange = useCallback((workspaceId: string | null, content: string, phase: string, revision: number) => {
    if (!workspaceId) return;
    const key = `${ownerKey}:${workspaceId}`;
    setPreviews((current) => {
      const previous = current[key];
      if (previous && (previous.revision > revision || previous.content === content && previous.phase === phase && previous.revision === revision)) return current;
      return { ...current, [key]: { content, phase, revision } };
    });
  }, [ownerKey]);
  useEffect(() => {
    if (!catalog.connected || !catalog.catalog) return;
    let active = true;
    let next = 0;
    const records = catalog.catalog.workspaces;
    const worker = async () => {
      while (next < records.length && active) {
        const workspace = records[next++]!;
        try {
          const conversation = await client.call("twin.conversation", { workspaceId: workspace.id });
          const last = conversation.turns.at(-1);
          if (active && last && conversation.workspaceId === workspace.id) onExchange(workspace.id, last.content, conversationPhase(conversation), conversation.revision);
        } catch { /* Unavailable previews are never replaced with invented exchanges. */ }
      }
    };
    void Promise.all(Array.from({ length: Math.min(3, records.length) }, worker));
    return () => { active = false; };
  }, [catalog.catalog, catalog.connected, client, onExchange]);
  const select = (workspaceId: string | null) => { setIntent(null); catalog.select(workspaceId); setMenuOpen(false); };
  const newWorkspace = () => {
    catalog.select(null); setMenuOpen(false);
    setIntent({ id: crypto.randomUUID(), workspaceId: null, target: "workspace", text: "Create a workspace for " });
  };
  return <div className="app-shell twin-shell">
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to Twin conversation</a>
    <div className="mobile-bar"><span className="brand"><span className="brand-mark" aria-hidden="true">RW</span>RAPP Work</span>
      <button className="icon-button" aria-label="Toggle workspaces" aria-expanded={menuOpen} aria-controls="workspace-sidebar" onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" /></button>
    </div>
    <aside className={`workspace-sidebar${menuOpen ? " is-open" : ""}`} id="workspace-sidebar" aria-label="Workspaces">
      <div className="brand desktop-brand"><span className="brand-mark" aria-hidden="true">RW</span><div>RAPP Work<span className="brand-tagline">Your business. In conversation.</span></div></div>
      <div className="workspace-list-heading"><h2>Workspaces</h2><button className="icon-button" aria-label="New workspace" title="Create a workspace with the concierge Twin" disabled={!catalog.connected} onClick={newWorkspace}><Icon name="plus" size={19} /></button></div>
      <div className="workspace-search"><Icon name="search" size={17} /><label htmlFor="workspace-search" className="sr-only">Search workspaces</label><input id="workspace-search" type="search" placeholder="Find a workspace" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <button className={`concierge-button${catalog.selectedId === null ? " selected" : ""}`} aria-pressed={catalog.selectedId === null} onClick={() => select(null)}>
        <span className="twin-mark" aria-hidden="true"><Icon name="chat" size={19} /></span><span><strong>Concierge Twin</strong><small>A new business starts here</small></span>
      </button>
      <nav aria-label="Business workspaces" className="workspace-list">
        {!visible.length && <p className="workspace-empty">{query ? "No workspaces match this search." : catalog.loading ? "Loading your workspaces…" : "Tell the concierge what you want to build. It will draft your first workspace."}</p>}
        <ul>{visible.map((workspace) => <li key={workspace.id}><button className={`workspace-entry${selected?.id === workspace.id ? " selected" : ""}`}
          aria-label={`Open workspace ${workspace.name}`} aria-pressed={selected?.id === workspace.id} onClick={() => select(workspace.id)}>
          <span className="workspace-entry-top"><span className="workspace-avatar" aria-hidden="true">{workspace.name.slice(0, 1).toUpperCase()}</span><strong>{workspace.name}</strong></span>
          <span className="workspace-exchange">{previews[`${ownerKey}:${workspace.id}`]?.content ?? workspace.purpose}</span>
          <span className="workspace-entry-status"><span className="connection-dot" aria-hidden="true" />{previews[`${ownerKey}:${workspace.id}`]?.phase ?? (selected?.id === workspace.id ? "Selected workspace" : "Saved workspace")}<span>{previews[`${ownerKey}:${workspace.id}`] ? "Latest exchange" : "Your business context"}</span></span>
        </button></li>)}</ul>
      </nav>
      <div className="workspace-sidebar-footer"><div className="connection"><span className={`connection-dot${catalog.connected ? " connected" : ""}`} aria-hidden="true" /><strong>{catalog.connected ? "Local host connected" : catalog.loading ? "Connecting…" : "Host not connected"}</strong></div><p>Separate workspaces. Persistent conversations.<br />You stay in control.</p></div>
    </aside>
    <WorkspaceSession key={`${catalog.catalog?.ownerId ?? "offline"}:${catalog.selectedId ?? "concierge"}`}
      client={client} workspace={selected} workspaceId={catalog.selectedId} online={catalog.connected}
      connectionError={catalog.error} catalogLoading={catalog.loading} intent={intent} onExchange={onExchange}
      onRefreshCatalog={async () => { await catalog.refresh(); }}
      onCreated={async (workspaceId) => {
        const result = await catalog.refresh();
        if (result?.workspaces.some((item) => item.id === workspaceId)) { catalog.select(workspaceId); setIntent(null); }
      }} />
  </div>;
}
