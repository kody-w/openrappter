import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentInputSchema, agentSchema, approvalDecisionSchema, approvalSchema, artifactSchema,
  automationInputSchema, automationSchema, checkSchema, computerSchema, diagnosticsSchema,
  emptySchema, entityParamsSchema, eventPageSchema, eventReadSchema, idSchema, providerConfigSchema,
  providerSchema, runSchema, serviceNames, settingsSchema, snapshotSchema, statusSchema,
  taskInputSchema, taskSchema, type Area, type Status,
  conciergeBindingSchema, twinApplyRequestSchema, twinApplyResultSchema, twinConversationSchema,
  twinDismissRequestSchema, twinDraftSchema, twinMessageRequestSchema,
  workspaceDetailsSchema, workspaceInputSchema, workspaceListSchema, workspaceOpenSchema, workspaceSummarySchema,
  workspaceChildrenSchema, workspaceTreeSchema, workspaceBreadcrumbSchema,
} from "./contracts.js";
import type { HostServices, Permission, RequestContext } from "./ports.js";
import { HostError } from "./errors.js";
import { EventJournal } from "./events.js";

export interface SubscriptionConnection {
  subscribe(input: z.infer<typeof eventReadSchema>, context: RequestContext): Promise<{ subscriptionId: string; events: unknown[]; cursor: string }>;
  unsubscribe(id: string, context: RequestContext): { removed: boolean };
}
interface Method {
  permission: Permission;
  execute(params: unknown, context: RequestContext, connection?: SubscriptionConnection): Promise<unknown>;
}
export async function statusOf(services: HostServices): Promise<Status> {
  const checks = await Promise.all(serviceNames.map(async (name) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        name === "provider" ? Promise.all([services.provider.check(), services.twin.check()])
          .then((checks) => checks.find((check) => check.state === "unavailable")
            ?? checks.find((check) => check.state !== "ready") ?? checks[0]!) : services[name].check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Check timed out.")), 3000);
          timer.unref();
        }),
      ]);
      return [name, checkSchema.parse(result)] as const;
    } catch { return [name, { state: "unavailable" as const, detail: "Service health could not be confirmed." }] as const; }
    finally { clearTimeout(timer); }
  }));
  return statusSchema.parse({
    product: "RAPP Work", protocolVersion: 1,
    ready: checks.every(([, check]) => check.state === "ready"), checks: Object.fromEntries(checks),
  });
}
export function createMethods(services: HostServices, journal: EventJournal): Map<string, Method> {
  const methods = new Map<string, Method>();
  function add<I extends z.ZodType, O extends z.ZodType>(
    name: string, permission: Permission, input: I, output: O,
    action: (params: z.output<I>, context: RequestContext, connection?: SubscriptionConnection) => unknown | Promise<unknown>,
    changed?: { area: Area; entity: (result: z.output<O>, params: z.output<I>) => string; kind: "created" | "updated" },
  ) {
    methods.set(name, {
      permission,
      async execute(raw, context, connection) {
        const parsed = input.safeParse(raw ?? {});
        if (!parsed.success) throw new HostError(-32602, "Invalid method parameters.");
        const result = output.parse(await action(parsed.data, context, connection));
        const binding = (parsed.data as { workspaceId?: unknown })?.workspaceId;
        if (changed) journal.publish(typeof binding === "string" ? binding : context.principal.workspaceId, {
          id: randomUUID(), area: changed.area, entityId: changed.entity(result, parsed.data),
          kind: changed.kind, at: new Date().toISOString(),
        });
        return result;
      },
    });
  }
  async function bind(context: RequestContext, workspaceId: string | null, permission: Permission): Promise<RequestContext> {
    if (!await services.security.authorizeWorkspace(context.principal, workspaceId, permission)) {
      throw new HostError(-32003, "Permission denied for this workspace.");
    }
    return { ...context, workspaceId };
  }
  function scoped<I extends z.ZodObject, O extends z.ZodType>(
    name: string, permission: Permission, input: I, output: O,
    action: (params: z.output<I>, context: RequestContext, connection?: SubscriptionConnection) => unknown | Promise<unknown>,
    changed?: { area: Area; entity: (result: z.output<O>, params: z.output<I>) => string; kind: "created" | "updated" },
    allowConcierge = false,
  ) {
    const schema = z.strictObject({ ...input.shape, workspaceId: allowConcierge ? idSchema.nullable() : idSchema });
    add(name, permission, schema, output, async (params, context, connection) => {
      const { workspaceId, ...fields } = params;
      return action(input.parse(fields), await bind(context, workspaceId, permission), connection);
    }, changed ? { ...changed, entity: (result, params) => {
      const { workspaceId: _workspaceId, ...fields } = params;
      return changed.entity(result, input.parse(fields));
    } } : undefined);
  }
  async function aggregateRead(context: RequestContext): Promise<void> {
    for (const permission of ["work:read", "agents:read", "automations:read", "settings:read"] as const) {
      if (!await services.security.authorize(context.principal, permission)
        || !await services.security.authorizeWorkspace(context.principal, context.workspaceId!, permission)) {
        throw new HostError(-32003, "Permission denied.");
      }
    }
  }
  add("system.status", "diagnostics:read", emptySchema, statusSchema, () => statusOf(services));
  add("workspaces.list", "work:read", emptySchema, workspaceListSchema,
    async (_, context) => services.work.listWorkspaces(await bind(context, null, "work:read")));
  add("workspaces.create", "work:write", workspaceInputSchema, workspaceSummarySchema,
    async (input, context) => {
      const selected = await bind(context, null, "work:write");
      for (const permission of ["agents:write", "automations:write", "settings:write"] as const) {
        if (!await services.security.authorize(context.principal, permission)) throw new HostError(-32003, "Permission denied.");
        await bind(context, null, permission);
      }
      return services.work.createWorkspace(selected, input);
    }, { area: "work", entity: (workspace) => workspace.id, kind: "created" });
  scoped("workspaces.update", "settings:write", workspaceDetailsSchema, workspaceSummarySchema,
    (input, context) => services.work.updateWorkspace(context, input),
    { area: "settings", entity: (workspace) => workspace.id, kind: "updated" });
  scoped("workspaces.children", "work:read", emptySchema, workspaceChildrenSchema, (_, context) => services.work.children(context));
  scoped("workspaces.breadcrumb", "work:read", emptySchema, workspaceBreadcrumbSchema, (_, context) => services.work.breadcrumb(context));
  add("workspaces.tree", "work:read", conciergeBindingSchema, workspaceTreeSchema,
    async (input, context) => services.work.tree(await bind(context, input.workspaceId, "work:read")));
  scoped("workspaces.open", "work:read", emptySchema, workspaceOpenSchema, async (_, context) => {
    await aggregateRead(context);
    if (!await services.security.authorize(context.principal, "computer:read")) throw new HostError(-32003, "Permission denied.");
    await bind(context, context.workspaceId!, "computer:read");
    const [workspace, snapshot, twin, computer, breadcrumb] = await Promise.all([
      services.work.workspace(context), services.work.snapshot(context), services.twin.conversation(context), services.computer.inspect(context),
      services.work.breadcrumb(context),
    ]);
    if (workspace.id !== context.workspaceId || snapshot.workspaceId !== context.workspaceId || twin.workspaceId !== context.workspaceId) {
      throw new Error("Service scope mismatch.");
    }
    return { workspace, snapshot, twin, routines: snapshot.automations, computer, breadcrumb };
  });
  scoped("work.snapshot", "work:read", emptySchema, snapshotSchema, async (_, context) => {
    await aggregateRead(context);
    const result = await services.work.snapshot(context);
    if (result.workspaceId !== context.workspaceId) throw new Error("Service scope mismatch.");
    return result;
  });
  scoped("work.createTask", "work:write", taskInputSchema, taskSchema,
    (input, context) => services.work.createTask(context, input),
    { area: "work", entity: (task) => task.id, kind: "created" });
  scoped("work.assignTask", "work:write", z.strictObject({ id: idSchema, agentId: idSchema }), taskSchema,
    (input, context) => services.work.assignTask(context, input),
    { area: "work", entity: (task) => task.id, kind: "updated" });
  scoped("agents.save", "agents:write", agentInputSchema.extend({ parentRevision: z.number().int().nonnegative().optional() }), agentSchema,
    ({ parentRevision, ...input }, context) => services.work.saveAgent({ ...context, ...(parentRevision !== undefined ? { parentRevision } : {}) }, input),
    { area: "agents", entity: (agent) => agent.id, kind: "updated" });
  scoped("agents.openWorkspace", "agents:read", entityParamsSchema, workspaceSummarySchema,
    ({ id }, context) => services.work.agentWorkspace(context, id));
  scoped("agents.retire", "agents:write", entityParamsSchema.extend({ parentRevision: z.number().int().nonnegative().optional() }), agentSchema,
    ({ id, parentRevision }, context) => services.work.retireAgent({ ...context, ...(parentRevision !== undefined ? { parentRevision } : {}) }, id),
    { area: "agents", entity: (agent) => agent.id, kind: "updated" });
  scoped("runs.start", "runtime:execute", entityParamsSchema, runSchema,
    async ({ id }, context) => {
      if (!await services.security.authorize(context.principal, "work:write")) throw new HostError(-32003, "Permission denied.");
      const workspace = snapshotSchema.parse(await services.work.snapshot(context));
      if (workspace.workspaceId !== context.workspaceId) throw new Error("Service scope mismatch.");
      const task = workspace.tasks.find((item) => item.id === id);
      const agent = workspace.agents.find((item) => item.id === task?.agentId);
      if (agent && agent.computerPolicy !== "none") {
        const permission = agent.computerPolicy === "control" ? "computer:control" : "computer:read";
        if (!await services.security.authorize(context.principal, permission)) throw new HostError(-32003, "Permission denied.");
        const computer = computerSchema.parse(await services.computer.inspect(context));
        if (computer.state !== "running" || !computer.capabilities.view ||
            (agent.computerPolicy === "control" && !computer.capabilities.control)) {
          throw new HostError(-32011, "The agent requires an available computer service.");
        }
      }
      return services.work.startRun(context, id, services.runtime, services.provider);
    }, { area: "work", entity: (run) => run.taskId, kind: "updated" });
  scoped("runs.cancel", "runtime:execute", entityParamsSchema, runSchema,
    async ({ id }, context) => {
      if (!await services.security.authorize(context.principal, "work:write")) throw new HostError(-32003, "Permission denied.");
      return services.work.cancelRun(context, id, services.runtime);
    }, { area: "work", entity: (run) => run.taskId, kind: "updated" });
  scoped("approvals.decide", "work:write", approvalDecisionSchema, approvalSchema,
    (input, context) => services.work.decideApproval(context, input, services.runtime),
    { area: "work", entity: (approval) => approval.taskId, kind: "updated" });
  scoped("artifacts.read", "work:read", entityParamsSchema,
    z.strictObject({ artifact: artifactSchema, content: z.string().max(1_000_000) }).refine(({ artifact, content }) =>
      artifact.bytes === Buffer.byteLength(content) && artifact.sha256 === createHash("sha256").update(content).digest("hex")),
    ({ id }, context) => services.work.readArtifact(context, id));
  scoped("automations.save", "automations:write", automationInputSchema, automationSchema,
    (input, context) => services.work.saveAutomation(context, input, services.runtime),
    { area: "automations", entity: (automation) => automation.id, kind: "updated" });
  scoped("settings.update", "settings:write", settingsSchema, settingsSchema,
    (input, context) => services.work.updateSettings(context, input),
    { area: "settings", entity: () => "workspace", kind: "updated" });
  scoped("providers.list", "settings:read", emptySchema, providerSchema.array().max(100),
    (_, context) => services.provider.list(context), undefined, true);
  scoped("providers.configure", "settings:write", providerConfigSchema, providerSchema,
    (input, context) => services.provider.configure(context, input),
    { area: "settings", entity: (provider) => provider.id, kind: "updated" });
  scoped("computer.inspect", "computer:read", emptySchema, computerSchema, (_, context) => services.computer.inspect(context), undefined, true);
  scoped("computer.start", "computer:control", emptySchema, computerSchema,
    (_, context) => services.computer.start(context),
    { area: "work", entity: () => "computer", kind: "updated" });
  scoped("computer.stop", "computer:control", emptySchema, computerSchema,
    (_, context) => services.computer.stop(context),
    { area: "work", entity: () => "computer", kind: "updated" });
  scoped("diagnostics.get", "diagnostics:read", emptySchema, diagnosticsSchema, (_, context) => services.diagnostics.snapshot(context), undefined, true);
  add("twin.message", "work:write", twinMessageRequestSchema, twinDraftSchema,
    async (input, context) => services.twin.message(await bind(context, input.workspaceId, "work:write"), input),
    { area: "work", entity: (proposal) => proposal.id, kind: "created" });
  add("twin.conversation", "work:read", conciergeBindingSchema, twinConversationSchema,
    async (input, context) => services.twin.conversation(await bind(context, input.workspaceId, "work:read")));
  add("twin.applyProposal", "work:write", twinApplyRequestSchema, twinApplyResultSchema,
    async (input, context) => services.twin.applyProposal(await bind(context, input.workspaceId, "work:write"), input),
    { area: "work", entity: (result) => result.id, kind: "updated" });
  add("twin.dismissProposal", "work:write", twinDismissRequestSchema, twinConversationSchema,
    async (input, context) => services.twin.dismissProposal(await bind(context, input.workspaceId, "work:write"), input),
    { area: "work", entity: (_, input) => input.id, kind: "updated" });
  const authorizeScope = async (context: RequestContext, area: Area) => {
    if (!await services.security.authorize(context.principal, `${area}:read`)
      || !await services.security.authorizeWorkspace(context.principal, context.workspaceId!, `${area}:read`)) throw new HostError(-32003, "Permission denied.");
  };
  scoped("events.read", "events:read", eventReadSchema, eventPageSchema, async (input, context) => {
    await authorizeScope(context, input.scope.area);
    return journal.read(context.principal, input.scope, input.cursor, input.limit, context.workspaceId!);
  });
  scoped("events.subscribe", "events:read", eventReadSchema,
    eventPageSchema.extend({ subscriptionId: z.uuid() }), async (input, context, connection) => {
      await authorizeScope(context, input.scope.area);
      if (!connection) throw new HostError(-32600, "Subscriptions require the WebSocket transport.");
      return connection.subscribe(input, context);
    });
  scoped("events.unsubscribe", "events:read", z.strictObject({ subscriptionId: z.uuid() }),
    z.strictObject({ removed: z.boolean() }), ({ subscriptionId }, context, connection) => {
      if (!connection) throw new HostError(-32600, "Subscriptions require the WebSocket transport.");
      return connection.unsubscribe(subscriptionId, context);
    });
  return methods;
}
