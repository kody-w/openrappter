import { spawn } from 'node:child_process';

export interface BoundedMediaProcessOptions {
  input?: Buffer;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export interface BoundedMediaProcessResult {
  stdout: Buffer;
  stderr: Buffer;
}

export async function runBoundedMediaProcess(
  command: string,
  args: string[],
  options: BoundedMediaProcessOptions = {},
): Promise<BoundedMediaProcessResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? 512 * 1024 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 256 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: [options.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (
      error?: Error,
      result?: BoundedMediaProcessResult,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const collect = (
      chunks: Buffer[],
      chunk: Buffer,
      current: number,
      maximum: number,
      label: string,
    ): number => {
      const next = current + chunk.length;
      if (next > maximum) {
        child.kill('SIGKILL');
        finish(new Error(`${command} ${label} exceeded ${maximum} bytes.`));
        return current;
      }
      chunks.push(Buffer.from(chunk));
      return next;
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(
        stdout,
        chunk,
        stdoutBytes,
        maxStdoutBytes,
        'stdout',
      );
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBytes = collect(
        stderr,
        chunk,
        stderrBytes,
        maxStderrBytes,
        'stderr',
      );
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      const result = {
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      };
      if (code !== 0) {
        finish(new Error(
          `${command} exited ${code}: ${result.stderr.toString('utf8').slice(0, 1000)}`,
        ));
      } else {
        finish(undefined, result);
      }
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} exceeded ${timeoutMs} ms.`));
    }, timeoutMs);
    if (options.input) {
      if (typeof child.stdin?.on === 'function') {
        child.stdin.on('error', (error) => finish(error));
      }
      child.stdin!.end(options.input);
    }
  });
}
