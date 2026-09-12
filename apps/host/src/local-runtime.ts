import { z } from "zod";
import { AgentRuntime, type AuthorizedTool, type RunResult } from "@rapp-work/agent-runtime";
import { GitHubCopilotProvider, type ManagedCopilotTransport } from "@rapp-work/model-provider";
import { canonicalJson, type JsonObject } from "@rapp-work/rapp1";
import { operationHash, type OperationRequest } from "@rapp-work/security";
import type { AuthorizedEffectContext, EffectOutcome } from "@rapp-work/work-service";
import {
  approvalSchema, runSchema, type Agent, type Approval, type AutomationInput, type Run, type Settings, type Task,
} from "./contracts.js";
import type { ProviderPort, RequestContext, RuntimePort } from "./ports.js";
import { conflict, HostError, unavailable } from "./errors.js";
import { agentScope, commandKey, digestBytes, LocalWork } from "./local-work.js";
import { committed, digest, json, LocalPersistence, proofReceipt } from "./persistence.js";
import { LocalComputer } from "./local-computer.js";

const relativePath = z.string().min(1).max(512).refine((value) =>
  !value.startsWith("/") && !/[\\%\u0000-\u001f\u007f]/.test(value)
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const executeInput = z.strictObject({
  argv: z.array(z.string().max(8192).refine((value) => !value.includes("\0"))).min(1).max(64)
    .refine((value) => value[0]!.length > 0),
  cwd: z.union([z.literal("."), relativePath]).default("."),
  timeoutMs: z.number().int().min(1).max(30_000).default(30_000),
});
const readInput = z.strictObject({ path: relativePath });
interface Active {
  readonly controller: AbortController;
  readonly agent: Agent;
  readonly task: Task;
  run: Run;
  promise: Promise<void>;
}
interface Waiting {
  readonly active: Active;
  resolve(decision: "approved" | "denied" | "cancelled"): void;
}
const noEffect = (status: "cancelled" | "denied", reason: string): EffectOutcome => ({
  status, value: { code: reason }, receipts: [{ kind: "no-effect", reason }], events: [],
});

export class LocalRuntime implements RuntimePort {
  private readonly active = new Map<string, Active>();
  private readonly waiting = new Map<string, Waiting>();
  private scheduleTimer: ReturnType<typeof setInterval> | undefined;
  private scheduling: Promise<void> | undefined;
  private scheduleProvider: ProviderPort | undefined;
  private closed = false;
  constructor(
    private readonly persistence: LocalPersistence, private readonly work: LocalWork,
    private readonly transport: ManagedCopilotTransport, private readonly computer: LocalComputer,
  ) {}
  async check() {
    if (this.closed) return { state: "unavailable" as const, detail: "Runtime is closing." };
    const persistence = await this.persistence.check();
    if (persistence.state !== "ready") return persistence;
    return { state: "ready" as const, detail: "Bounded per-agent runtimes with canonical model/tool history and cancellation." };
  }
  async start(context: RequestContext, input: { runId: string; task: Task; agent: Agent; settings: Settings }): Promise<Run> {
    this.work.assertContext(context);
    if (this.closed || this.active.size >= 4) conflict("The bounded runtime is busy.");
    if (!input.agent.enabled || input.task.agentId !== input.agent.id || input.task.workspaceId !== input.agent.workspaceId) {
      conflict("An enabled agent in this task's own workspace is required.");
    }
    if ([...this.active.values()].some((item) => item.agent.workspaceId === input.agent.workspaceId)) conflict("This agent already has an active run.");
    if (input.agent.computerPolicy !== "none") {
      const computer = await this.computer.inspect(context);
      if (computer.state !== "running" || !computer.verified) unavailable("The agent's verified Omarchy computer");
    }
    const scope = agentScope(input.agent);
    const p = this.persistence;
    const active: Active = {
      controller: new AbortController(), agent: structuredClone(input.agent), task: structuredClone(input.task),
      run: {
        id: input.runId, taskId: input.task.id, agentId: input.agent.id, workspaceId: input.agent.workspaceId,
        state: "running", startedAt: new Date().toISOString(), finishedAt: null,
        summary: "The agent accepted this task in its private workspace.", verification: "not_checked", evidenceIds: [],
      },
      promise: Promise.resolve(),
    };
    this.active.set(input.runId, active);
    try {
      const accepted = await p.commit(scope, `run/accept/${input.runId}`, "host.run.accept", {
        runId: input.runId, taskId: input.task.id, agent: json(input.agent), instructions: input.task.instructions,
      }, async () => ({
        status: "succeeded", value: json(active.run), receipts: [{ kind: "run-accepted" }],
        events: [{ type: "ui.run.saved", run: json(active.run) }],
      }), [{ kind: "task", id: input.task.id }, { kind: "run", id: input.runId }]);
      const saved = committed(accepted);
      active.run = runSchema.parse(saved.value);
      if (accepted.replayed) { this.active.delete(input.runId); return active.run; }
      const capability = await p.capability(scope, [
        `task:${input.task.id}`, `run:${input.runId}`, "computer:omarchy",
      ]);
      const engine = new AgentRuntime({
        work: p.work, provider: new GitHubCopilotProvider(this.transport),
        tools: [this.tool("guest.read", active), this.tool("guest.execute", active)],
        limits: { maxConcurrentRuns: 1, maxConcurrentTools: 1, maxStepsPerRun: 12,
          maxToolCallsPerRun: 12, maxDurationMs: 300_000, maxOutputTokens: 8192 },
      });
      active.promise = (async () => {
        try {
          const result = await engine.run(capability, {
            scope, taskId: input.task.id, runId: input.runId, input: input.task.instructions, signal: active.controller.signal,
          });
          await this.finish(active, result);
        } catch {
          await this.work.saveRun({
            ...active.run, state: "unresolved", verification: "not_checked",
            summary: "Execution or terminal persistence could not be confirmed. This run will not be replayed.",
          }, `run/unresolved/${input.runId}`).catch(() => {});
        } finally {
          if (engine.activeRunCount === 0) this.active.delete(input.runId);
          else void engine.settlePending().then(() => { this.active.delete(input.runId); });
        }
      })();
      return active.run;
    } catch (error) { this.active.delete(input.runId); throw error; }
  }
  private tool(name: "guest.read" | "guest.execute", active: Active): AuthorizedTool {
    const schema = name === "guest.read" ? readInput : executeInput;
    return {
      description: {
        name, description: name === "guest.read" ? "Read a text file in this agent's Omarchy guest workspace."
          : "Execute an argv command in this agent's isolated Omarchy guest workspace. Requires exact owner approval.",
        inputSchema: JSON.parse(JSON.stringify(z.toJSONSchema(schema, { io: "input" }))) as JsonObject,
      },
      validate: (input) => { schema.parse(input); },
      execute: async (input, context) => {
        const parsed = name === "guest.read" ? readInput.parse(input) : executeInput.parse(input);
        const execution = "path" in parsed
          ? { argv: ["/usr/bin/head", "-c", "65536", "--", `/workspace/${parsed.path}`], cwd: ".", timeoutMs: 10_000, readOnly: true }
          : { ...parsed, readOnly: false };
        if (context.scope.agentId !== active.agent.id || context.scope.workspaceId !== active.agent.workspaceId
          || context.taskId !== active.task.id || context.runId !== active.run.id
          || (active.agent.computerPolicy !== "control" && name !== "guest.read") || active.agent.computerPolicy === "none") {
          return noEffect("denied", "tool_policy_denied");
        }
        return this.executeTool(active, context, execution);
      },
    };
  }
  private async executeTool(
    active: Active, context: AuthorizedEffectContext,
    execution: { argv: string[]; cwd: string; timeoutMs: number; readOnly: boolean },
  ): Promise<EffectOutcome> {
    const p = this.persistence, scope = agentScope(active.agent);
    const approvalRequired = active.agent.approvalPolicy === "always" || !execution.readOnly;
    const request: OperationRequest = {
      schema: "rapp-work/operation/1", operation_id: context.commandHash,
      principal_id: p.owner.id, agent_id: scope.agentId, workspace_id: scope.workspaceId,
      task_id: active.task.id, run_id: active.run.id,
      operation: execution.readOnly ? "guest.files.read" : "guest.shell",
      resources: [`agent:${scope.agentId}`, "computer:omarchy", `run:${active.run.id}`, `task:${active.task.id}`, `workspace:${scope.workspaceId}`].sort(),
      params: { ...execution, approvalRequired }, expires_utc: new Date(Date.now() + 300_000).toISOString(),
    };
    const capability = await p.capability(scope, request.resources);
    const approvalId = approvalRequired ? `approval-${context.commandHash.slice(0, 32)}` : null;
    if (approvalId) {
      const decision = await this.waitForApproval(active, context, request, approvalId);
      if (decision !== "approved") return noEffect(decision, decision === "cancelled" ? "cancelled_before_guest" : "owner_denied");
      if (context.signal.aborted) return noEffect("cancelled", "cancelled_before_guest");
      active.run = await this.work.saveRun({ ...active.run, state: "running", summary: "The exact approved action is being authorized." },
        `run/resume/${context.commandHash}`);
    }
    if (context.signal.aborted) return noEffect("cancelled", "cancelled_before_guest");
    const subject = `intent:${scope.agentId}/${context.commandHash}`;
    const intent = await p.appendSecurity(scope, capability, {
      type: "intent.accepted", agent_id: scope.agentId, workspace_id: scope.workspaceId,
      task_id: active.task.id, run_id: active.run.id, intent_id: context.commandHash, request, approval_id: approvalId,
    }, subject, [operationHash(request), context.intentRef]);
    const source = intent.memory.frames.find((frame) => frame.frame_hash === intent.sourceFrameHash)!;
    const permit = await p.security.issuePermit(capability, {
      request, intent, approvalId,
      commit: async (reservation) => {
        const latest = await (await p.workspace(scope, capability)).scan();
        return p.appendSecurity(scope, capability, reservation.payload.data as JsonObject,
          String(reservation.payload.subject), [source.frame_hash, source.payload_hash, operationHash(request)],
          { ...latest.heads, body: reservation.expectedBodyHead, memory: reservation.expectedMemoryHead });
      },
    });
    if (context.signal.aborted) return noEffect("cancelled", "cancelled_before_guest");
    const claims = p.security.consumePermit(permit, request);
    const result = await this.computer.execute(claims, scope, execution, context, active.task.id, active.run.id);
    const outcome = await p.appendSecurity(scope, capability, {
      type: "outcome.recorded", agent_id: scope.agentId, workspace_id: scope.workspaceId,
      task_id: active.task.id, run_id: active.run.id, intent_id: context.commandHash,
      intent_frame_hash: source.frame_hash, permit_id: claims.permitId, operation_hash: operationHash(request),
      status: result.status === "succeeded" ? "success" : result.status === "cancelled" ? "cancelled" : "error", result: result.value,
      error: result.status === "succeeded" ? null : result.status === "cancelled" ? "cancelled_before_guest" : "guest_action_failed",
      reference_hashes: result.receipts.flatMap((receipt) => typeof receipt.evidenceRef === "string" ? [receipt.evidenceRef] : []).sort(),
    }, subject, [source.frame_hash, claims.consumptionFrameHash]);
    return { ...result, receipts: [...result.receipts, {
      kind: "security-outcome", sourceFrameHash: outcome.sourceFrameHash, evidenceRef: outcome.evidenceFrameHash,
    }] };
  }
  private async waitForApproval(
    active: Active, context: AuthorizedEffectContext, request: OperationRequest, approvalId: string,
  ): Promise<"approved" | "denied" | "cancelled"> {
    const p = this.persistence, scope = agentScope(active.agent);
    const approval: Approval = {
      id: approvalId, runId: active.run.id, taskId: active.task.id, agentId: scope.agentId, workspaceId: scope.workspaceId,
      operationHash: operationHash(request), expiresAt: request.expires_utc, consumedBy: null,
      action: request.operation === "guest.shell" ? "Execute in the agent's guest workspace" : "Read the agent's guest file",
      reason: JSON.stringify(request.params).slice(0, 4000), risk: request.operation === "guest.shell" ? "high" : "low",
      state: "pending", createdAt: new Date().toISOString(), decidedAt: null, decisionReason: "",
    };
    const waitingRun: Run = { ...active.run, state: "awaiting_approval", summary: "Waiting for the owner's approval of one exact action." };
    let resolve!: Waiting["resolve"];
    const waiting = new Promise<"approved" | "denied" | "cancelled">((done) => { resolve = done; });
    this.waiting.set(approvalId, { active, resolve });
    const cancel = () => resolve("cancelled");
    context.signal.addEventListener("abort", cancel, { once: true });
    try {
      committed(await p.commit(scope, `approval/request/${context.commandHash}`, "host.approval.request", { request }, async (): Promise<EffectOutcome> => {
        const proof = await p.appendSecurity(scope, await p.capability(scope), {
          type: "approval.requested", agent_id: scope.agentId, workspace_id: scope.workspaceId,
          task_id: active.task.id, approval_id: approvalId, principal_id: p.owner.id,
          operation_hash: operationHash(request), resources: request.resources, expires_utc: request.expires_utc,
        }, `approval:${scope.agentId}/${approvalId}`);
        return {
          status: "succeeded", value: json(approval),
          receipts: [{ kind: "approval-request", sourceFrameHash: proof.sourceFrameHash, evidenceRef: proof.evidenceFrameHash }],
          events: [{ type: "ui.approval.saved", approval: json(approval) }, { type: "ui.run.saved", run: json(waitingRun) }],
        };
      }, [{ kind: "task", id: active.task.id }, { kind: "run", id: active.run.id }]));
      active.run = waitingRun;
      if (context.signal.aborted) cancel();
      return await waiting;
    } finally {
      this.waiting.delete(approvalId); context.signal.removeEventListener("abort", cancel);
    }
  }
  async decide(context: RequestContext, input: { approval: Approval; decision: "approved" | "denied"; reason: string }): Promise<void> {
    this.work.assertContext(context);
    const approval = approvalSchema.parse(input.approval);
    const waiter = this.waiting.get(approval.id);
    if (!waiter || waiter.active.run.id !== approval.runId || waiter.active.agent.id !== approval.agentId
      || waiter.active.agent.workspaceId !== approval.workspaceId || waiter.active.controller.signal.aborted
      || approval.state !== "pending" || Date.parse(approval.expiresAt) <= Date.now()) conflict("This approval is not active or has expired.");
    const p = this.persistence, scope = { agentId: approval.agentId, workspaceId: approval.workspaceId };
    const decided: Approval = { ...approval, state: input.decision, decisionReason: input.reason, decidedAt: new Date().toISOString() };
    committed(await p.commit(scope, `approval/decide/${approval.id}`, "host.approval.decide",
      { approvalId: approval.id, decision: input.decision, reason: input.reason }, async () => {
        const proof = await p.appendSecurity(scope, await p.capability(scope), {
          type: "approval.decided", agent_id: scope.agentId, workspace_id: scope.workspaceId,
          task_id: approval.taskId, approval_id: approval.id, decision: input.decision, decided_by: p.owner.id,
        }, `approval:${scope.agentId}/${approval.id}`);
        return {
          status: "succeeded", value: json(decided),
          receipts: [{ kind: "approval-decision", sourceFrameHash: proof.sourceFrameHash, evidenceRef: proof.evidenceFrameHash }],
          events: [{ type: "ui.approval.saved", approval: json(decided) }],
        };
      }, [{ kind: "task", id: approval.taskId }, { kind: "run", id: approval.runId }]));
    waiter!.resolve(input.decision);
  }
  async cancel(context: RequestContext, run: Run): Promise<Run> {
    this.work.assertContext(context);
    if (run.state === "cancelled" || run.state === "unresolved") return run;
    const active = this.active.get(run.id);
    if (!active || active.agent.id !== run.agentId || active.agent.workspaceId !== run.workspaceId) conflict("This run is not active in this workspace.");
    const p = this.persistence;
    committed(await p.commit(agentScope(active!.agent), commandKey("run/cancel", context), "host.run.cancel",
      { runId: run.id }, async () => {
        active!.controller.abort("owner_cancelled");
        return { status: "succeeded", value: { runId: run.id }, receipts: [{ kind: "cancellation-requested" }], events: [] };
      }, [{ kind: "task", id: run.taskId }, { kind: "run", id: run.id }]));
    await active!.promise;
    return (await this.work.snapshot(context)).runs.find((item) => item.id === run.id)!;
  }
  private async finish(active: Active, result: RunResult): Promise<void> {
    const p = this.persistence, scope = agentScope(active.agent);
    const history = await p.read(scope);
    const commands = history.commands.filter((item) => item.command.resources.some((resource) => resource.kind === "run" && resource.id === active.run.id));
    const evidenceIds = commands.flatMap((item) => item.state === "committed" ? [item.proof.evidenceRef] : []).slice(-200);
    const evidence = Buffer.from(canonicalJson({
      schema: "rapp-work/run-evidence/1", agentId: scope.agentId, workspaceId: scope.workspaceId,
      taskId: active.task.id, runId: active.run.id, heads: json(history.heads),
      commands: commands.map((item) => ({
        state: item.state, operation: item.command.operation, commandHash: item.commandHash,
        ...(item.state === "committed" ? { status: item.status, proof: json(item.proof) } : { intentRef: item.intentRef }),
      })),
    }));
    const files = [
      { id: `evidence-${active.run.id}`, name: "Run evidence", mediaType: "application/json" as const, evidence: true, bytes: evidence },
      ...(result.output === undefined ? [] : [{
        id: `result-${active.run.id}`, name: "Task result", mediaType: "text/plain" as const, evidence: false, bytes: Buffer.from(result.output),
      }]),
    ];
    const run: Run = {
      ...active.run, state: result.status === "succeeded" ? "completed" : result.status,
      finishedAt: result.status === "unresolved" ? null : new Date().toISOString(),
      summary: (result.output ?? result.reason ?? result.status).slice(0, 4000),
      verification: result.status === "succeeded" && evidenceIds.length > 0 ? "passed" : "not_checked", evidenceIds,
    };
    const saved = committed(await p.commit(scope, `run/finalize/${run.id}`, "host.run.finish", { result: json(result) }, async () => {
      const workspace = await p.workspace(scope);
      const events: JsonObject[] = [], receipts: JsonObject[] = [];
      for (const file of files) {
        if (file.bytes.length > 1_000_000) throw new Error("Run artifact exceeds its bound.");
        const written = await workspace.writeArtifact(workspace.artifact(`${file.id}.data`, ["write"]), file.bytes);
        if (written.sha256 !== digestBytes(file.bytes)) throw new Error("Artifact read-back failed.");
        const artifact = {
          id: file.id, name: file.name, mediaType: file.mediaType, evidence: file.evidence,
          taskId: run.taskId, runId: run.id, agentId: run.agentId, workspaceId: run.workspaceId,
          bytes: written.bytes, sha256: written.sha256, createdAt: new Date().toISOString(),
        };
        events.push({ type: "ui.artifact.saved", artifact: json(artifact) });
        receipts.push({ kind: "artifact-read-back", artifactId: file.id, sha256: written.sha256, bytes: written.bytes });
      }
      events.push({ type: "ui.run.saved", run: json(run) });
      return { status: "succeeded", value: json(run), events, receipts };
    }, [{ kind: "task", id: run.taskId }, { kind: "run", id: run.id }]));
    active.run = runSchema.parse(saved.value);
  }
  async schedule(context: RequestContext, automation: AutomationInput): Promise<{ nextRunAt: string | null }> {
    this.work.assertContext(context);
    if (this.closed) throw new HostError(-32011, "Runtime is closing.");
    return { nextRunAt: automation.enabled ? nextSchedule(automation, Date.now()).toISOString() : null };
  }
  private ownerContext(requestId: string): RequestContext {
    const owner = this.persistence.owner;
    return { principal: { id: owner.id, workspaceId: owner.catalog.workspaceId, permissions: [] }, requestId };
  }
  async activateScheduling(provider: ProviderPort): Promise<void> {
    if (this.scheduleTimer || this.closed) return;
    this.scheduleProvider = provider;
    const now = Date.now();
    const current = await this.work.snapshot(this.ownerContext("schedule-startup"));
    for (const automation of current.automations.filter((item) => item.enabled && item.nextRunAt && Date.parse(item.nextRunAt) <= now)) {
      committed(await this.persistence.commit({ agentId: automation.agentId, workspaceId: automation.workspaceId },
        `automation/missed/${automation.id}/${automation.nextRunAt}`, "host.automation.missed",
        { id: automation.id, missedAt: automation.nextRunAt }, async () => ({
          status: "succeeded", value: { skipped: true }, receipts: [{ kind: "no-effect", reason: "missed_while_host_offline" }],
          events: [{ type: "ui.automation.saved", automation: json({
            ...automation, nextRunAt: nextSchedule(automation, now).toISOString(), updatedAt: new Date().toISOString(),
          }) }],
        })));
    }
    this.scheduleTimer = setInterval(() => { void this.tickSchedules().catch(() => {}); }, 15_000);
    this.scheduleTimer.unref();
  }
  async tickSchedules(now = Date.now()): Promise<void> {
    if (this.closed || !this.scheduleProvider) return;
    if (this.scheduling) return this.scheduling;
    this.scheduling = (async () => {
      const p = this.persistence;
      const snapshot = await this.work.snapshot(this.ownerContext("schedule-scan"));
      for (const automation of snapshot.automations.filter((item) => item.enabled && item.nextRunAt && Date.parse(item.nextRunAt) <= now)) {
        if (this.closed) return;
        const scope = { agentId: automation.agentId, workspaceId: automation.workspaceId };
        const key = `automation/fire/${automation.id}/${automation.nextRunAt}`;
        const hex = digest(key);
        const taskId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
        const context = this.ownerContext(key);
        const fired = await p.commit(scope, key, "host.automation.fire", { automation: json(automation), taskId },
          async (): Promise<EffectOutcome> => {
            const task = await this.work.createTask(context, {
              requestId: taskId, title: automation.taskTitle, instructions: automation.instructions,
              agentId: automation.agentId, priority: "normal",
            });
            let run: Run | undefined;
            try { run = await this.work.startRun(context, task.id, this, this.scheduleProvider!); }
            catch (error) {
              if (!(error instanceof HostError) || ![-32009, -32011].includes(error.code)) throw error;
            }
            const history = await p.read(scope);
            const receipt = history.commands.find((item) => item.state === "committed"
              && item.command.operation === "task.create" && item.command.resources.some((resource) => resource.kind === "task" && resource.id === task.id));
            if (receipt?.state !== "committed") throw new Error("Scheduled task has no canonical creation proof.");
            return {
              status: "succeeded", value: { taskId: task.id, runId: run?.id ?? null },
              receipts: [proofReceipt(receipt), { kind: run ? "scheduled-run-accepted" : "schedule-paused", runId: run?.id ?? null }],
              events: [{ type: "ui.automation.saved", automation: json({
                ...automation, enabled: Boolean(run), nextRunAt: run ? nextSchedule(automation, now).toISOString() : null,
                updatedAt: new Date().toISOString(),
              }) }],
            };
          }, [{ kind: "task", id: taskId }]);
        if (fired.state === "unresolved") {
          committed(await p.commit(scope, `automation/quarantine/${digest(key)}`, "host.automation.quarantine",
            { id: automation.id, commandHash: fired.commandHash }, async () => ({
              status: "succeeded", value: { paused: true }, receipts: [{ kind: "no-replay", commandHash: fired.commandHash }],
              events: [{ type: "ui.automation.saved", automation: json({ ...automation, enabled: false, nextRunAt: null }) }],
            })));
        }
      }
    })();
    try { await this.scheduling; } finally { this.scheduling = undefined; }
  }
  async drain(): Promise<void> { await Promise.all([...this.active.values()].map((item) => item.promise)); }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.scheduleTimer);
    await this.scheduling?.catch(() => {});
    for (const item of this.active.values()) item.controller.abort("host_shutdown");
    await this.drain();
  }
}

export function nextSchedule(automation: AutomationInput, after: number): Date {
  const cadence = automation.cadence;
  if (cadence.kind === "interval") return new Date(after + cadence.minutes * 60_000);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: cadence.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let time = Math.floor(after / 60_000) * 60_000 + 60_000; time <= after + 8 * 86_400_000; time += 60_000) {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]));
    if (`${parts.hour}:${parts.minute}` === cadence.at && (cadence.kind === "daily" || parts.weekday === weekdays[cadence.weekday])) return new Date(time);
  }
  throw new Error("No bounded schedule occurrence.");
}
