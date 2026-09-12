import { z } from "zod";
import {
  agentSchema, approvalSchema, artifactSchema, automationSchema, computerSchema, diagnosticsSchema,
  eventPageSchema, providerSchema, rpcParameterSchemas, runSchema, settingsSchema, snapshotSchema, statusSchema,
  taskSchema, twinApplyResultSchema, twinConversationSchema, twinDraftSchema, workspaceListSchema,
  workspaceOpenSchema, workspaceSummarySchema,
} from "../../host/src/contracts.js";

export * from "../../host/src/contracts.js";

const contract = <M extends keyof typeof rpcParameterSchemas, O extends z.ZodType>(method: M, output: O) => ({
  input: rpcParameterSchemas[method], output,
});
export const rpcContracts = {
  "system.status": contract("system.status", statusSchema),
  "workspaces.list": contract("workspaces.list", workspaceListSchema),
  "workspaces.create": contract("workspaces.create", workspaceSummarySchema),
  "workspaces.open": contract("workspaces.open", workspaceOpenSchema),
  "workspaces.update": contract("workspaces.update", workspaceSummarySchema),
  "work.snapshot": contract("work.snapshot", snapshotSchema),
  "work.createTask": contract("work.createTask", taskSchema),
  "work.assignTask": contract("work.assignTask", taskSchema),
  "agents.save": contract("agents.save", agentSchema),
  "runs.start": contract("runs.start", runSchema),
  "runs.cancel": contract("runs.cancel", runSchema),
  "approvals.decide": contract("approvals.decide", approvalSchema),
  "artifacts.read": contract("artifacts.read", z.strictObject({ artifact: artifactSchema, content: z.string().max(1_000_000) })),
  "automations.save": contract("automations.save", automationSchema),
  "settings.update": contract("settings.update", settingsSchema),
  "providers.list": contract("providers.list", providerSchema.array().max(100)),
  "providers.configure": contract("providers.configure", providerSchema),
  "computer.inspect": contract("computer.inspect", computerSchema),
  "computer.start": contract("computer.start", computerSchema),
  "computer.stop": contract("computer.stop", computerSchema),
  "diagnostics.get": contract("diagnostics.get", diagnosticsSchema),
  "events.read": contract("events.read", eventPageSchema),
  "events.subscribe": contract("events.subscribe", eventPageSchema.extend({ subscriptionId: z.uuid() })),
  "events.unsubscribe": contract("events.unsubscribe", z.strictObject({ removed: z.boolean() })),
  "twin.message": contract("twin.message", twinDraftSchema),
  "twin.conversation": contract("twin.conversation", twinConversationSchema),
  "twin.applyProposal": contract("twin.applyProposal", twinApplyResultSchema),
  "twin.dismissProposal": contract("twin.dismissProposal", twinConversationSchema),
} as const;
export type RpcMethod = keyof typeof rpcContracts;
export type RpcInput<M extends RpcMethod> = z.input<(typeof rpcContracts)[M]["input"]>;
export type RpcResult<M extends RpcMethod> = z.output<(typeof rpcContracts)[M]["output"]>;
