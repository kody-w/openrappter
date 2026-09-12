import { z } from "zod";
// This is the pure DTO module, never the host composition or its Node dependencies.
import {
  agentInputSchema, agentSchema, approvalDecisionSchema, approvalSchema, artifactSchema,
  automationInputSchema, automationSchema, computerSchema, diagnosticsSchema, emptySchema,
  entityParamsSchema, eventPageSchema, eventReadSchema, idSchema, providerConfigSchema,
  providerSchema as hostProviderSchema, runSchema, settingsSchema, snapshotSchema, statusSchema, taskInputSchema,
  taskSchema,
} from "../../host/src/contracts.js";
import {
  conciergeBindingSchema, twinApplyRequestSchema, twinApplyResultSchema, twinConversationSchema,
  twinDismissRequestSchema, twinDraftSchema, twinMessageRequestSchema, workspaceBindingSchema,
  workspaceDetailsSchema, workspaceInputSchema, workspaceListSchema, workspaceOpenSchema, workspaceSummarySchema,
} from "./twin-contract";
export * from "./twin-contract";

export {
  idSchema,
  agentInputSchema, agentSchema, approvalSchema, artifactSchema, automationInputSchema,
  automationSchema, cadenceSchema, checkSchema, computerSchema, diagnosticsSchema,
  areaSchema, eventSchema, runSchema, serviceNames,
  settingsSchema, snapshotSchema, statusSchema, taskInputSchema, taskSchema,
} from "../../host/src/contracts.js";
export type {
  Agent, AgentInput, Approval, Artifact, Automation, AutomationInput, Computer, Diagnostics,
  Area, Run, Settings, Snapshot, Status, Task, TaskInput,
} from "../../host/src/contracts.js";
export const scopeSchema = eventReadSchema.shape.scope.extend({ workspaceId: idSchema });
export type EventScope = z.infer<typeof scopeSchema>;
const scopedEventReadSchema = eventReadSchema.extend({ workspaceId: idSchema });
export const providerSchema = hostProviderSchema.extend({
  modelOptions: z.array(z.strictObject({
    model: z.string().min(1).max(160), reasoningEfforts: z.array(z.string().min(1).max(32)).max(16),
    maxContextWindowTokens: z.number().int().positive(),
  })).max(500).optional(),
});
export type Provider = z.infer<typeof providerSchema>;

export const rpcContracts = {
  "system.status": { input: emptySchema, output: statusSchema },
  "workspaces.list": { input: emptySchema, output: workspaceListSchema },
  "workspaces.open": { input: workspaceBindingSchema, output: workspaceOpenSchema },
  "workspaces.create": { input: workspaceInputSchema, output: workspaceSummarySchema },
  "workspaces.update": { input: workspaceDetailsSchema.extend({ workspaceId: idSchema }), output: workspaceSummarySchema },
  "twin.conversation": { input: conciergeBindingSchema, output: twinConversationSchema },
  "twin.message": { input: twinMessageRequestSchema, output: twinDraftSchema },
  "twin.applyProposal": { input: twinApplyRequestSchema, output: twinApplyResultSchema },
  "twin.dismissProposal": { input: twinDismissRequestSchema, output: twinConversationSchema },
  "work.snapshot": { input: workspaceBindingSchema, output: snapshotSchema },
  "work.createTask": { input: taskInputSchema.extend({ workspaceId: idSchema }), output: taskSchema },
  "work.assignTask": { input: z.strictObject({ workspaceId: idSchema, id: idSchema, agentId: idSchema }), output: taskSchema },
  "agents.save": { input: agentInputSchema.extend({ workspaceId: idSchema }), output: agentSchema },
  "runs.start": { input: entityParamsSchema.extend({ workspaceId: idSchema }), output: runSchema },
  "runs.cancel": { input: entityParamsSchema.extend({ workspaceId: idSchema }), output: runSchema },
  "approvals.decide": { input: approvalDecisionSchema.extend({ workspaceId: idSchema }), output: approvalSchema },
  "artifacts.read": {
    input: entityParamsSchema.extend({ workspaceId: idSchema }),
    output: z.strictObject({ artifact: artifactSchema, content: z.string().max(1_000_000) }),
  },
  "automations.save": { input: automationInputSchema.extend({ workspaceId: idSchema }), output: automationSchema },
  "settings.update": { input: settingsSchema.extend({ workspaceId: idSchema }), output: settingsSchema },
  "providers.list": { input: conciergeBindingSchema, output: z.array(providerSchema).max(100) },
  "providers.configure": { input: providerConfigSchema.extend({ workspaceId: idSchema }), output: providerSchema },
  "computer.inspect": { input: conciergeBindingSchema, output: computerSchema },
  "computer.start": { input: workspaceBindingSchema, output: computerSchema },
  "computer.stop": { input: workspaceBindingSchema, output: computerSchema },
  "diagnostics.get": { input: conciergeBindingSchema, output: diagnosticsSchema },
  "events.read": { input: scopedEventReadSchema, output: eventPageSchema },
  "events.subscribe": { input: scopedEventReadSchema, output: eventPageSchema.extend({ subscriptionId: z.uuid() }) },
  "events.unsubscribe": {
    input: z.strictObject({ workspaceId: idSchema, subscriptionId: z.uuid() }), output: z.strictObject({ removed: z.boolean() }),
  },
} as const;
export type RpcMethod = keyof typeof rpcContracts;
export type RpcInput<M extends RpcMethod> = z.input<(typeof rpcContracts)[M]["input"]>;
export type RpcResult<M extends RpcMethod> = z.output<(typeof rpcContracts)[M]["output"]>;
