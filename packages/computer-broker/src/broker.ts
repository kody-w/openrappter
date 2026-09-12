import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";
import type {
  AuthorizedEffectContext, EffectOutcome, JsonObject, JsonValue, WorkCommand, WorkCommitResult, WorkspaceScope,
} from "@rapp-work/work-service";
import {
  ComputerBrokerError, type BrokerRequest, type ComputerBrokerDependencies, type ComputerConfiguration,
  type ComputerLease, type ComputerReceipt, type DownloadRequest, type ExecuteRequest,
  type GuestAcknowledgement, type GuestSession, type HostComputerLease, type LeaseAcquisition,
  type UploadRequest, type VMInspection,
} from "./types.js";
import { bounded, configuration, digest, guestPath, text, validateOwner, validateRequest } from "./validation.js";

interface LeaseState {
  readonly host: HostComputerLease;
  readonly owner: WorkspaceScope;
  readonly expiresAt: number;
  active: boolean;
  quarantined: boolean;
  released: boolean;
  lastKey?: string;
  lastCommand?: WorkCommand;
}

export class ComputerBroker {
  private readonly config: ComputerConfiguration;
  private readonly now: () => number;
  private readonly leases = new WeakMap<ComputerLease, LeaseState>();

  constructor(private readonly dependencies: ComputerBrokerDependencies) {
    if (!dependencies.work || !dependencies.leases || !dependencies.tart
      || !dependencies.guest || !dependencies.artifacts) throw new ComputerBrokerError("missing_mandatory_port");
    this.config = configuration(dependencies.configuration);
    this.now = dependencies.now ?? Date.now;
  }

  private command(
    owner: WorkspaceScope, request: BrokerRequest, operation: string, payload: JsonObject,
  ): WorkCommand {
    return {
      scope: this.config.historyScope, idempotencyKey: request.idempotencyKey, operation,
      payload: {
        computerId: this.config.id, vmName: this.config.vmName, image: this.config.image,
        configurationRef: this.config.configurationRef ?? null,
        hostKey: this.config.hostKey, owner: owner as unknown as JsonValue,
        parentIntentRef: request.parentIntentRef, taskId: request.taskId, runId: request.runId, ...payload,
      },
      resources: [
        { kind: "computer", id: this.config.id }, { kind: "workspace", id: owner.workspaceId },
        { kind: "agent", id: owner.agentId }, { kind: "task", id: request.taskId }, { kind: "run", id: request.runId },
        ...(typeof payload.artifactId === "string" ? [{ kind: "artifact" as const, id: payload.artifactId }] : []),
      ],
    };
  }

  private receipt(commit: WorkCommitResult): ComputerReceipt {
    return commit.state === "committed"
      ? { state: "committed", computerId: this.config.id, commit }
      : { state: "unresolved", computerId: this.config.id, reason: commit.reason, commit };
  }

  async acquire(
    capability: object, requestedOwner: WorkspaceScope, request: BrokerRequest,
  ): Promise<LeaseAcquisition> {
    validateRequest(request);
    const owner = validateOwner(requestedOwner);
    if (owner.workspaceId === this.config.historyScope.workspaceId) throw new ComputerBrokerError("computer_history_is_not_agent_workspace");
    let host: HostComputerLease | undefined;
    const commit = await this.dependencies.work.commit(capability,
      this.command(owner, request, "computer.lease.acquire", {}),
      async () => {
        try { host = await this.dependencies.leases.acquire(this.config.id, owner); }
        catch (error) {
          if (!(error instanceof ComputerBrokerError) || error.code !== "computer_busy") throw error;
          return {
            status: "denied", value: { code: "computer_busy" },
            receipts: [{ kind: "no-effect", reason: "computer_busy" }], events: [],
          };
        }
        if (!text(host.id)) throw new ComputerBrokerError("invalid_host_lease");
        return {
          status: "succeeded", value: { leaseId: host.id }, receipts: [{ kind: "computer-lease", leaseId: host.id }],
          events: [{ type: "computer.lease.acquired", computerId: this.config.id, leaseId: host.id, owner: owner as unknown as JsonValue }],
        };
      }, request.signal ? { signal: request.signal } : {});
    const receipt = this.receipt(commit);
    if (commit.state !== "committed" || commit.status !== "succeeded" || commit.replayed || !host) {
      return { state: "unresolved", receipt };
    }
    const lease = Object.freeze({ id: host.id, computerId: this.config.id }) as ComputerLease;
    this.leases.set(lease, {
      host, owner, expiresAt: this.now() + this.config.maxLeaseMs,
      active: false, quarantined: false, released: false,
    });
    return { state: "acquired", lease, receipt };
  }

