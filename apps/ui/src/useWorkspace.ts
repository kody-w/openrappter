import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkClient } from "./client";
import type { Computer, Diagnostics, Provider, RpcInput, RpcMethod, Snapshot, Status } from "./model";

export type Perform = <M extends RpcMethod>(method: M, params: RpcInput<M>, message: string) => Promise<boolean>;
export function useWorkspace(client: WorkClient) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [computer, setComputer] = useState<Computer | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const results = await Promise.allSettled([
      client.call("work.snapshot", {}), client.call("system.status", {}),
      client.call("providers.list", {}), client.call("computer.inspect", {}), client.call("diagnostics.get", {}),
    ]);
    if (!mounted.current || generation.current !== current) return;
    const [workspace, health, connections, machine, report] = results;
    if (workspace.status === "fulfilled") {
      setSnapshot(workspace.value); setConnected(true);
    } else { setConnected(false); }
    setStatus(health.status === "fulfilled" ? health.value : null);
    setProviders(connections.status === "fulfilled" ? connections.value : []);
    setComputer(machine.status === "fulfilled" ? machine.value : null);
    setDiagnostics(report.status === "fulfilled" ? report.value : null);
    const failure = results.find((result) => result.status === "rejected");
    setError(failure?.status === "rejected"
      ? failure.reason instanceof Error ? failure.reason.message : "Some services could not be refreshed."
      : "");
    setLoading(false);
  }, [client]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const remove = client.onConnection((state) => {
      if (state.state === "offline") {
        generation.current++;
        setConnected(false); setStatus(null); setComputer(null); setProviders([]);
        setError(state.detail); setLoading(false);
      } else if (state.state === "online") void refresh();
    });
    return () => { mounted.current = false; generation.current++; remove(); };
  }, [client, refresh]);
  useEffect(() => {
    if (!connected) return;
    let disposed = false;
    const removers: (() => void)[] = [];
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { void refresh(); }, 80);
    };
    for (const area of ["work", "agents", "automations", "settings"] as const) {
      void client.subscribe({ area }, changed).then((remove) => {
        if (disposed) remove(); else removers.push(remove);
      }).catch(() => { if (!disposed) setError("Live updates are unavailable. Use Refresh to check current work."); });
    }
    return () => { disposed = true; clearTimeout(debounce); removers.forEach((remove) => remove()); };
  }, [client, connected, refresh]);
  const perform: Perform = useCallback(async (method, params, message) => {
    if (inFlight.current) return false;
    if (!connected) { setError("Reconnect to the desktop host before changing work."); return false; }
    inFlight.current = true;
    setBusy(true); setNotice(""); setError("");
    try {
      await client.call(method, params);
      await refresh();
      if (mounted.current) setNotice(message);
      return true;
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : "The action could not be completed.");
      return false;
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }, [client, connected, refresh]);
  return { snapshot, status, providers, computer, diagnostics, loading, connected, error, notice, busy, refresh, perform };
}
