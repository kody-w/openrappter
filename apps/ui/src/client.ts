import { z } from "zod";
import { agentWorkspaceResultSchema, automationSchema, eventSchema, rpcContracts, settingsReviewSchema, taskSchema, workspaceSummarySchema, type EventScope, type RpcInput, type RpcMethod, type RpcResult } from "./model";

export const hostStateSchema = z.strictObject({
  state: z.enum(["starting", "online", "offline"]), detail: z.string().max(512),
});
const bridgeEventSchema = z.discriminatedUnion("type", [
  hostStateSchema.extend({ type: z.literal("host") }),
  z.strictObject({
    type: z.literal("events"), subscriptionId: z.uuid(),
    events: z.array(eventSchema).max(200), cursor: z.string().max(2048),
  }),
]);
export type HostState = z.infer<typeof hostStateSchema>;
export interface DesktopBridge {
  request(input: { method: string; params: unknown }): Promise<unknown>;
  onEvent(callback: (event: unknown) => void): () => void;
  hostState(): Promise<unknown>;
}
export interface WorkClient {
  call<M extends RpcMethod>(method: M, params: RpcInput<M>): Promise<RpcResult<M>>;
  subscribe(scope: EventScope, changed: () => void): Promise<() => void>;
  onConnection(changed: (state: HostState) => void): () => void;
}
export class BridgeClient implements WorkClient {
  constructor(private readonly bridge: DesktopBridge) {}
  async call<M extends RpcMethod>(method: M, params: RpcInput<M>): Promise<RpcResult<M>> {
    const contract = rpcContracts[method];
    const input = contract.input.safeParse(params);
    if (!input.success) throw new Error("This request is incomplete or invalid. Ask your Twin to finish the draft.");
    const raw = await this.bridge.request({ method, params: input.data });
    const output = contract.output.safeParse(raw);
    if (!output.success) throw new Error("The host returned an invalid response. Refresh diagnostics before continuing.");
    const scoped = input.data as { workspaceId?: string | null };
    if (method === "workspaces.list") {
      const catalog = output.data as RpcResult<"workspaces.list">;
      const nodes = new Map(catalog.workspaces.map((workspace) => [workspace.id, workspace]));
      if (nodes.size !== catalog.workspaces.length || catalog.workspaces.some((workspace) => {
        const parent = workspace.parentWorkspaceId ? nodes.get(workspace.parentWorkspaceId) : undefined;
        return workspace.ownerId !== catalog.ownerId || parent && (
          workspace.depth !== parent.depth + 1 || workspace.rootWorkspaceId !== parent.rootWorkspaceId
          || JSON.stringify(workspace.lineage) !== JSON.stringify([...parent.lineage, workspace.id]));
      })) throw new Error("The host returned an inconsistent workspace lineage.");
    }
    if (method === "twin.message" || method === "twin.conversation" || method === "twin.dismissProposal" || method === "twin.applyProposal" || method === "work.snapshot") {
      if ((output.data as { workspaceId: string | null }).workspaceId !== scoped.workspaceId)
        throw new Error("The host response belongs to another workspace.");
    }
    if (method === "workspaces.open" && (output.data as { workspace: { id: string } }).workspace.id !== scoped.workspaceId)
      throw new Error("The host response belongs to another workspace.");
    if (method === "workspaces.open") {
      const opened = output.data as RpcResult<"workspaces.open">;
      if (opened.snapshot.workspaceId !== scoped.workspaceId || opened.twin.workspaceId !== scoped.workspaceId
        || opened.breadcrumb.workspaceId !== scoped.workspaceId
        || JSON.stringify(opened.breadcrumb.ancestors.map((item) => item.id)) !== JSON.stringify(opened.workspace.lineage)
        || (opened.computer.workspace && opened.computer.workspace.id !== scoped.workspaceId))
        throw new Error("The workspace, lineage, conversation, and computer bindings do not agree.");
    }
    const conversation = method === "workspaces.open" ? (output.data as RpcResult<"workspaces.open">).twin
      : method === "twin.conversation" || method === "twin.dismissProposal" ? output.data as RpcResult<"twin.conversation"> : null;
    if (conversation && [...conversation.turns, ...conversation.proposals, ...conversation.events].some((item) => item.workspaceId !== scoped.workspaceId))
      throw new Error("The host returned conversation records from another workspace.");
    if (method === "agents.openWorkspace") {
      const child = output.data as RpcResult<"agents.openWorkspace">;
      const input = params as RpcInput<"agents.openWorkspace">;
      if (child.parentWorkspaceId !== input.workspaceId || child.ownerAgentId !== input.id || child.ownerType !== "agent")
        throw new Error("The agent workspace does not match its authorized parent.");
    }
    if (method === "computer.inspect" || method === "computer.start" || method === "computer.stop") {
      const computer = output.data as RpcResult<"computer.inspect">;
      if (computer.workspace && computer.workspace.id !== scoped.workspaceId)
        throw new Error("The computer response belongs to another workspace.");
      if (computer.lease?.state === "held" && computer.lease.workspaceId !== scoped.workspaceId)
        throw new Error("The computer lease belongs to another workspace.");
    }
    if (method === "twin.applyProposal" && (output.data as { id: string }).id !== (input.data as unknown as { id: string }).id)
      throw new Error("The host returned a receipt for a different proposal.");
    if (method === "twin.applyProposal") {
      const receipt = output.data as RpcResult<"twin.applyProposal">;
      const schemas = { workspace: workspaceSummarySchema, agent: agentWorkspaceResultSchema, task: taskSchema, automation: automationSchema, settings: settingsReviewSchema };
      if (!schemas[receipt.kind].safeParse(receipt.result).success)
        throw new Error("The host returned an invalid response: the applied record or child workspace is incomplete.");
    }
    return output.data as RpcResult<M>;
  }
  async subscribe(scope: EventScope, changed: () => void): Promise<() => void> {
    const { workspaceId, ...area } = scope;
    let subscriptionId: string | undefined;
    const queued = new Set<string>();
    const remove = this.bridge.onEvent((raw) => {
      const parsed = bridgeEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.type !== "events") return;
      if (!subscriptionId) queued.add(parsed.data.subscriptionId);
      else if (parsed.data.subscriptionId === subscriptionId) changed();
    });
    try {
      const subscription = await this.call("events.subscribe", { workspaceId, scope: area, limit: 200 });
      subscriptionId = subscription.subscriptionId;
      if (subscription.events.length || queued.has(subscriptionId)) changed();
      return () => {
        remove();
        void this.call("events.unsubscribe", { workspaceId, subscriptionId: subscription.subscriptionId }).catch(() => {});
      };
    } catch (error) { remove(); throw error; }
  }
  onConnection(changed: (state: HostState) => void): () => void {
    let active = true;
    const remove = this.bridge.onEvent((raw) => {
      const event = bridgeEventSchema.safeParse(raw);
      if (event.success && event.data.type === "host") changed({ state: event.data.state, detail: event.data.detail });
    });
    void this.bridge.hostState().then((raw) => {
      if (active) changed(hostStateSchema.parse(raw));
    }).catch(() => { if (active) changed({ state: "offline", detail: "The desktop host is unavailable." }); });
    return () => { active = false; remove(); };
  }
}
export class DisconnectedClient implements WorkClient {
  async call<M extends RpcMethod>(_method: M, _params: RpcInput<M>): Promise<RpcResult<M>> {
    throw new Error("Open this workspace in RAPP Work desktop to connect to its local host.");
  }
  async subscribe(): Promise<() => void> { return () => {}; }
  onConnection(changed: (state: HostState) => void) {
    changed({ state: "offline", detail: "Desktop host not connected." });
    return () => {};
  }
}
declare global { interface Window { rappWork?: DesktopBridge } }
