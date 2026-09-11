import type { VmCommandOptions, VmCommandResult, VmCommandRunner, VmProcess } from '../command-runner.js';
import { parseOmarchyVmConfig } from '../config.js';
import type { VmWorkspaces } from '../types.js';
import { VmError } from '../types.js';
import { guestWorkspacePath } from '../workspaces.js';

export const testConfig = parseOmarchyVmConfig({
  schemaVersion: 1,
  image: { reference: 'registry.example.test/rapp/omarchy-arm64:2026.9.1', version: '2026.9.1', sha256: 'a'.repeat(64) },
  ssh: { user: 'rapp', identityFile: '/host/ssh/vm_ed25519', knownHostsFile: '/host/ssh/known_hosts' },
  workspaces: [{ agentId: 'agent-a', workspaceId: 'project-1' }],
  readyTimeoutMs: 1000,
  commandTimeoutMs: 100,
  pollIntervalMs: 100,
});

export const testHost = { platform: 'darwin', arch: 'arm64', addresses: ['127.0.0.1', '192.168.64.1'] };
export const testWorkspaces: VmWorkspaces = {
  resolve: async (identity) => {
    if (identity.agentId !== 'agent-a' || identity.workspaceId !== 'project-1') {
      throw new VmError('workspace_denied', 'Unregistered workspace.');
    }
    return { ...identity, hostPath: '/host/workspaces/agent-a/project-1', guestPath: guestWorkspacePath(identity) };
  },
};

export function result(overrides: Partial<VmCommandResult> = {}): VmCommandResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, ...overrides };
}

export function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class FakeProcess implements VmProcess {
  private completion = deferred<VmCommandResult>();
  exited = this.completion.promise;
  signals: string[] = [];
  ignoreInt = false;
  finished = false;
  constructor(private onExit: () => void) {}
  exit(value = result()): void {
    if (this.finished) return;
    this.finished = true;
    this.onExit();
    this.completion.resolve(value);
  }
  kill(signal: 'SIGINT' | 'SIGKILL'): void {
    this.signals.push(signal);
    if (signal === 'SIGINT' && this.ignoreInt) return;
    this.exit(result({ signal, exitCode: null }));
  }
}

export interface FakeCall {
  kind: 'run' | 'spawn';
  file: string;
  argv: readonly string[];
  options?: VmCommandOptions;
}

export class FakeVmCommandRunner implements VmCommandRunner {
  calls: FakeCall[] = [];
  children: FakeProcess[] = [];
  installed = true;
  running = false;
  missingTart = false;
  address = '192.168.64.2\n';
  sshReady = true;
  listOutput?: string;
  listFailure?: VmCommandResult;
  stopFailure?: VmCommandResult;
  execResult = result({ stdout: 'guest output\n' });
  intercept?: (call: FakeCall) => Promise<VmCommandResult | undefined>;
  spawnIntercept?: () => Promise<void>;

  async run(file: string, argv: readonly string[], options: VmCommandOptions): Promise<VmCommandResult> {
    const call: FakeCall = { kind: 'run', file, argv: [...argv], options };
    this.calls.push(call);
    if (file.endsWith('/tart') && this.missingTart) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    const intercepted = await this.intercept?.(call);
    if (intercepted) return intercepted;
    if (options.signal?.aborted) return result({ aborted: true, exitCode: null });
    if (argv[0] === 'list') {
      return this.listFailure ?? result({ stdout: this.listOutput ?? JSON.stringify(this.installed ? [
        { Source: 'local', Name: testConfig.name, Running: this.running, State: this.running ? 'running' : 'stopped' },
      ] : []) });
    }
    if (argv[0] === 'ip') return result({ stdout: this.address });
    if (argv[0] === 'stop') {
      if (this.stopFailure) return this.stopFailure;
      this.running = false;
      for (const child of this.children) child.exit();
      return result();
    }
    if (file === '/usr/bin/ssh') {
      if (argv.at(-1) === '/usr/bin/true') return result({ exitCode: this.sshReady ? 0 : 255 });
      return this.execResult;
    }
    throw new Error(`Unexpected fake command: ${file}`);
  }

  async spawn(file: string, argv: readonly string[]): Promise<VmProcess> {
    this.calls.push({ kind: 'spawn', file, argv: [...argv] });
    await this.spawnIntercept?.();
    if (this.missingTart) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    if (this.running) {
      // Tart's native VM lock rejects a second foreground process, not the
      // first one. The loser must never acquire shutdown authority over it.
      const loser = new FakeProcess(() => {});
      this.children.push(loser);
      queueMicrotask(() => loser.exit(result({ exitCode: 1 })));
      return loser;
    }
    this.running = true;
    const child = new FakeProcess(() => { this.running = false; });
    this.children.push(child);
    return child;
  }
}
