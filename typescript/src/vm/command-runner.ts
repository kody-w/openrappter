import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';

export interface VmCommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}

export interface VmCommandOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface VmProcess {
  readonly exited: Promise<VmCommandResult>;
  kill(signal: 'SIGINT' | 'SIGKILL'): void;
}

export interface VmCommandRunner {
  run(executable: string, argv: readonly string[], options: VmCommandOptions): Promise<VmCommandResult>;
  spawn(executable: string, argv: readonly string[]): Promise<VmProcess>;
}

type SpawnCommand = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** No shell, inherited agent, proxy, renderer environment, or detached process. */
export class NodeVmCommandRunner implements VmCommandRunner {
  constructor(private readonly spawnCommand: SpawnCommand = spawn) {}

  spawn(executable: string, argv: readonly string[]): Promise<VmProcess> {
    return new Promise((resolve, reject) => {
      const child = this.spawnCommand(executable, [...argv], {
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: homedir(),
        env: {
          HOME: homedir(),
          PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: 'C',
          LC_ALL: 'C',
        },
      });
      let stdout: Buffer = Buffer.alloc(0);
      let stderr: Buffer = Buffer.alloc(0);
      let truncated = false;
      let finished = false;
      let complete!: (result: VmCommandResult) => void;
      const exited = new Promise<VmCommandResult>((done) => { complete = done; });
      const append = (previous: Buffer, chunk: Buffer): Buffer => {
        const available = Math.max(0, MAX_OUTPUT_BYTES - stdout.length - stderr.length);
        if (chunk.length > available) truncated = true;
        return available ? Buffer.concat([previous, chunk.subarray(0, available)]) : previous;
      };
      child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.once('close', (exitCode, signal) => {
        finished = true;
        complete({
          exitCode, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
          timedOut: false, aborted: false, truncated,
        });
      });
      child.once('error', reject);
      child.once('spawn', () => resolve({
        exited,
        kill: (signal) => {
          // The child handle, not a VM name or a looked-up PID, is our authority.
          if (!finished) child.kill(signal);
        },
      }));
    });
  }

  async run(executable: string, argv: readonly string[], options: VmCommandOptions): Promise<VmCommandResult> {
    if (options.signal?.aborted) {
      return { exitCode: null, signal: null, stdout: '', stderr: '', timedOut: false, aborted: true, truncated: false };
    }
    const child = await this.spawn(executable, argv);
    let timedOut = false;
    let aborted = false;
    const cancel = () => { aborted = true; child.kill('SIGKILL'); };
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    try {
      return { ...await child.exited, timedOut, aborted };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
    }
  }
}
