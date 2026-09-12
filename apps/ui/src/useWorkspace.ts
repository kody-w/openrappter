import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkClient } from "./client";
import {
  workspaceSummarySchema, type Computer, type Diagnostics, type Provider, type RpcInput, type RpcMethod,
  type Agent, type Snapshot, type Status, type TwinConversation, type TwinDraft, type TwinMessageRequest, type WorkspaceSummary, type WorkspaceBreadcrumb,
} from "./model";

export type Perform = <M extends RpcMethod>(method: M, params: Omit<RpcInput<M>, "workspaceId">, message: string) => Promise<boolean>;
export function useWorkspace(client: WorkClient) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<WorkspaceBreadcrumb | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [conversation, setConversation] = useState<TwinConversation | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [computer, setComputer] = useState<Computer | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<RpcMethod | null>(null);
  const selection = useRef<string | null | undefined>(undefined);
  const selectionEpoch = useRef(0);
  const generation = useRef(0);
  const operation = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const isCurrent = useCallback((id: string | null) => mounted.current && selection.current === id, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const catalog = await client.call("workspaces.list", {});
      if (!mounted.current || current !== generation.current) return;
      let remembered: string | null = null;
      try { remembered = sessionStorage.getItem("rapp-work.selected-workspace"); } catch { /* Selection is only a locator preference. */ }
      let id = selection.current === undefined
        ? remembered === "" ? null : catalog.workspaces.find((item) => item.id === remembered)?.id ?? catalog.workspaces[0]?.id ?? null
        : selection.current;
      if (id !== null && !catalog.workspaces.some((item) => item.id === id)) id = null;
      if (selection.current !== id) selectionEpoch.current++;
      selection.current = id; setSelectedId(id); setWorkspaces(catalog.workspaces);
      const [opened, history, health, connections, machine, report] = await Promise.allSettled([
        id === null ? Promise.resolve(null) : client.call("workspaces.open", { workspaceId: id }),
        id === null ? client.call("twin.conversation", { workspaceId: null }) : Promise.resolve(null),
        client.call("system.status", {}), client.call("providers.list", { workspaceId: id }),
        id === null ? client.call("computer.inspect", { workspaceId: null }) : Promise.resolve(null),
        client.call("diagnostics.get", { workspaceId: id }),
      ]);
      if (!mounted.current || current !== generation.current || selection.current !== id) return;
      if (opened.status === "fulfilled" && opened.value) {
        if (opened.value.workspace.id !== id || opened.value.snapshot.workspaceId !== id || opened.value.twin.workspaceId !== id) {
          throw new Error("The host returned a different workspace.");
        }
        setWorkspace(opened.value.workspace); setSnapshot(opened.value.snapshot);
        setBreadcrumb(opened.value.breadcrumb);
        setConversation(opened.value.twin); setComputer(opened.value.computer);
      } else if (id === null && history.status === "fulfilled" && history.value) {
        setWorkspace(null); setSnapshot(null); setBreadcrumb(null); setConversation(history.value);
        setComputer(machine.status === "fulfilled" ? machine.value : null);
      } else throw opened.status === "rejected" ? opened.reason : new Error("Workspace conversation could not be loaded.");
      setStatus(health.status === "fulfilled" ? health.value : null);
      setProviders(connections.status === "fulfilled" ? connections.value : []);
      setDiagnostics(report.status === "fulfilled" ? report.value : null);
      setConnected(true); setLoading(false);
      const failed = [health, connections, machine, report].find((result) => result.status === "rejected");
      setError(failed?.status === "rejected" ? failed.reason instanceof Error ? failed.reason.message : "Some services are unavailable." : "");
    } catch (error) {
      if (!mounted.current || current !== generation.current) return;
      setConnected(false); setLoading(false); setComputer(null);
      setError(error instanceof Error ? error.message : "The workspace could not be refreshed.");
    }
  }, [client]);
  const selectWorkspace = useCallback((id: string | null) => {
    try { sessionStorage.setItem("rapp-work.selected-workspace", id ?? ""); } catch { /* The authorized refresh still determines access. */ }
    selection.current = id; selectionEpoch.current++; generation.current++; operation.current++;
    inFlight.current = false; setPending(null); setSelectedId(id);
    setWorkspace(null); setSnapshot(null); setBreadcrumb(null); setConversation(null); setComputer(null);
    setProviders([]); setDiagnostics(null); setError(""); setNotice(""); setLoading(true);
    void refresh();
  }, [refresh]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const remove = client.onConnection((state) => {
      if (state.state === "offline") {
        selectionEpoch.current++; generation.current++; operation.current++;
        inFlight.current = false; setPending(null); setConnected(false); setComputer(null); setStatus(null);
        setProviders([]); setError(state.detail); setLoading(false);
      } else if (state.state === "online") void refresh();
    });
    return () => { mounted.current = false; generation.current++; selectionEpoch.current++; remove(); };
  }, [client, refresh]);
  useEffect(() => {
    if (!connected || selectedId === null) return;
    let disposed = false;
    const removers: (() => void)[] = [];
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { if (!disposed) void refresh(); }, 100);
    };
    for (const area of ["work", "agents", "automations", "settings"] as const) {
      void client.subscribe(selectedId, { area }, changed).then((remove) => {
        if (disposed) remove(); else removers.push(remove);
      }).catch(() => { if (!disposed) setError("Live updates are unavailable. Refresh to check the current workspace."); });
    }
    return () => { disposed = true; clearTimeout(debounce); removers.forEach((remove) => remove()); };
  }, [client, selectedId, connected, refresh]);
  const run = useCallback(async <T,>(method: RpcMethod, action: () => Promise<T>, success: string): Promise<T | undefined> => {
    if (inFlight.current || !connected) return undefined;
    const epoch = selectionEpoch.current, id = ++operation.current;
    inFlight.current = true; setPending(method); setError(""); setNotice("");
    try {
      const result = await action();
      if (!mounted.current || epoch !== selectionEpoch.current || id !== operation.current) return undefined;
      await refresh();
      if (!mounted.current || epoch !== selectionEpoch.current || id !== operation.current) return undefined;
      setNotice(success);
      return result;
    } catch (error) {
      if (mounted.current && epoch === selectionEpoch.current && id === operation.current) {
        setError(error instanceof Error ? error.message : "The requested work could not be completed.");
      }
      return undefined;
    } finally {
      if (mounted.current && epoch === selectionEpoch.current && id === operation.current) {
        inFlight.current = false; setPending(null);
      }
    }
  }, [connected, refresh]);
  const perform: Perform = useCallback(async (method, params, message) => {
    const workspaceId = selectedId;
    if (selection.current !== workspaceId) return false;
    if (typeof workspaceId !== "string") { setError("Select a business workspace for this action."); return false; }
    return await run(method, () => client.call(method, { ...params, workspaceId } as RpcInput<typeof method>), message) !== undefined;
  }, [client, run, selectedId]);
  const sendMessage = useCallback(async (message: string, target: TwinMessageRequest["target"]) => {
    const workspaceId = selectedId;
    if (selection.current !== workspaceId) return undefined;
    const history = (conversation?.turns ?? []).slice(-6).filter((turn) => turn.content.length <= 3000)
      .map(({ role, content }) => ({ role, content }));
    return run("twin.message", () => client.call("twin.message", {
      workspaceId, message, history, target: target ?? "auto",
    }), "The Twin has responded. Internal organization may evolve; external work still requires review.");
  }, [client, conversation, run, selectedId]);
  const applyProposal = useCallback(async (draft: TwinDraft, editedDraft?: Record<string, unknown>) => {
    if (selection.current !== draft.workspaceId || draft.basis?.verification?.state !== "verified" || !draft.readyForReview) return false;
    const result = await run("twin.applyProposal", () => client.call("twin.applyProposal", {
      workspaceId: draft.workspaceId, id: draft.id, proposalHash: draft.basis!.proposalHash,
      ...(editedDraft ? { editedDraft } : {}),
    }), "Reviewed draft applied through the canonical Work service.");
    if (result?.kind === "workspace") selectWorkspace(workspaceSummarySchema.parse(result.result).id);
    if (result?.kind === "agent") {
      const child = workspaceSummarySchema.parse(result.result.workspace);
      if (child.parentWorkspaceId !== draft.workspaceId || child.ownerType !== "agent") throw new Error("The child workspace does not match the reviewed parent.");
      selectWorkspace(child.id);
    }
    return result !== undefined;
  }, [client, run, selectWorkspace]);
  const dismissProposal = useCallback(async (draft: TwinDraft) => {
    if (selection.current !== draft.workspaceId || !draft.basis) return false;
    return await run("twin.dismissProposal", () => client.call("twin.dismissProposal", {
      workspaceId: draft.workspaceId, id: draft.id, proposalHash: draft.basis!.proposalHash, reason: "Dismissed after review.",
    }), "Draft dismissed without applying it.") !== undefined;
  }, [client, run]);
  const openAgentWorkspace = useCallback(async (agent: Agent) => {
    const parent = selectedId, epoch = selectionEpoch.current;
    if (!parent || selection.current !== parent || agent.workspaceId === parent) return;
    try {
      const child = await client.call("agents.openWorkspace", { workspaceId: parent, id: agent.id });
      if (!mounted.current || epoch !== selectionEpoch.current || selection.current !== parent) return;
      if (child.parentWorkspaceId !== parent || child.ownerAgentId !== agent.id || child.id !== agent.workspaceId) {
        throw new Error("The agent's dedicated workspace identity changed.");
      }
      selectWorkspace(child.id);
    } catch (error) {
      if (mounted.current && epoch === selectionEpoch.current) setError(error instanceof Error ? error.message : "The agent workspace could not be opened.");
    }
  }, [client, selectedId, selectWorkspace]);
  return {
    workspaces, selectedId, workspace, breadcrumb, snapshot, conversation, status, providers, computer, diagnostics,
    loading, connected, error, notice, busy: pending !== null, pending,
    refresh, perform, selectWorkspace, sendMessage, applyProposal, dismissProposal, openAgentWorkspace, isCurrent,
  };
}