  private state(lease: ComputerLease, allowExpired = false): LeaseState {
    const state = this.leases.get(lease);
    if (!state || lease.computerId !== this.config.id || lease.id !== state.host.id) {
      throw new ComputerBrokerError("invalid_lease");
    }
    if (state.released) throw new ComputerBrokerError("lease_released");
    if (state.active) throw new ComputerBrokerError("computer_operation_busy");
    if (state.quarantined) throw new ComputerBrokerError("lease_unresolved");
    if (!allowExpired && this.now() >= state.expiresAt) throw new ComputerBrokerError("lease_expired");
    return state;
  }

  private async perform(
    capability: object, lease: ComputerLease, request: BrokerRequest, operation: string, payload: JsonObject,
    action: (state: LeaseState, context: AuthorizedEffectContext) => Promise<EffectOutcome>,
    allowExpired = false,
  ): Promise<ComputerReceipt> {
    validateRequest(request);
    const boundRequest: BrokerRequest = {
      idempotencyKey: request.idempotencyKey, parentIntentRef: request.parentIntentRef,
      taskId: request.taskId, runId: request.runId,
    };
    const state = this.state(lease, allowExpired);
    request.signal?.throwIfAborted();
    state.active = true;
    state.lastKey = boundRequest.idempotencyKey;
    const command = this.command(state.owner, boundRequest, operation, { leaseId: lease.id, ...structuredClone(payload) });
    state.lastCommand = command;
    const controller = new AbortController();
    const cancel = () => controller.abort("cancelled");
    request.signal?.addEventListener("abort", cancel, { once: true });
    const remaining = allowExpired ? this.config.maxExecutionMs : Math.max(1, state.expiresAt - this.now());
    const requestedTimeout = typeof payload.timeoutMs === "number" ? payload.timeoutMs : this.config.maxExecutionMs;
    const timer = setTimeout(() => controller.abort("deadline_exceeded"), Math.min(this.config.maxExecutionMs, requestedTimeout, remaining));
    let aborted: (() => void) | undefined;
    const pending = (async () => {
      await state.host.assertHeld();
      return this.dependencies.work.commit(capability, command,
        async (context) => {
          await state.host.assertHeld();
          return action(state, context);
        }, { signal: controller.signal });
    })();
    const cleanup = () => {
      state.active = false;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", cancel);
      if (aborted) controller.signal.removeEventListener("abort", aborted);
    };
    pending.then(cleanup, cleanup);
    try {
      const committed = await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          aborted = () => reject(new ComputerBrokerError("execution_unconfirmed"));
          controller.signal.addEventListener("abort", aborted, { once: true });
          if (controller.signal.aborted) aborted();
        }),
      ]);
      if (committed.state === "unresolved") state.quarantined = true;
      return this.receipt(committed);
    } catch {
      state.quarantined = true;
      return { state: "unresolved", computerId: this.config.id, reason: "execution_unconfirmed" };
    }
  }

  private validateVM(vm: VMInspection | undefined, running = false): VMInspection {
    if (!vm || vm.name !== this.config.vmName || vm.sourceImage !== this.config.image
      || vm.operatingSystem !== "omarchy" || !Array.isArray(vm.hostMounts) || vm.hostMounts.length !== 0
      || !["running", "stopped"].includes(vm.state)) throw new ComputerBrokerError("untrusted_vm");
    if (running && vm.state !== "running") throw new ComputerBrokerError("computer_not_running");
    return vm;
  }

  private async session(state: LeaseState, context: AuthorizedEffectContext): Promise<GuestSession> {
    this.validateVM(await this.dependencies.tart.inspect(this.config.vmName, context.signal), true);
    const address = await this.dependencies.tart.address(this.config.vmName, context.signal);
    if (!isIP(address)) throw new ComputerBrokerError("invalid_guest_address");
    return {
      address, user: this.config.guestUser, expectedHostKey: this.config.hostKey,
      strictHostKeyChecking: true, workspace: state.owner, root: guestPath(state.owner, ".", true),
      permit: context.permit, intentRef: context.intentRef, signal: context.signal,
    };
  }

  private acknowledge(ack: GuestAcknowledgement, session: GuestSession): void {
    if (ack.hostKey !== this.config.hostKey || ack.workspace?.agentId !== session.workspace.agentId
      || ack.workspace?.workspaceId !== session.workspace.workspaceId || ack.intentRef !== session.intentRef) {
      throw new ComputerBrokerError("untrusted_guest_acknowledgement");
    }
  }

  async provision(capability: object, lease: ComputerLease, request: BrokerRequest): Promise<ComputerReceipt> {
    return this.perform(capability, lease, request, "computer.provision", {}, async (_state, context) => {
      const previous = await this.dependencies.tart.inspect(this.config.vmName, context.signal);
      if (previous) this.validateVM(previous);
      else await this.dependencies.tart.clone(this.config.image, this.config.vmName, context.signal);
      const vm = this.validateVM(await this.dependencies.tart.inspect(this.config.vmName, context.signal));
      return {
        status: "succeeded", value: { state: vm.state },
        receipts: [{ kind: "pinned-vm", sourceImage: vm.sourceImage, vmName: vm.name }],
        events: [{ type: "computer.provisioned", computerId: this.config.id, sourceImage: vm.sourceImage }],
      };
    });
  }

  async start(capability: object, lease: ComputerLease, request: BrokerRequest): Promise<ComputerReceipt> {
    return this.perform(capability, lease, request, "computer.start", {}, async (_state, context) => {
      this.validateVM(await this.dependencies.tart.inspect(this.config.vmName, context.signal));
      await this.dependencies.tart.start(this.config.vmName, context.signal);
      this.validateVM(await this.dependencies.tart.inspect(this.config.vmName, context.signal), true);
      return {
        status: "succeeded", value: { state: "running" }, receipts: [{ kind: "tart-state", state: "running" }],
        events: [{ type: "computer.started", computerId: this.config.id }],
      };
    });
  }

  async stop(capability: object, lease: ComputerLease, request: BrokerRequest): Promise<ComputerReceipt> {
    return this.perform(capability, lease, request, "computer.stop", {}, async (_state, context) => {
      this.validateVM(await this.dependencies.tart.inspect(this.config.vmName, context.signal));
      await this.dependencies.tart.stop(this.config.vmName, context.signal);
      const vm = this.validateVM(await this.dependencies.tart.inspect(this.config.vmName, context.signal));
      if (vm.state !== "stopped") throw new ComputerBrokerError("stop_unconfirmed");
      return {
        status: "succeeded", value: { state: "stopped" }, receipts: [{ kind: "tart-state", state: "stopped" }],
        events: [{ type: "computer.stopped", computerId: this.config.id }],
      };
    }, true);
  }

  async execute(capability: object, lease: ComputerLease, request: ExecuteRequest): Promise<ComputerReceipt> {
    const state = this.state(lease);
    if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.length > 128
      || request.argv.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))
      || !request.argv[0] || !bounded(request.timeoutMs, this.config.maxExecutionMs)) {
      throw new ComputerBrokerError("invalid_guest_execution");
    }
    const argv = Object.freeze([...request.argv]);
    const cwd = guestPath(state.owner, request.cwd, true);
    const timeoutMs = request.timeoutMs;
    const readOnly = request.readOnly ?? false;
    if (typeof readOnly !== "boolean") throw new ComputerBrokerError("invalid_guest_execution");
    const parentIntentRef = request.parentIntentRef;
    return this.perform(capability, lease, request, "computer.execute", {
      argv: [...argv], cwd, timeoutMs, readOnly,
    }, async (held, context) => {
      const session = await this.session(held, context);
      const result = await this.dependencies.guest.execute(session, {
        argv, cwd, timeoutMs, maxOutputBytes: this.config.maxOutputBytes, readOnly,
      });
      this.acknowledge(result, session);
      if (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255
        || typeof result.stdout !== "string" || typeof result.stderr !== "string"
        || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > this.config.maxOutputBytes) {
        throw new ComputerBrokerError("invalid_guest_result");
      }
      return {
        status: result.exitCode === 0 ? "succeeded" : "failed",
        value: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
        receipts: [{ kind: "guest-execution", leaseId: lease.id, exitCode: result.exitCode, hostKey: result.hostKey }],
        events: [{
          type: "computer.execution.completed", computerId: this.config.id, leaseId: lease.id,
          parentIntentRef, exitCode: result.exitCode,
        }],
      };
    });
  }

  async upload(capability: object, lease: ComputerLease, request: UploadRequest): Promise<ComputerReceipt> {
    const state = this.state(lease);
    if (!text(request.artifactId)) throw new ComputerBrokerError("invalid_artifact_id");
    const artifactId = request.artifactId;
    const path = guestPath(state.owner, request.guestPath);
    return this.perform(capability, lease, request, "computer.artifact.upload", {
      artifactId, path,
    }, async (held, context) => {
      const artifact = await this.dependencies.artifacts.read(capability, held.owner, artifactId, this.config.maxArtifactBytes);
      if (!(artifact.bytes instanceof Uint8Array) || artifact.bytes.byteLength > this.config.maxArtifactBytes) {
        throw new ComputerBrokerError("untrusted_artifact");
      }
      const bytes = Uint8Array.from(artifact.bytes);
      if (digest(bytes) !== artifact.sha256) throw new ComputerBrokerError("untrusted_artifact");
      const session = await this.session(held, context);
      const result = await this.dependencies.guest.upload(session, {
        path, bytes, sha256: artifact.sha256, maxBytes: this.config.maxArtifactBytes,
      });
      this.acknowledge(result, session);
      if (result.path !== path || result.sha256 !== artifact.sha256 || result.bytesWritten !== bytes.byteLength) {
        throw new ComputerBrokerError("upload_unconfirmed");
      }
      return {
        status: "succeeded", value: { artifactId, path, sha256: artifact.sha256 },
        receipts: [{ kind: "artifact-upload", sha256: artifact.sha256, bytes: bytes.byteLength, path }],
        events: [{ type: "computer.artifact.uploaded", computerId: this.config.id, artifactId, sha256: artifact.sha256 }],
      };
    });
  }

  async download(capability: object, lease: ComputerLease, request: DownloadRequest): Promise<ComputerReceipt> {
    const state = this.state(lease);
    const path = guestPath(state.owner, request.guestPath);
    return this.perform(capability, lease, request, "computer.artifact.download", { path }, async (held, context) => {
      const session = await this.session(held, context);
      const result = await this.dependencies.guest.download(session, { path, maxBytes: this.config.maxArtifactBytes });
      this.acknowledge(result, session);
      if (result.path !== path || !(result.bytes instanceof Uint8Array)
        || result.bytes.byteLength > this.config.maxArtifactBytes || digest(result.bytes) !== result.sha256) {
        throw new ComputerBrokerError("untrusted_download");
      }
      const artifact = await this.dependencies.artifacts.write(capability, held.owner, Uint8Array.from(result.bytes), result.sha256);
      if (!text(artifact.artifactId) || artifact.sha256 !== result.sha256) throw new ComputerBrokerError("artifact_persistence_unconfirmed");
      return {
        status: "succeeded", value: { artifactId: artifact.artifactId, sha256: result.sha256 },
        receipts: [{ kind: "artifact-download", artifactId: artifact.artifactId, sha256: result.sha256, bytes: result.bytes.byteLength }],
        events: [{ type: "artifact.created", artifactId: artifact.artifactId, computerId: this.config.id, sha256: result.sha256 }],
      };
    });
  }

  async release(capability: object, lease: ComputerLease, request: BrokerRequest): Promise<ComputerReceipt> {
    return this.perform(capability, lease, request, "computer.lease.release", {}, async (state) => {
      await state.host.release();
      state.released = true;
      return {
        status: "succeeded", value: { leaseId: lease.id }, receipts: [{ kind: "lease-release", leaseId: lease.id }],
        events: [{ type: "computer.lease.released", computerId: this.config.id, leaseId: lease.id }],
      };
    }, true);
  }

  /** Re-read an already completed operation; this never replays guest work. */
  async reconcile(capability: object, lease: ComputerLease): Promise<ComputerReceipt> {
    const state = this.leases.get(lease);
    if (!state || state.active || !state.lastKey) throw new ComputerBrokerError("cannot_reconcile_lease");
    const snapshot = await this.dependencies.work.read(capability, this.config.historyScope);
    const committed = snapshot.commands.find((entry) => entry.command.idempotencyKey === state.lastKey);
    if (!committed || committed.state !== "committed" || !isDeepStrictEqual(committed.command, state.lastCommand)) {
      return { state: "unresolved", computerId: this.config.id, reason: "operation_without_proof" };
    }
    if (!state.released) await state.host.assertHeld();
    state.quarantined = false;
    return this.receipt({ ...committed, replayed: true });
  }
}
