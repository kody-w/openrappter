import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseCanonicalJson } from "@rapp-work/rapp1";
import {
  ComputerBroker, computerToolOutcome, FileComputerLeaseStore,
  type BrokerRequest, type ComputerLease, type ComputerReceipt,
} from "@rapp-work/computer-broker";
import type { AuthorizedEffectContext, EffectOutcome, WorkspaceScope } from "@rapp-work/work-service";
import type { PermitClaims } from "@rapp-work/security";
import { computerSchema, type Computer } from "./contracts.js";
import type { ComputerPort, RequestContext } from "./ports.js";
import { HostError, unavailable } from "./errors.js";
import { committed, digest, LocalPersistence, proofReceipt } from "./persistence.js";
import { commandKey, digestBytes, LocalWork } from "./local-work.js";
import { computerConfigSchema, NodeFixedCommands, TartSshDrivers, type FixedCommandTransport } from "./computer-drivers.js";

const missing = (detail: string): Computer => ({
  state: "unavailable", detail, verified: false, verifiedAt: null, evidenceIds: [],
  capabilities: { view: false, control: false },
});
interface GuestAuthority {
  readonly scope: WorkspaceScope;
  readonly inputHash: string;
  readonly expiresAt: number;
}

export class LocalComputer implements ComputerPort {
  private drivers: TartSshDrivers | undefined;
  private broker: ComputerBroker | undefined;
  private initializing: Promise<void> | undefined;
  private readonly approved = new Map<string, GuestAuthority>();
  private operations: Promise<unknown> = Promise.resolve();
  private leaseActive = false;
  private operationGeneration = 0;
  private configured = false;
  constructor(
    private readonly persistence: LocalPersistence, private readonly work: LocalWork,
    private readonly commands: FixedCommandTransport = new NodeFixedCommands(),
  ) {}
  private async initialize(): Promise<void> {
    this.initializing ??= (async () => {
      const p = this.persistence;
      const root = p.privateRoot;
      if (await root.stat("computer.json") === null) return;
      const config = computerConfigSchema.parse(parseCanonicalJson(await root.read("computer.json")));
      await root.mkdir("computer");
      const directory = join(p.directory, "computer");
      this.drivers = new TartSshDrivers(directory, config, this.commands, (session, request) => {
        const permit = this.approved.get(session.workspace.workspaceId);
        if (!permit || permit.expiresAt <= Date.now() || digest(permit.scope) !== digest(session.workspace)
          || permit.inputHash !== digest({ argv: request.argv, cwd: request.cwd, timeoutMs: request.timeoutMs, readOnly: request.readOnly ?? false })) {
          throw new Error("The guest operation has no consumed approval-bound security permit.");
        }
        p.consumeGuestTransport(session.permit, session.workspace, session.intentRef, request);
        this.approved.delete(session.workspace.workspaceId);
      });
      this.broker = new ComputerBroker({
        work: p.work, tart: this.drivers.tart, guest: this.drivers.guest,
        leases: new FileComputerLeaseStore(join(directory, "leases")),
        artifacts: {
          read: async (capability, scope, id, maxBytes) => {
            p.assert(capability, p.owner.computer, "artifact.read", [`workspace:${scope.workspaceId}`]);
            const workspace = await p.workspace(scope);
            const bytes = await workspace.readArtifact(workspace.artifact(`${id}.data`, ["read"]));
            if (bytes.length > maxBytes) throw new Error("Artifact limit exceeded.");
            return { bytes, sha256: digestBytes(bytes) };
          },
          write: async () => { throw new Error("No guest artifact transfer capability was issued."); },
        },
        configuration: {
          id: "omarchy", historyScope: p.owner.computer, vmName: config.vmName, image: config.image,
          hostKey: config.hostKey, guestUser: config.guestUser, maxExecutionMs: 30_000,
          configurationRef: digest(config),
          maxLeaseMs: 120_000, maxOutputBytes: 131_072, maxArtifactBytes: 1_000_000,
        },
      });
      this.configured = true;
    })();
    return this.initializing;
  }
  async check() {
    try {
      await this.initialize();
      if (!this.configured) return { state: "unavailable" as const, detail: "Configure computer.json and a local pinned Omarchy template. No guest execution is available." };
      if (!this.leaseActive) {
        const generation = this.operationGeneration;
        const p = this.persistence;
        const leases = await p.privateRoot.stat("computer/leases");
        const held = leases && await p.privateRoot.stat("computer/leases/omarchy.lease");
        const history = await p.read(p.owner.computer);
        if (!this.leaseActive && generation === this.operationGeneration
          && (held || history.commands.some((command) => command.state === "unresolved"))) {
          return { state: "unavailable" as const, detail: "The computer has an orphaned lease or unresolved operation. Review its evidence before explicit recovery." };
        }
      }
      await this.drivers!.check();
      return { state: "ready" as const, detail: "Pinned local Tart and SSH drivers; guest-only execution with an exclusive lease." };
    } catch { return { state: "unavailable" as const, detail: "The pinned Omarchy configuration, local image, SSH identity, or Tart could not be verified." }; }
  }
  async inspect(context: RequestContext): Promise<Computer> {
    this.work.assertContext(context);
    const health = await this.check();
    if (health.state !== "ready") return missing(health.detail);
    try {
      const vm = await this.drivers!.tart.inspect(this.drivers!.config.vmName, AbortSignal.timeout(3000));
      const history = await this.persistence.read(this.persistence.owner.computer);
      const operation = vm?.state === "running" ? "computer.start" : "computer.stop";
      const evidence = [...history.commands].reverse().find((item) =>
        item.state === "committed" && item.status === "succeeded" && item.command.operation === operation);
      const verified = vm?.state === "running" && evidence?.state === "committed";
      return computerSchema.parse({
        state: vm?.state ?? "stopped",
        detail: vm ? "Live Tart state from the application-owned Omarchy computer. Business commands run only in its scoped guest."
          : "A pinned local template is available. Starting will clone it locally; no image will be downloaded.",
        verified, verifiedAt: verified ? new Date().toISOString() : null,
        evidenceIds: evidence?.state === "committed" ? [evidence.proof.evidenceRef] : [],
        capabilities: { view: true, control: true },
      });
    } catch { return missing("The owned VM or its clone provenance could not be verified. No guest execution is available."); }
  }
  private request(context: AuthorizedEffectContext, taskId: string, runId: string, suffix: string): BrokerRequest {
    return { taskId, runId, parentIntentRef: context.intentRef, idempotencyKey: `${context.intentRef}/${suffix}`, signal: context.signal };
  }
  private receiptCommit(receipt: ComputerReceipt) {
    if (receipt.state !== "committed") throw new HostError(-32012, "The computer outcome is unresolved; its lease remains quarantined.");
    return committed(receipt.commit);
  }
  private lease(
    owner: WorkspaceScope, taskId: string, runId: string, context: AuthorizedEffectContext,
    action: (capability: object, lease: ComputerLease) => Promise<ComputerReceipt>,
  ): Promise<EffectOutcome> {
    let began = false, cancelled = context.signal.aborted;
    const noEffect = (status: "denied" | "cancelled", reason: string): EffectOutcome => ({
      status, value: { code: reason }, receipts: [{ kind: "no-effect", reason }], events: [],
    });
    let cancel!: () => void;
    const cancellation = new Promise<EffectOutcome>((resolve) => {
      cancel = () => { if (!began) { cancelled = true; resolve(noEffect("cancelled", "cancelled_before_computer_lease")); } };
    });
    context.signal.addEventListener("abort", cancel, { once: true });
    const operation = this.operations.then(async () => {
      if (cancelled) return noEffect("cancelled", "cancelled_before_computer_lease");
      const health = await this.check();
      if (cancelled || context.signal.aborted) return noEffect("cancelled", "cancelled_before_computer_lease");
      if (health.state !== "ready") return noEffect("denied", "computer_recovery_required");
      began = true; this.leaseActive = true; this.operationGeneration++;
      try { return await this.withLease(owner, taskId, runId, context, action); }
      finally { this.leaseActive = false; this.operationGeneration++; }
    });
    this.operations = operation.then(() => undefined, () => undefined);
    if (cancelled) cancel();
    return Promise.race([operation, cancellation]).finally(() => context.signal.removeEventListener("abort", cancel));
  }
  private async withLease(
    owner: WorkspaceScope, taskId: string, runId: string, context: AuthorizedEffectContext,
    action: (capability: object, lease: ComputerLease) => Promise<ComputerReceipt>,
  ): Promise<EffectOutcome> {
    const p = this.persistence;
    const capability = await p.capability(p.owner.computer, [
      `computer:omarchy`, `agent:${owner.agentId}`, `workspace:${owner.workspaceId}`, `task:${taskId}`, `run:${runId}`,
    ]);
    const acquired = await this.broker!.acquire(capability, owner, this.request(context, taskId, runId, "lease"));
    if (acquired.state !== "acquired") {
      if (acquired.receipt.state === "committed" && acquired.receipt.commit.status !== "succeeded") {
        return computerToolOutcome(acquired.receipt);
      }
      throw new HostError(-32012, "The exclusive computer lease could not be verified.");
    }
    const receipt = await action(capability, acquired.lease);
    if (receipt.state !== "committed") throw new HostError(-32012, "The computer outcome is unresolved; its lease remains quarantined.");
    const released = this.receiptCommit(await this.broker!.release(capability, acquired.lease, {
      ...this.request(context, taskId, runId, "release"), signal: new AbortController().signal,
    }));
    const outcome = computerToolOutcome(receipt);
    return { ...outcome, receipts: [...outcome.receipts, proofReceipt(released)] };
  }
  start(context: RequestContext): Promise<Computer> { return this.control(context, "start"); }
  stop(context: RequestContext): Promise<Computer> { return this.control(context, "stop"); }
  private async control(context: RequestContext, action: "start" | "stop"): Promise<Computer> {
    this.work.assertContext(context);
    if ((await this.check()).state !== "ready") return unavailable("The configured local computer");
    const p = this.persistence;
    const taskId = "computer-control", runId = digest(context.requestId).slice(0, 32);
    committed(await p.commit(p.owner.catalog, commandKey(`computer/${action}`, context), `host.computer.${action}`, { action },
      async (effect) => this.lease(p.owner.catalog, taskId, runId, effect, async (capability, lease) => {
        if (action === "start") {
          this.receiptCommit(await this.broker!.provision(capability, lease, this.request(effect, taskId, runId, "provision")));
          return this.broker!.start(capability, lease, this.request(effect, taskId, runId, "start"));
        }
        return this.broker!.stop(capability, lease, this.request(effect, taskId, runId, "stop"));
      }), [{ kind: "computer", id: "omarchy" }]));
    return this.inspect(context);
  }
  async execute(
    claims: PermitClaims, scope: WorkspaceScope, input: { argv: string[]; cwd: string; timeoutMs: number; readOnly: boolean },
    context: AuthorizedEffectContext, taskId: string, runId: string,
  ): Promise<EffectOutcome> {
    if ((await this.check()).state !== "ready") throw new Error("The computer is unavailable.");
    if (claims.executionLocation !== "guest" || claims.computer !== "omarchy"
      || claims.request.agent_id !== scope.agentId || claims.request.workspace_id !== scope.workspaceId
      || claims.request.task_id !== taskId || claims.request.run_id !== runId || claims.expiresAt <= Date.now()) {
      throw new Error("Guest security permit belongs to different work.");
    }
    if (digest(input) !== digest({
      argv: claims.request.params.argv, cwd: claims.request.params.cwd,
      timeoutMs: claims.request.params.timeoutMs, readOnly: claims.request.params.readOnly,
    })) throw new Error("The guest execution differs from the approved operation.");
    this.persistence.security.claimGuestExecution(claims, claims.request);
    const absolute = input.cwd === "." ? `/workspaces/${scope.workspaceId}` : `/workspaces/${scope.workspaceId}/${input.cwd}`;
    if (this.approved.has(scope.workspaceId)) throw new Error("A guest operation is already in progress for this workspace.");
    this.approved.set(scope.workspaceId, {
      scope, inputHash: digest({ ...input, cwd: absolute }), expiresAt: claims.expiresAt,
    });
    try {
      return await this.lease(scope, taskId, runId, context, (capability, lease) =>
        this.broker!.execute(capability, lease, { ...this.request(context, taskId, runId, "execute"), ...input }));
    } finally { this.approved.delete(scope.workspaceId); }
  }
  async close(): Promise<void> {
    if (!this.configured) return;
    const owner = this.persistence.owner;
    const context: RequestContext = {
      principal: { id: owner.id, workspaceId: owner.catalog.workspaceId, permissions: [] }, requestId: randomUUID(),
    };
    const observed = await this.inspect(context);
    if (observed.state === "running") {
      try { await this.stop(context); } catch { /* Uncertain leases are deliberately not stolen at shutdown. */ }
    }
  }
}
