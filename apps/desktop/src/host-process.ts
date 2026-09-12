import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { HostState } from "./contract.js";

export interface OwnedChild {
  readonly pid?: number;
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): unknown;
}
export interface HostLease { port: number; instanceId: string; token: string }
export interface HostProcessPorts {
  spawn(): OwnedChild;
  probe(lease: HostLease): Promise<boolean>;
  forceKill(child: OwnedChild): void;
  stateChanged(state: HostState): void;
}
const readySchema = z.strictObject({
  type: z.literal("ready"), protocolVersion: z.literal(1), port: z.number().int().min(1).max(65535), instanceId: z.uuid(),
});
const failedSchema = z.strictObject({ type: z.literal("failed"), code: z.string().max(80) });
export class HostProcess {
  private child?: OwnedChild;
  private lease?: HostLease;
  private starting?: Promise<HostLease>;
  private abortStart?: () => void;
  private stopping?: Promise<void>;
  private stopRequested = false;
  private current: HostState = { state: "offline", detail: "The local host has not started." };
  constructor(private readonly ports: HostProcessPorts, private readonly directory: string, private readonly timeoutMs = 15000) {}
  get state(): HostState { return { ...this.current }; }
  private change(state: HostState) { this.current = state; this.ports.stateChanged(state); }
  start(): Promise<HostLease> {
    if (this.stopRequested) return Promise.reject(new Error("The desktop is shutting down."));
    if (this.lease && this.child) return Promise.resolve(this.lease);
    if (this.starting) return this.starting;
    this.change({ state: "starting", detail: "Starting the owned local host." });
    const operation = new Promise<HostLease>((resolve, reject) => {
      let settled = false;
      let child: OwnedChild;
      try { child = this.ports.spawn(); this.child = child; }
      catch { this.change({ state: "offline", detail: "The owned host process could not be started." }); reject(new Error("Host startup failed.")); return; }
      const token = randomBytes(48).toString("base64url");
      const fail = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.abortStart = undefined;
        this.lease = undefined;
        try { this.ports.forceKill(child); } catch { child.kill(); }
        if (this.child === child) this.child = undefined;
        this.change({ state: "offline", detail: "The local host did not complete its authenticated startup." });
        reject(new Error("The owned host could not be authenticated."));
      };
      this.abortStart = fail;
      const timer = setTimeout(fail, this.timeoutMs);
      child.on("exit", () => {
        if (this.child === child) { this.child = undefined; this.lease = undefined; }
        this.change({ state: "offline", detail: this.stopRequested ? "The local host has stopped." : "The local host exited. Refresh to restart it." });
        if (!settled) { settled = true; clearTimeout(timer); this.abortStart = undefined; reject(new Error("The owned host exited during startup.")); }
      });
      child.on("message", (raw) => {
        if (settled || this.stopRequested) return;
        if (failedSchema.safeParse(raw).success) { fail(); return; }
        const ready = readySchema.safeParse(raw);
        if (!ready.success) { fail(); return; }
        const lease = { port: ready.data.port, instanceId: ready.data.instanceId, token };
        void this.ports.probe(lease).then((verified) => {
          if (settled || this.stopRequested) return;
          if (!verified) { fail(); return; }
          settled = true; clearTimeout(timer); this.abortStart = undefined; this.lease = lease;
          this.change({ state: "online", detail: "Owned loopback host authenticated. Service readiness is reported separately." });
          resolve(lease);
        }).catch(fail);
      });
      try { child.postMessage({ type: "bootstrap", protocolVersion: 1, token, dataDirectory: this.directory }); }
      catch { fail(); }
    });
    this.starting = operation;
    void operation.finally(() => { if (this.starting === operation) this.starting = undefined; }).catch(() => {});
    return operation;
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopRequested = true;
    const child = this.child;
    this.stopping = (async () => {
      if (!child) return;
      const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));
      this.abortStart?.();
      if (this.child !== child) return;
      try { child.postMessage({ type: "shutdown" }); } catch { child.kill(); }
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          deadline = setTimeout(() => {
            if (this.child === child) this.ports.forceKill(child);
            resolve();
          }, 3000);
        }),
      ]);
      clearTimeout(deadline);
      this.lease = undefined; this.child = undefined;
      this.change({ state: "offline", detail: "The owned local host has stopped." });
    })();
    return this.stopping;
  }
}
