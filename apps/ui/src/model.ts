import { z } from "zod";
// This is the pure DTO module, never the host composition or its Node dependencies.
import {
  agentInputSchema, agentSchema, approvalDecisionSchema, approvalSchema, artifactSchema,
  automationInputSchema, automationSchema, computerSchema, diagnosticsSchema, emptySchema,
  entityParamsSchema, eventPageSchema, eventReadSchema, idSchema, providerConfigSchema,
  providerSchema, runSchema, settingsSchema, snapshotSchema, statusSchema, taskInputSchema,
  taskSchema,
} from "../../host/src/contracts.js";

export {
  agentInputSchema, agentSchema, approvalSchema, artifactSchema, automationInputSchema,
  automationSchema, cadenceSchema, checkSchema, computerSchema, diagnosticsSchema,
  areaSchema, eventSchema, providerSchema, runSchema, scopeSchema, serviceNames,
  settingsSchema, snapshotSchema, statusSchema, taskInputSchema, taskSchema,
} from "../../host/src/contracts.js";
export type {
  Agent, AgentInput, Approval, Artifact, Automation, AutomationInput, Computer, Diagnostics,
  Area, EventScope, Provider, Run, Settings, Snapshot, Status, Task, TaskInput,
} from "../../host/src/contracts.js";

export const rpcContracts = {
  "system.status": { input: emptySchema, output: statusSchema },
  "work.snapshot": { input: emptySchema, output: snapshotSchema },
  "work.createTask": { input: taskInputSchema, output: taskSchema },
  "work.assignTask": { input: z.strictObject({ id: idSchema, agentId: idSchema }), output: taskSchema },
  "agents.save": { input: agentInputSchema, output: agentSchema },
  "runs.start": { input: entityParamsSchema, output: runSchema },
  "runs.cancel": { input: entityParamsSchema, output: runSchema },
  "approvals.decide": { input: approvalDecisionSchema, output: approvalSchema },
  "artifacts.read": {
    input: entityParamsSchema,
    output: z.strictObject({ artifact: artifactSchema, content: z.string().max(1_000_000) }),
  },
  "automations.save": { input: automationInputSchema, output: automationSchema },
  "settings.update": { input: settingsSchema, output: settingsSchema },
  "providers.list": { input: emptySchema, output: z.array(providerSchema).max(100) },
  "providers.configure": { input: providerConfigSchema, output: providerSchema },
  "computer.inspect": { input: emptySchema, output: computerSchema },
  "computer.start": { input: emptySchema, output: computerSchema },
  "computer.stop": { input: emptySchema, output: computerSchema },
  "diagnostics.get": { input: emptySchema, output: diagnosticsSchema },
  "events.read": { input: eventReadSchema, output: eventPageSchema },
  "events.subscribe": { input: eventReadSchema, output: eventPageSchema.extend({ subscriptionId: z.uuid() }) },
  "events.unsubscribe": {
    input: z.strictObject({ subscriptionId: z.uuid() }), output: z.strictObject({ removed: z.boolean() }),
  },
} as const;
export type RpcMethod = keyof typeof rpcContracts;
export type RpcInput<M extends RpcMethod> = z.input<(typeof rpcContracts)[M]["input"]>;
export type RpcResult<M extends RpcMethod> = z.output<(typeof rpcContracts)[M]["output"]>;
