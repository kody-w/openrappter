import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { RappFrame } from '../rapp/frame.js';
import type { JsonObject } from '../rappids/types.js';
import { NodeVmCommandRunner, type VmCommandResult, type VmCommandRunner, type VmProcess } from './command-runner.js';
import { loadOmarchyVmConfig, parseOmarchyVmConfig, vmIdentitySchema, type OmarchyVmConfig } from './config.js';
import {
  VmError, type VmExecRequest, type VmExecResult,
  type VmState, type VmStatus, type VmSupervisor, type VmWorkspaces,
} from './types.js';
import { guestWorkspacePath, HostVmWorkspaces } from './workspaces.js';
import { VmRappEvidence, vmDataHash, vmFrameReference, type VmRappPersistence } from './rapp-evidence.js';

const execSchema = z.strictObject({
  ...vmIdentitySchema.shape,
  argv: z.array(z.string().max(4096).refine((value) => !/[\x00-\x1f\x7f]/.test(value))).min(1).max(128),
  cwd: z.string().max(1024).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
const SSH = '/usr/bin/ssh';
const EXIT_GRACE_MS = 1_000;

type Delay = (ms: number, signal?: AbortSignal) => Promise<void>;
type OperationKind = 'start' | 'stop' | 'restart' | 'ready';
interface OwnedRun {
  process: VmProcess;
  expectedExit: boolean;
  failure?: VmError;
}

export interface TartVmSupervisorOptions {
  config?: unknown;
  configurationError?: VmError;
  runner?: VmCommandRunner;
  workspaces?: VmWorkspaces;
  evidence?: VmRappEvidence;
  host?: { platform: string; arch: string; addresses: readonly string[] };
  now?: () => number;
  delay?: Delay;
}

function cancelled(): VmError {
  return new VmError('operation_cancelled', 'The VM operation was cancelled.');
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(cancelled()); return; }
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** SSH has a remote shell boundary even when the host used spawn(argv). */
export function guestExecCommand(base: string, cwd: string, argv: readonly string[]): string {
  const script = [
    'set -eu',
    `base=$(/usr/bin/realpath -e -- ${quote(base)}) || exit 125`,
    `[ "$base" = ${quote(base)} ] || exit 126`,
    `target=$(/usr/bin/realpath -e -- ${quote(cwd)}) || exit 125`,
    'case "$target" in "$base"|"$base"/*) ;; *) exit 126 ;; esac',
    'cd -P -- "$target"',
    'actual=$(pwd -P)',
    'case "$actual" in "$base"|"$base"/*) ;; *) exit 126 ;; esac',
    `exec ${argv.map(quote).join(' ')}`,
  ].join('\n');
  return `/bin/sh -c ${quote(script)}`;
}

export class TartVmSupervisor implements VmSupervisor {
  private readonly config?: OmarchyVmConfig;
  private readonly runner: VmCommandRunner;
  private readonly workspaces: VmWorkspaces;
  private readonly host: NonNullable<TartVmSupervisorOptions['host']>;
  private readonly now: () => number;
  private readonly delay: Delay;
  private readonly evidence: VmRappEvidence;
  private state: VmState = 'unavailable';
  private error?: VmError;
  private ready = false;
  private address?: string;
  private observedRunning = false;
  private owned?: OwnedRun;
  private activeIntent?: RappFrame;
  private observations = new Set<Promise<void>>();
  private observationFailure?: VmError;
  private revision = 0;
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  private lastQueued?: { kind: OperationKind; promise: Promise<VmStatus> };
  private operations = new Map<AbortController, OperationKind>();
  private executions = new Map<AbortController, Promise<VmExecResult>>();
  private statusProbe?: { promise: Promise<VmStatus>; controller: AbortController };
  private closing = false;
  private shutdownPromise?: Promise<void>;

  constructor(options: TartVmSupervisorOptions = {}) {
    this.config = options.config === undefined ? undefined : parseOmarchyVmConfig(options.config);
    this.runner = options.runner ?? new NodeVmCommandRunner();
    this.workspaces = options.workspaces ?? {
      resolve: async () => { throw new VmError('workspace_denied', 'No host workspace registry is attached.'); },
    };
    this.host = options.host ?? {
      platform: process.platform,
      arch: process.arch,
      addresses: Object.values(networkInterfaces()).flatMap((entries) => entries?.map((entry) => entry.address) ?? []),
    };
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? pause;
    this.evidence = options.evidence ?? new VmRappEvidence();
    this.error = options.configurationError ?? this.availabilityError();
  }

  getFrames(): readonly RappFrame[] {
    return this.evidence.frames();
  }

  private record(event: Parameters<VmRappEvidence['record']>[1], details: JsonObject): Promise<RappFrame> {
    return this.evidence.record(this.config!.name, event, {
      ...details,
      operation_frame: this.activeIntent ? vmFrameReference(this.activeIntent) : null,
    });
  }

  private snapshot(): VmStatus {
    return {
      state: this.state, name: this.config?.name, imageVersion: this.config?.image.version,
      owned: !!this.owned, ready: this.ready, address: this.address,
      verification: this.evidence.verification(),
      ...(this.error ? { error: { code: this.error.code, message: this.error.message } } : {}),
    };
  }

  /** Volatile observation only; public views also carry the evidence status. */
  private observeState(state: VmState, error?: VmError): void {
    this.state = state;
    this.error = error;
    if (state !== 'running') { this.ready = false; this.address = undefined; }
  }

  private async setState(state: VmState, error?: VmError): Promise<void> {
    const previous = this.state;
    const changed = previous !== state || this.error?.code !== error?.code;
    this.observeState(state, error);
    if (changed && this.config && this.evidence.wired) {
      await this.record('vm.state', { from: previous, to: state, error_code: error?.code ?? null });
    }
  }

  private async fail(error: VmError): Promise<void> {
    const unavailable = [
      'not_configured', 'invalid_configuration', 'unsupported_platform',
      'unsupported_architecture', 'tart_missing', 'image_missing', 'rapp_not_wired',
    ].includes(error.code);
    if (error.code === 'rapp_not_wired' || error.code === 'rapp_verification_failed') {
      this.observeState(unavailable ? 'unavailable' : 'error', error);
    } else {
      await this.setState(unavailable ? 'unavailable' : 'error', error);
    }
  }

  private availabilityError(): VmError | undefined {
    if (this.host.platform !== 'darwin') return new VmError('unsupported_platform', 'Omarchy VMs require macOS.');
    if (this.host.arch !== 'arm64') return new VmError('unsupported_architecture', 'Omarchy VMs require native Apple Silicon (arm64).');
    if (!this.config) return new VmError('not_configured', 'Configure the host Omarchy image and SSH identity before starting the VM.');
    return undefined;
  }

  private assertAvailable(): void {
    const error = (this.error?.code === 'invalid_configuration' ? this.error : undefined) ?? this.availabilityError();
    if (error) throw error;
  }

  private assertActive(signal?: AbortSignal): void {
    if (this.closing) throw new VmError('shutting_down', 'The VM supervisor is shutting down.');
    if (signal?.aborted) throw cancelled();
  }

  private normalizeError(error: unknown): VmError {
    return error instanceof VmError ? error : new VmError('command_failed', 'A host VM operation failed.');
  }

  private async tart(argv: readonly string[], signal?: AbortSignal, timeoutMs?: number): Promise<VmCommandResult> {
    this.assertActive(signal);
    this.assertAvailable();
    try {
      const result = await this.runner.run(this.config!.tartBinary, argv, {
        timeoutMs: timeoutMs ?? this.config!.commandTimeoutMs, signal,
      });
      this.assertActive(signal);
      if (result.aborted) throw cancelled();
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VmError('tart_missing', 'Tart is not installed at the configured host binary path.');
      }
      throw this.normalizeError(error);
    }
  }

  private successful(result: VmCommandResult): boolean {
    return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted;
  }

  private async inspect(signal?: AbortSignal, timeoutMs?: number): Promise<boolean> {
    const result = await this.tart(['list', '--source', 'local', '--format', 'json'], signal, timeoutMs);
    if (!this.successful(result) || result.truncated) {
      throw new VmError('command_failed', 'Tart could not report local VM status.');
    }
    let rows: unknown;
    try { rows = JSON.parse(result.stdout); } catch { /* Fail closed on non-JSON Tart output. */ }
    if (!Array.isArray(rows)) throw new VmError('command_failed', 'Tart returned an invalid VM list.');
    const matches = rows.filter((row) => row && row.Name === this.config!.name);
    if (!matches.length) throw new VmError('image_missing', 'The configured local Omarchy VM is not installed; provision the pinned image first.');
    if (matches.length !== 1 || typeof matches[0].Running !== 'boolean') {
      throw new VmError('command_failed', 'Tart returned an invalid VM state.');
    }
    this.observedRunning = matches[0].Running;
    return this.observedRunning;
  }

  status(): Promise<VmStatus> {
    if (this.closing || this.pending) return Promise.resolve(this.snapshot());
    if (this.statusProbe) return this.statusProbe.promise;
    const revision = this.revision;
    const controller = new AbortController();
    const promise = (async () => {
      try {
        this.assertAvailable();
        await this.evidence.prepare();
        const running = await this.inspect(controller.signal);
        if (revision === this.revision && !this.closing && (!running || this.state !== 'error')) {
          await this.setState(running ? 'running' : 'stopped');
        }
      } catch (error) {
        if (revision === this.revision && !this.closing) {
          try { await this.fail(this.normalizeError(error)); }
          catch (evidenceError) { this.observeState('error', this.normalizeError(evidenceError)); }
        }
      }
      return this.snapshot();
    })().finally(() => {
      if (this.statusProbe?.promise === promise) this.statusProbe = undefined;
    });
    this.statusProbe = { promise, controller };
    return promise;
  }

  private enqueue(kind: OperationKind, work: (signal: AbortSignal) => Promise<VmStatus>): Promise<VmStatus> {
    if (this.closing) return Promise.reject(new VmError('shutting_down', 'The VM supervisor is shutting down.'));
    if (this.lastQueued?.kind === kind) return this.lastQueued.promise;
    this.revision++;
    this.statusProbe?.controller.abort();
    this.pending++;
    const controller = new AbortController();
    this.operations.set(controller, kind);
    let intent: RappFrame | undefined;
    const promise = this.tail.then(async () => {
      this.assertActive(controller.signal);
      this.assertAvailable();
      intent = await this.record('vm.requested', {
        operation: kind, state: this.state,
        image: { ...this.config!.image },
        policy_hash: vmDataHash({ allowedExecutables: this.config!.allowedExecutables, workspaces: this.config!.workspaces.map((entry) => ({ ...entry })) }),
      });
      this.activeIntent = intent;
      this.assertActive(controller.signal);
      await work(controller.signal);
      const evidence = await this.record('vm.completed', { operation: kind, state: this.state, request_frame: vmFrameReference(intent) });
      return { ...this.snapshot(), evidence };
    }).catch(async (error: unknown) => {
      let failure = this.normalizeError(error);
      try {
        if (!this.closing && !['operation_cancelled', 'shutting_down', 'not_ready'].includes(failure.code)) await this.fail(failure);
        if (intent && this.evidence.healthy) {
          const evidence = await this.record(['operation_cancelled', 'shutting_down'].includes(failure.code) ? 'vm.cancelled' : 'vm.failed', {
            operation: kind, error_code: failure.code, request_frame: vmFrameReference(intent),
          });
          failure = new VmError(failure.code, failure.message, evidence);
        }
      } catch (evidenceError) {
        failure = this.normalizeError(evidenceError);
        this.observeState('error', failure);
      }
      if (failure.code === 'rapp_verification_failed' && this.owned) {
        await this.terminateOwned(this.owned);
        this.observeState('error', failure);
      }
      throw failure;
    }).finally(() => {
      this.activeIntent = undefined;
      this.pending--;
      this.operations.delete(controller);
      if (this.lastQueued?.promise === promise) this.lastQueued = undefined;
    });
    this.tail = promise.then(() => undefined, () => undefined);
    this.lastQueued = { kind, promise };
    return promise;
  }

  private cancelWork(): void {
    for (const [controller, kind] of this.operations) if (kind !== 'stop') controller.abort();
    for (const controller of this.executions.keys()) controller.abort();
  }

  start(): Promise<VmStatus> {
    return this.enqueue('start', (signal) => this.startInternal(signal));
  }

  stop(): Promise<VmStatus> {
    if (this.lastQueued?.kind === 'stop') return this.lastQueued.promise;
    this.cancelWork();
    return this.enqueue('stop', (signal) => this.stopInternal(signal));
  }

  restart(): Promise<VmStatus> {
    if (this.lastQueued?.kind === 'restart') return this.lastQueued.promise;
    this.cancelWork();
    return this.enqueue('restart', async (signal) => {
      await this.stopInternal(signal);
      this.assertActive(signal);
      return this.startInternal(signal);
    });
  }

  waitReady(): Promise<VmStatus> {
    return this.enqueue('ready', async (signal) => {
      if (!await this.inspect(signal)) {
        await this.setState('stopped');
        throw new VmError('not_ready', 'The VM is stopped; start it before waiting for SSH.');
      }
      return this.readyInternal(signal, this.owned);
    });
  }

  private async startInternal(signal: AbortSignal): Promise<VmStatus> {
    const running = await this.inspect(signal);
    this.assertActive(signal);
    if (running && this.ready) return this.snapshot();
    await this.setState('starting');
    if (!running) {
      if (this.owned) await this.terminateOwned(this.owned);
      this.assertActive(signal);
      let child: VmProcess;
      try {
        child = await this.runner.spawn(this.config!.tartBinary, [
          'run', '--no-graphics', '--no-audio', '--no-clipboard', this.config!.name,
        ]);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new VmError('tart_missing', 'Tart is not installed at the configured host binary path.');
        }
        throw this.normalizeError(error);
      }
      const owner: OwnedRun = { process: child, expectedExit: false };
      this.owned = owner;
      const observation = child.exited.then(async (result) => {
        if (this.owned !== owner) return;
        this.owned = undefined;
        this.observedRunning = false;
        if (owner.expectedExit) return;
        owner.failure = new VmError('process_exited', 'The owned Tart VM process exited.');
        this.ready = false;
        this.address = undefined;
        // Wake a readiness poll without affecting another queued generation.
        for (const [controller, kind] of this.operations) {
          if (controller.signal === signal && kind !== 'stop') controller.abort();
        }
        if (this.successful(result) && (this.state === 'running' || this.closing)) await this.setState('stopped');
        else await this.fail(owner.failure);
        await this.record('vm.exited', { exit_code: result.exitCode, signal: result.signal });
      }, async () => {
        owner.failure = new VmError('process_exited', 'The owned Tart VM process could not be observed.');
        if (!this.closing) await this.fail(owner.failure);
      }).catch((error: unknown) => {
        this.observationFailure = this.normalizeError(error);
        this.observeState('error', this.observationFailure);
      });
      this.observations.add(observation);
      void observation.finally(() => this.observations.delete(observation));
      await this.record('vm.spawned', { owned: true, mounts: [] });
    }
    return this.readyInternal(signal, this.owned);
  }

  private guestAddress(value: string): string {
    const address = value.trim();
    const octets = address.split('.').map(Number);
    const privateAddress = octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
    if (!isIPv4(address) || !privateAddress || this.host.addresses.includes(address)) {
      throw new VmError('unsafe_guest_address', 'Tart did not return a private guest address distinct from this host.');
    }
    return address;
  }

  private sshArgs(address: string, command: string): string[] {
    const config = this.config!;
    // -F discards user/system ssh_config, so ProxyCommand, LocalCommand and
    // ambient identities cannot turn guest execution into local execution.
    return [
      '-F', '/dev/null', '-T', '-n',
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile="${config.ssh.knownHostsFile.replace(/"/g, '\\"')}"`,
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `HostKeyAlias=${config.name}`,
      '-o', 'CheckHostIP=no', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
      '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'PreferredAuthentications=publickey', '-o', 'ForwardAgent=no',
      '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no',
      '-o', 'ProxyCommand=none', '-o', 'ProxyJump=none',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'ConnectTimeout=5', '-o', 'ConnectionAttempts=1',
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1',
      '-o', 'LogLevel=ERROR',
      '-i', config.ssh.identityFile, '-p', '22', '-l', config.ssh.user,
      '--', address, command,
    ];
  }

  private async readyInternal(signal: AbortSignal, owner?: OwnedRun): Promise<VmStatus> {
    const deadline = this.now() + this.config!.readyTimeoutMs;
    try {
      while (this.now() < deadline) {
        if (owner?.failure) throw owner.failure;
        this.assertActive(signal);
        const budget = () => Math.max(1, Math.min(this.config!.commandTimeoutMs, deadline - this.now()));
        if (await this.inspect(signal, budget())) {
          const ip = await this.tart(['ip', this.config!.name, '--wait', '0', '--resolver', 'dhcp'], signal, budget());
          this.assertActive(signal);
          if (this.successful(ip) && !ip.truncated) {
            const address = this.guestAddress(ip.stdout);
            const probe = await this.runner.run(SSH, this.sshArgs(address, '/usr/bin/true'), {
              timeoutMs: budget(), signal,
            });
            this.assertActive(signal);
            if (this.successful(probe) && this.now() < deadline && !owner?.failure) {
              await this.setState('running');
              this.assertActive(signal);
              this.ready = true;
              this.address = address;
              await this.record('vm.ready', { address, ready: true, owned: !!this.owned });
              return this.snapshot();
            }
          }
        }
        await this.delay(Math.min(this.config!.pollIntervalMs, Math.max(0, deadline - this.now())), signal);
      }
      throw new VmError('readiness_timeout', 'The VM did not become SSH-ready within the configured deadline.');
    } catch (error) {
      throw owner?.failure ?? this.normalizeError(error);
    }
  }

  private async stopInternal(signal: AbortSignal): Promise<VmStatus> {
    const running = await this.inspect(signal);
    this.assertActive(signal);
    if (running) {
      await this.setState('stopping');
      const owner = this.owned;
      if (owner) owner.expectedExit = true;
      const result = await this.tart(['stop', '--timeout', '2', this.config!.name], signal);
      // Another caller may have stopped it between list and stop.
      if (!this.successful(result) && await this.inspect(signal)) {
        if (owner) owner.expectedExit = false;
        throw new VmError('command_failed', 'Tart could not stop the shared VM.');
      }
      const deadline = this.now() + this.config!.commandTimeoutMs;
      while (await this.inspect(signal)) {
        this.assertActive(signal);
        if (this.now() >= deadline) throw new VmError('command_failed', 'Tart did not confirm the VM stopped.');
        await this.delay(this.config!.pollIntervalMs, signal);
      }
    }
    this.assertActive(signal);
    if (this.owned) await this.terminateOwned(this.owned);
    await this.setState('stopped');
    return this.snapshot();
  }

  private async waitForExit(owner: OwnedRun): Promise<boolean> {
    const controller = new AbortController();
    try {
      return await Promise.race([
        owner.process.exited.then(() => true, () => false),
        this.delay(EXIT_GRACE_MS, controller.signal).then(() => false),
      ]);
    } finally { controller.abort(); }
  }

  private async terminateOwned(owner: OwnedRun): Promise<void> {
    owner.expectedExit = true;
    owner.process.kill('SIGINT');
    if (!await this.waitForExit(owner)) {
      owner.process.kill('SIGKILL');
      if (!await this.waitForExit(owner)) {
        throw new VmError('command_failed', 'The owned Tart child did not exit after shutdown.');
      }
    }
    if (this.owned === owner) this.owned = undefined;
    this.observedRunning = false;
  }

  async exec(input: VmExecRequest): Promise<VmExecResult> {
    this.assertActive();
    this.assertAvailable();
    const parsed = execSchema.safeParse(input);
    if (!parsed.success) throw new VmError('invalid_request', 'Expected an agent/workspace identity and a bounded argv array.');
    const request = parsed.data;
    if (!this.config!.allowedExecutables.includes(request.argv[0])
      || request.argv.reduce((length, arg) => length + Buffer.byteLength(arg), 0) > 16_384) {
      throw new VmError('invalid_request', 'The guest executable is not host-approved, or argv is too large.');
    }
    const relative = request.cwd ?? '.';
    if (relative !== '.' && (!relative || relative.split('/').some((segment) =>
      !/^[a-zA-Z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..'))) {
      throw new VmError('invalid_request', 'cwd must be a safe relative path within this guest workspace.');
    }
    if ((request.timeoutMs ?? 0) > this.config!.execTimeoutMs) {
      throw new VmError('invalid_request', 'Execution timeout exceeds the host limit.');
    }
    if (!this.config!.workspaces.some((entry) => entry.agentId === request.agentId && entry.workspaceId === request.workspaceId)) {
      throw new VmError('workspace_denied', 'This agent/workspace pair is not registered by the host.');
    }
    if (this.pending || this.executions.size >= 4) throw new VmError('exec_busy', 'The VM is transitioning or its execution limit is reached.');
    const controller = new AbortController();
    const revision = this.revision;
    const completion = this.execInternal(request, controller.signal, revision);
    this.executions.set(controller, completion);
    try {
      return await completion;
    } catch (error) {
      throw this.normalizeError(error);
    } finally { this.executions.delete(controller); }
  }

  private async execInternal(request: VmExecRequest, signal: AbortSignal, revision: number): Promise<VmExecResult> {
    const identity = { agentId: request.agentId, workspaceId: request.workspaceId };
    const requestHash = vmDataHash({ ...identity, argv: request.argv, cwd: request.cwd ?? '.', timeoutMs: request.timeoutMs ?? this.config!.execTimeoutMs });
    const intent = await this.evidence.record(this.config!.name, 'tool.requested', {
      agent_id: request.agentId, workspace_id: request.workspaceId, request_hash: requestHash,
    }, identity);
    const terminal: { frame?: RappFrame } = {};
    try {
      return await this.executeGuest(request, signal, revision, intent, terminal);
    } catch (error) {
      const failure = this.normalizeError(error);
      if (!terminal.frame && this.evidence.healthy) {
        terminal.frame = await this.evidence.record(this.config!.name, 'tool.failed', {
          agent_id: request.agentId, workspace_id: request.workspaceId,
          request_frame: vmFrameReference(intent), error_code: failure.code,
        }, identity);
      }
      throw new VmError(failure.code, failure.message, terminal.frame);
    }
  }

  private async executeGuest(
    request: VmExecRequest,
    signal: AbortSignal,
    revision: number,
    intent: RappFrame,
    terminal: { frame?: RappFrame },
  ): Promise<VmExecResult> {
    this.assertActive(signal);
    if (revision !== this.revision || this.pending) throw cancelled();
    await this.workspaces.resolve({ agentId: request.agentId, workspaceId: request.workspaceId }, intent);
    this.assertActive(signal);
    if (revision !== this.revision || this.pending) throw cancelled();
    const running = await this.inspect(signal);
    if (!running || !this.ready) {
      if (!running) await this.setState('stopped');
      this.ready = false;
      this.address = undefined;
      throw new VmError('not_ready', 'Start the VM and wait for SSH readiness before guest execution.');
    }
    this.assertActive(signal);
    const ip = await this.tart(['ip', this.config!.name, '--wait', '0', '--resolver', 'dhcp'], signal);
    if (!this.successful(ip) || ip.truncated) throw new VmError('not_ready', 'The guest address is unavailable.');
    const address = this.guestAddress(ip.stdout);
    const base = guestWorkspacePath({ agentId: request.agentId, workspaceId: request.workspaceId });
    const cwd = path.posix.join(base, request.cwd ?? '.');
    this.assertActive(signal);
    const result = await this.runner.run(SSH, this.sshArgs(address, guestExecCommand(base, cwd, request.argv)), {
      timeoutMs: request.timeoutMs ?? this.config!.execTimeoutMs, signal,
    });
    const interrupted = signal.aborted || this.closing || result.aborted;
    const evidence = await this.evidence.record(this.config!.name, interrupted ? 'tool.failed' : 'tool.completed', {
      agent_id: request.agentId, workspace_id: request.workspaceId, cwd,
      request_frame: vmFrameReference(intent),
      result_hash: vmDataHash({ ...result }), exit_code: result.exitCode,
      signal: result.signal, timed_out: result.timedOut, aborted: result.aborted, truncated: result.truncated,
      error_code: interrupted ? this.closing ? 'shutting_down' : 'operation_cancelled' : null,
    }, { agentId: request.agentId, workspaceId: request.workspaceId });
    terminal.frame = evidence;
    this.assertActive(signal);
    if (result.aborted) throw cancelled();
    return {
      agentId: request.agentId, workspaceId: request.workspaceId, cwd,
      stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode,
      signal: result.signal, timedOut: result.timedOut, aborted: result.aborted, truncated: result.truncated,
      evidence, verification: this.evidence.verification(),
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.revision++;
    this.statusProbe?.controller.abort();
    for (const controller of this.operations.keys()) controller.abort();
    for (const controller of this.executions.keys()) controller.abort();
    this.shutdownPromise = (async () => {
      await Promise.allSettled([
        this.tail, ...this.executions.values(), ...(this.statusProbe ? [this.statusProbe.promise] : []),
      ]);
      let evidenceFailure = this.observationFailure;
      if (this.owned) {
        try {
          await this.record('vm.requested', { operation: 'shutdown', owned: true });
          await this.setState('stopping');
        } catch (error) {
          evidenceFailure = this.normalizeError(error);
        }
        try {
          await this.terminateOwned(this.owned);
          if (this.evidence.healthy) await this.setState('stopped');
          else this.observeState('stopped');
        } catch (error) {
          const failure = this.normalizeError(error);
          this.observeState('error', failure);
          throw failure;
        }
      }
      await Promise.all(this.observations);
      evidenceFailure ??= this.observationFailure;
      if (this.state === 'starting' || this.state === 'stopping') {
        if (this.evidence.healthy) await this.setState(this.observedRunning ? 'running' : 'stopped');
        else this.observeState(this.observedRunning ? 'running' : 'stopped');
      }
      this.ready = false;
      this.address = undefined;
      if (this.config && this.evidence.healthy && this.getFrames().length) {
        await this.record('vm.shutdown', { state: this.state, external_vm_left_running: this.observedRunning, owned: false });
      }
      if (evidenceFailure) throw evidenceFailure;
    })();
    return this.shutdownPromise;
  }
}

/** Lazy, host-only setup. No provisioning, Tart command, or image download here. */
export function createHostTartVmSupervisor(dataDir: string, persistence?: VmRappPersistence): TartVmSupervisor {
  try {
    const config = loadOmarchyVmConfig(dataDir);
    const evidence = new VmRappEvidence(persistence);
    return new TartVmSupervisor({
      config,
      evidence,
      workspaces: config ? new HostVmWorkspaces(dataDir, config.workspaces, evidence, config.name) : undefined,
    });
  } catch (error) {
    return new TartVmSupervisor({ configurationError: error as VmError });
  }
}
