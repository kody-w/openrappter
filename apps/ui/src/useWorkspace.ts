import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkClient } from "./client";
import type { Computer, Diagnostics, Provider, RpcInput, RpcMethod, RpcResult, Snapshot, Status, TwinConversation, WorkspaceBreadcrumb, WorkspaceList, WorkspaceSummary } from "./model";

export type Perform = <M extends RpcMethod>(method: M, params: RpcInput<M>, message: string) => Promise<boolean>;
const messageOf = (error: unknown) => error instanceof Error ? error.message : "The local host could not complete this request.";

export function useWorkspaces(client: WorkClient) {
  const [catalog, setCatalog] = useState<WorkspaceList | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const loadedOwner = useRef("");
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await client.call("workspaces.list", {});
      if (current !== generation.current) return;
      const identity = `${result.ownerId}:${result.conciergeWorkspaceId}`;
      setCatalog(result); setConnected(true); setError("");
      if (loadedOwner.current !== identity) {
        loadedOwner.current = identity;
        let previous: string | null = null;
        try { previous = window.localStorage.getItem(`rapp-work:selected:${identity}`); } catch { /* Selection storage is optional. */ }
        setSelectedId(result.workspaces.some((item) => item.id === previous) ? previous
          : previous === "concierge" ? null : result.workspaces[0]?.id ?? null);
      } else setSelectedId((value) => result.workspaces.some((item) => item.id === value) ? value : null);
      return result;
    } catch (reason) {
      if (current === generation.current) { setConnected(false); setError(messageOf(reason)); }
    } finally { if (current === generation.current) setLoading(false); }
  }, [client]);
  useEffect(() => {
    void refresh();
    const remove = client.onConnection((state) => {
      if (state.state === "offline") {
        generation.current++; setConnected(false); setLoading(false); setError(state.detail);
      } else if (state.state === "online") void refresh();
    });
    return () => { generation.current++; remove(); };
  }, [client, refresh]);
  const select = (id: string | null) => {
    setSelectedId(id);
    if (catalog) try { window.localStorage.setItem(`rapp-work:selected:${catalog.ownerId}:${catalog.conciergeWorkspaceId}`, id ?? "concierge"); } catch { /* Do not prevent workspace switching. */ }
  };
  const updateWorkspace = useCallback((workspace: WorkspaceSummary) => {
    setCatalog((current) => {
      if (!current || current.ownerId !== workspace.ownerId || !current.workspaces.some((item) => item.id === workspace.id)) return current;
      const existing = current.workspaces.find((item) => item.id === workspace.id)!;
      if (existing.revision > workspace.revision || JSON.stringify(existing) === JSON.stringify(workspace)) return current;
      return { ...current, workspaces: current.workspaces.map((item) => item.id === workspace.id ? workspace : item) };
    });
  }, []);
  return { catalog, selectedId, select, updateWorkspace, connected, loading, error, refresh };
}

export function useWorkspace(client: WorkClient, workspaceId: string | null, online: boolean) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<WorkspaceBreadcrumb | null>(null);
  const [conversation, setConversation] = useState<TwinConversation | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [computer, setComputer] = useState<Computer | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const lifecycle = useRef(0);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (!online) { setLoading(false); return; }
    const current = ++generation.current;
    const results = await Promise.allSettled([
      workspaceId === null ? client.call("twin.conversation", { workspaceId: null })
        : client.call("workspaces.open", { workspaceId }),
      client.call("system.status", {}), client.call("providers.list", { workspaceId }),
      client.call("diagnostics.get", { workspaceId }),
    ]);
    if (!mounted.current || generation.current !== current) return;
    const [workspace, health, connections, report] = results;
    if (workspace.status === "fulfilled") {
      if ("snapshot" in workspace.value) {
        if (workspace.value.workspace.id !== workspaceId || workspace.value.snapshot.workspaceId !== workspaceId || workspace.value.twin.workspaceId !== workspaceId) {
          setError("The host returned another workspace. No data was loaded."); setReady(false); setLoading(false); return;
        }
        setSnapshot(workspace.value.snapshot); setConversation(workspace.value.twin); setComputer(workspace.value.computer);
        setWorkspace(workspace.value.workspace); setBreadcrumb(workspace.value.breadcrumb);
      } else {
        if (workspace.value.workspaceId !== null) { setError("The concierge conversation has an invalid scope."); setReady(false); setLoading(false); return; }
        setConversation(workspace.value);
      }
      setReady(true);
    } else setReady(false);
    setStatus(health.status === "fulfilled" ? health.value : null);
    setProviders(connections.status === "fulfilled" ? connections.value : []);
    setDiagnostics(report.status === "fulfilled" ? report.value : null);
    const failure = results.find((result) => result.status === "rejected");
    setError(failure?.status === "rejected" ? messageOf(failure.reason) : "");
    setLoading(false);
  }, [client, online, workspaceId]);
  useEffect(() => {
    lifecycle.current++;
    mounted.current = true;
    if (online) void refresh();
    else { generation.current++; setReady(false); setComputer(null); setStatus(null); setLoading(false); }
    return () => { mounted.current = false; generation.current++; lifecycle.current++; };
  }, [online, refresh]);
  const connected = online && ready;
  useEffect(() => {
    if (!connected || workspaceId === null) return;
    let disposed = false;
    const removers: (() => void)[] = [];
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { if (!disposed) void refresh(); }, 80);
    };
    for (const area of ["work", "agents", "automations", "settings"] as const) {
      void client.subscribe({ area, workspaceId }, changed).then((remove) => {
        if (disposed) remove(); else removers.push(remove);
      }).catch(() => { if (!disposed) setError("Live updates are unavailable. Refresh to check current work."); });
    }
    return () => { disposed = true; clearTimeout(debounce); removers.forEach((remove) => remove()); };
  }, [client, connected, refresh, workspaceId]);
  const request = useCallback(async <M extends RpcMethod>(method: M, params: RpcInput<M>, message: string, onError?: (error: Error) => void): Promise<RpcResult<M> | undefined> => {
    if (inFlight.current || !mounted.current) return;
    if (!connected) { setError("Reconnect to the desktop host before changing work."); return; }
    if (!("workspaceId" in params) || params.workspaceId !== workspaceId) {
      setError("This action does not belong to the selected workspace."); return;
    }
    inFlight.current = true;
    const epoch = lifecycle.current;
    setBusy(true); setNotice(""); setError("");
    try {
      const result = await client.call(method, params);
      if (!mounted.current || lifecycle.current !== epoch) return;
      await refresh();
      if (!mounted.current || lifecycle.current !== epoch) return;
      setNotice(message);
      return result;
    } catch (reason) {
      if (mounted.current && lifecycle.current === epoch) {
        setError(messageOf(reason)); onError?.(reason instanceof Error ? reason : new Error(messageOf(reason)));
      }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }, [client, connected, refresh, workspaceId]);
  const perform: Perform = useCallback(async (method, params, message) => (await request(method, params, message)) !== undefined, [request]);
  return { workspace, breadcrumb, snapshot, conversation, status, providers, computer, diagnostics, loading, connected, error, notice, busy, refresh, perform, request };
}
