import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentInputSchema, agentSchema, approvalDecisionSchema, approvalSchema, artifactSchema,
  automationInputSchema, automationSchema, checkSchema, computerSchema, diagnosticsSchema,
  emptySchema, entityParamsSchema, eventPageSchema, eventReadSchema, idSchema, providerConfigSchema,
  providerSchema, runSchema, serviceNames, settingsSchema, snapshotSchema, statusSchema,
  taskInputSchema, taskSchema, type Area, type Status,
} from "./contracts.js";
import type { HostServices, Permission, RequestContext } from "./ports.js";
import { HostError } from "./errors.js";
import { EventJournal } from "./events.js";

export interface SubscriptionConnection {
  subscribe(input: z.infer<typeof eventReadSchema>, context: RequestContext): Promise<{ subscriptionId: string; events: unknown[]; cursor: string }>;
  unsubscribe(id: string): { removed: boolean };
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
        services[name].check(),
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
        if (changed) journal.publish(context.principal.workspaceId, {
          id: randomUUID(), area: changed.area, entityId: changed.entity(result, parsed.data),
          kind: changed.kind, at: new Date().toISOString(),
        });
        return result;
      },
    });
  }
  add("system.status", "diagnostics:read", emptySchema, statusSchema, () => statusOf(services));
  add("work.snapshot", "work:read", emptySchema, snapshotSchema, async (_, context) => {
    // The aggregate includes all four areas; require all four read grants.
    for (const permission of ["agents:read", "automations:read", "settings:read"] as const) {
      if (!await services.security.authorize(context.principal, permission)) throw new HostError(-32003, "Permission denied.");
    }
    const result = await services.work.snapshot(context);
    if (result.workspaceId !== context.principal.workspaceId) throw new Error("Service scope mismatch.");
    return result;
  });
  add("work.createTask", "work:write", taskInputSchema, taskSchema,
    (input, context) => services.work.createTask(context, input),
    { area: "work", entity: (task) => task.id, kind: "created" });
  add("work.assignTask", "work:write", z.strictObject({ id: idSchema, agentId: idSchema }), taskSchema,
    (input, context) => services.work.assignTask(context, input),
    { area: "work", entity: (task) => task.id, kind: "updated" });
  add("agents.save", "agents:write", agentInputSchema, agentSchema,
    (input, context) => services.work.saveAgent(context, input),
    { area: "agents", entity: (agent) => agent.id, kind: "updated" });
  add("runs.start", "runtime:execute", entityParamsSchema, runSchema,
    async ({ id }, context) => {
      if (!await services.security.authorize(context.principal, "work:write")) throw new HostError(-32003, "Permission denied.");
      const workspace = snapshotSchema.parse(await services.work.snapshot(context));
      if (workspace.workspaceId !== context.principal.workspaceId) throw new Error("Service scope mismatch.");
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
  add("runs.cancel", "runtime:execute", entityParamsSchema, runSchema,
    async ({ id }, context) => {
      if (!await services.security.authorize(context.principal, "work:write")) throw new HostError(-32003, "Permission denied.");
      return services.work.cancelRun(context, id, services.runtime);
    }, { area: "work", entity: (run) => run.taskId, kind: "updated" });
  add("approvals.decide", "work:write", approvalDecisionSchema, approvalSchema,
    (input, context) => services.work.decideApproval(context, input, services.runtime),
    { area: "work", entity: (approval) => approval.taskId, kind: "updated" });
  add("artifacts.read", "work:read", entityParamsSchema,
    z.strictObject({ artifact: artifactSchema, content: z.string().max(1_000_000) }).refine(({ artifact, content }) =>
      artifact.bytes === Buffer.byteLength(content) && artifact.sha256 === createHash("sha256").update(content).digest("hex")),
    ({ id }, context) => services.work.readArtifact(context, id));
  add("automations.save", "automations:write", automationInputSchema, automationSchema,
    (input, context) => services.work.saveAutomation(context, input, services.runtime),
    { area: "automations", entity: (automation) => automation.id, kind: "updated" });
  add("settings.update", "settings:write", settingsSchema, settingsSchema,
    (input, context) => services.work.updateSettings(context, input),
    { area: "settings", entity: () => "workspace", kind: "updated" });
  add("providers.list", "settings:read", emptySchema, providerSchema.array().max(100),
    (_, context) => services.provider.list(context));
  add("providers.configure", "settings:write", providerConfigSchema, providerSchema,
    (input, context) => services.provider.configure(context, input),
    { area: "settings", entity: (provider) => provider.id, kind: "updated" });
  add("computer.inspect", "computer:read", emptySchema, computerSchema, (_, context) => services.computer.inspect(context));
  add("computer.start", "computer:control", emptySchema, computerSchema,
    (_, context) => services.computer.start(context),
    { area: "work", entity: () => "computer", kind: "updated" });
  add("computer.stop", "computer:control", emptySchema, computerSchema,
    (_, context) => services.computer.stop(context),
    { area: "work", entity: () => "computer", kind: "updated" });
  add("diagnostics.get", "diagnostics:read", emptySchema, diagnosticsSchema, (_, context) => services.diagnostics.snapshot(context));
  const authorizeScope = async (context: RequestContext, area: Area) => {
    if (!await services.security.authorize(context.principal, `${area}:read`)) throw new HostError(-32003, "Permission denied.");
  };
  add("events.read", "events:read", eventReadSchema, eventPageSchema, async (input, context) => {
    await authorizeScope(context, input.scope.area);
    return journal.read(context.principal, input.scope, input.cursor, input.limit);
  });
  add("events.subscribe", "events:read", eventReadSchema,
    eventPageSchema.extend({ subscriptionId: z.uuid() }), async (input, context, connection) => {
      await authorizeScope(context, input.scope.area);
      if (!connection) throw new HostError(-32600, "Subscriptions require the WebSocket transport.");
      return connection.subscribe(input, context);
    });
  add("events.unsubscribe", "events:read", z.strictObject({ subscriptionId: z.uuid() }),
    z.strictObject({ removed: z.boolean() }), ({ subscriptionId }, _, connection) => {
      if (!connection) throw new HostError(-32600, "Subscriptions require the WebSocket transport.");
      return connection.unsubscribe(subscriptionId);
    });
  return methods;
}
