import { useEffect, useState } from "react";
import { Icon } from "./components";
import type { WorkspaceSummary } from "./model";

export function inheritedStatus(workspace: WorkspaceSummary, nodes: WorkspaceSummary[]) {
  const statuses = workspace.lineage.map((id) => nodes.find((node) => node.id === id)?.status);
  return statuses.includes("archived") ? "archived" : statuses.includes("paused") ? "paused" : workspace.status;
}
export function WorkspaceTree({ workspaces, selectedId, query, previews, ownerKey, select }: {
  workspaces: WorkspaceSummary[]; selectedId: string | null; query: string;
  previews: Record<string, { content: string; phase: string; revision: number }>;
  ownerKey: string; select: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(new Map<string, boolean>());
  const selected = workspaces.find((item) => item.id === selectedId);
  useEffect(() => { setExpanded(new Map()); }, [selectedId]);
  const matches = new Set(workspaces.filter((item) => `${item.name} ${item.purpose}`.toLowerCase().includes(query.toLowerCase())).map((item) => item.id));
  const visible = new Set([...matches].flatMap((id) => workspaces.find((item) => item.id === id)!.lineage));
  const renderNode = (workspace: WorkspaceSummary) => {
    if (query && !visible.has(workspace.id)) return null;
    const children = workspaces.filter((item) => item.parentWorkspaceId === workspace.id);
    const open = Boolean(query) || (expanded.get(workspace.id) ?? Boolean(selected?.lineage.includes(workspace.id)));
    const preview = previews[`${ownerKey}:${workspace.id}`];
    const status = inheritedStatus(workspace, workspaces);
    return <li key={workspace.id} data-workspace-node={workspace.id}>
      <div className="workspace-node-row">
        {!!children.length && <button className="icon-button tree-toggle" aria-label={`${open ? "Collapse" : "Expand"} children of ${workspace.name}`}
          aria-expanded={open} aria-controls={`workspace-children-${workspace.id}`}
          onClick={() => setExpanded((current) => {
            const next = new Map(current); next.set(workspace.id, !open);
            return next;
          })}><Icon name={open ? "menu" : "arrow"} size={13} /></button>}
        <button className={`workspace-entry${selectedId === workspace.id ? " selected" : ""}`} aria-label={`Open workspace ${workspace.name}`}
          aria-pressed={selectedId === workspace.id} onClick={() => select(workspace.id)}>
          <span className="workspace-entry-top"><span className="workspace-avatar" aria-hidden="true">{workspace.ownerType === "agent" ? <Icon name="agents" size={14} /> : workspace.name.slice(0, 1).toUpperCase()}</span><strong>{workspace.name}</strong></span>
          <span className="workspace-exchange">{preview?.content ?? workspace.purpose}</span>
          <span className="workspace-entry-status"><span className="connection-dot" aria-hidden="true" />
            {status !== "active" ? status : preview?.phase ?? "Saved workspace"}<span>{workspace.ownerType === "human" ? "You" : "Agent workspace"}</span></span>
        </button>
      </div>
      {!!children.length && open && <ul id={`workspace-children-${workspace.id}`} aria-label={`Children of ${workspace.name}`}>{children.map(renderNode)}</ul>}
    </li>;
  };
  const roots = workspaces.filter((item) => item.parentWorkspaceId === null || !workspaces.some((parent) => parent.id === item.parentWorkspaceId));
  return <nav aria-label="Business workspaces" className="workspace-list workspace-tree">
    {!matches.size && <p className="workspace-empty">{query ? "No workspaces match this search." : "Describe your business to the concierge. Every confirmed agent gets its own child workspace."}</p>}
    <ul>{roots.map(renderNode)}</ul>
  </nav>;
}
