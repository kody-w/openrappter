import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

export const VIBEVOICE_REPOSITORY = 'https://github.com/microsoft/VibeVoice.git';
export const VIBEVOICE_COMMIT = '94da20d98b2fa7688e9cbfaf7692ddb4954f7600';
export const VIBEVOICE_MODEL_ID = 'microsoft/VibeVoice-Realtime-0.5B';
export const VIBEVOICE_MODEL_REVISION = [
  '6bce5f0604',
  '4837fe6d2c',
  '5d7a71a84f',
  '0416bd57e4',
].join('');
export const VIBEVOICE_MODEL_LABEL = '~2.04 GB';
const QWEN_TOKENIZER_ID = 'Qwen/Qwen2.5-0.5B';
const QWEN_TOKENIZER_REVISION = [
  '060db6499f',
  '32faf8b984',
  '77b0a26969',
  'ef7d8b9987',
].join('');
const VIBEVOICE_REQUIREMENTS = [
  'torch==2.5.1',
  'transformers==4.51.3',
  'accelerate==1.14.0',
  'llvmlite==0.48.0',
  'numba==0.66.0',
  'diffusers==0.39.0',
  'tqdm==4.70.0',
  'numpy==2.4.6',
  'scipy==1.17.1',
  'librosa==0.11.0',
  'ml-collections==1.1.0',
  'absl-py==2.5.0',
  'gradio==6.17.3',
  'av==17.1.0',
  'aiortc==1.15.0',
  'uvicorn[standard]==0.52.1',
  'fastapi==0.141.1',
  'pydub==0.25.1',
  'requests==2.34.2',
  'huggingface-hub==0.36.2',
] as const;

export interface VibeVoiceStatus {
  state:
    | 'missing'
    | 'installing'
    | 'downloading'
    | 'starting'
    | 'ready'
    | 'speaking'
    | 'error';
  phase: string;
  progress: number | null;
  device: 'mps' | 'cuda' | 'cpu';
  port: number | null;
  error: string | null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function executable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.status === 0) return candidate;
  }
  return null;
}

function wavFromPcm16(pcm: Buffer, sampleRate = 24_000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class VibeVoiceService {
  private server: ChildProcess | null = null;
  private serverPort: number | null = null;
  private current: VibeVoiceStatus;
  private operation: Promise<void> = Promise.resolve();
  private lifecycleGeneration = 0;
  private readonly activeChildren = new Set<ChildProcess>();

  constructor(
    private readonly emit: (status: VibeVoiceStatus) => void,
  ) {
    this.current = {
      state: this.isInstalled() ? 'starting' : 'missing',
      phase: 'idle',
      progress: null,
      device: this.device(),
      port: null,
      error: null,
    };
  }

  root(): string {
    return path.join(app.getPath('userData'), 'vibevoice');
  }

  sourceDir(): string {
    return path.join(this.root(), 'source');
  }

  modelDir(): string {
    return path.join(this.root(), 'models', 'VibeVoice-Realtime-0.5B');
  }

  venvPython(): string {
    return process.platform === 'win32'
      ? path.join(this.root(), '.venv', 'Scripts', 'python.exe')
      : path.join(this.root(), '.venv', 'bin', 'python');
  }

  status(): VibeVoiceStatus {
    return { ...this.current };
  }

  isInstalled(): boolean {
    return existsSync(this.venvPython()) &&
      existsSync(path.join(this.sourceDir(), '.git')) &&
      existsSync(path.join(this.modelDir(), 'model.safetensors')) &&
      existsSync(path.join(
        this.root(),
        'hf',
        'hub',
        'models--Qwen--Qwen2.5-0.5B',
        'snapshots',
        QWEN_TOKENIZER_REVISION,
        'tokenizer.json',
      ));
  }

  async enable(): Promise<VibeVoiceStatus> {
    const generation = this.lifecycleGeneration;
    const work = async () => {
      this.assertGeneration(generation);
      if (!this.isInstalled()) await this.bootstrap(generation);
      await this.start(generation);
    };
    this.operation = this.operation.then(work, work);
    await this.operation;
    return this.status();
  }

  async speak(text: string, voice = 'en-Carter_man'): Promise<Buffer> {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0 || normalized.length > 1500) {
      throw new Error('VibeVoice text must be between 1 and 1500 characters.');
    }
    if (normalized.split(/\s+/).length < 4) {
      throw new Error('VibeVoice needs at least four words for stable speech.');
    }
    await this.enable();
    this.update({ state: 'speaking', phase: 'generating', error: null });
    try {
      const url =
        `ws://127.0.0.1:${this.serverPort}/stream?` +
        new URLSearchParams({
          text: normalized,
          voice,
          cfg: '1.5',
          steps: '5',
        }).toString();
      const pcm = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        const socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error('VibeVoice generation timed out.'));
        }, 120_000);
        socket.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            chunks.push(Buffer.from(event.data));
          } else if (ArrayBuffer.isView(event.data)) {
            chunks.push(Buffer.from(
              event.data.buffer,
              event.data.byteOffset,
              event.data.byteLength,
            ));
          }
        };
        socket.onerror = () => {
          clearTimeout(timeout);
          reject(new Error('VibeVoice WebSocket failed.'));
        };
        socket.onclose = () => {
          clearTimeout(timeout);
          if (chunks.length === 0) {
            reject(new Error('VibeVoice returned no audio.'));
          } else {
            resolve(Buffer.concat(chunks));
          }
        };
      });
      return wavFromPcm16(pcm);
    } finally {
      this.update({ state: 'ready', phase: 'idle' });
    }
  }

  async stop(): Promise<void> {
    this.lifecycleGeneration += 1;
    const bootstrapChildren = [...this.activeChildren];
    await Promise.all(bootstrapChildren.map((child) => this.terminateChild(child)));
    const child = this.server;
    this.server = null;
    this.serverPort = null;
    if (child) await this.terminateChild(child);
    await Promise.race([
      this.operation.catch(() => undefined),
      delay(10_000),
    ]);
    this.update({
      state: this.isInstalled() ? 'starting' : 'missing',
      phase: 'idle',
      port: null,
    });
  }

  private device(): 'mps' | 'cuda' | 'cpu' {
    if (process.platform === 'darwin' && process.arch === 'arm64') return 'mps';
    if (executable(['nvidia-smi'])) return 'cuda';
    return 'cpu';
  }

  private async bootstrap(generation: number): Promise<void> {
    this.assertGeneration(generation);
    mkdirSync(this.root(), { recursive: true, mode: 0o700 });
    const free = statfsSync(this.root()).bavail * statfsSync(this.root()).bsize;
    if (free < 8 * 1024 ** 3) {
      throw new Error('VibeVoice requires at least 8 GB of free disk space.');
    }
    const git = executable(['git']);
    if (!git) throw new Error('Git is required to install VibeVoice.');
    const uv = executable([
      process.platform === 'win32' ? 'uv.exe' : 'uv',
      '/opt/homebrew/bin/uv',
      '/usr/local/bin/uv',
    ]);
    const python = executable([
      process.platform === 'win32' ? 'python.exe' : 'python3.11',
      '/opt/homebrew/bin/python3.11',
      '/usr/local/bin/python3.11',
    ]);
    if (!uv && !python) {
      throw new Error(
        'VibeVoice requires uv or Python 3.11. Install uv, then enable voice again.',
      );
    }

    if (!existsSync(path.join(this.sourceDir(), '.git'))) {
      this.update({ state: 'installing', phase: 'cloning-source', progress: 2 });
      await this.run(git, [
        'clone',
        '--filter=blob:none',
        VIBEVOICE_REPOSITORY,
        this.sourceDir(),
      ], { generation });
    }
    await this.run(git, ['fetch', '--depth', '1', 'origin', VIBEVOICE_COMMIT], {
      cwd: this.sourceDir(),
      generation,
    });
    await this.run(git, ['checkout', '--detach', VIBEVOICE_COMMIT], {
      cwd: this.sourceDir(),
      generation,
    });

    this.assertGeneration(generation);
    this.update({ state: 'installing', phase: 'creating-python', progress: 8 });
    if (!existsSync(this.venvPython())) {
      if (uv) {
        await this.run(uv, [
          'venv',
          '--python',
          '3.11',
          path.join(this.root(), '.venv'),
        ], { generation });
      } else {
        await this.run(python!, [
          '-m',
          'venv',
          path.join(this.root(), '.venv'),
        ], { generation });
      }
    }
    const venv = this.venvPython();
    await this.run(venv, ['-m', 'ensurepip', '--upgrade'], {
      timeoutMs: 5 * 60_000,
      generation,
    });
    await this.run(venv, [
      '-m',
      'pip',
      'install',
      '--upgrade',
      'pip',
      'setuptools',
      'wheel',
    ], { timeoutMs: 10 * 60_000, generation });
    this.update({ state: 'installing', phase: 'installing-runtime', progress: 15 });
    await this.run(venv, [
      '-m',
      'pip',
      'install',
      ...VIBEVOICE_REQUIREMENTS,
    ], { timeoutMs: 45 * 60_000, generation });
    await this.run(venv, [
      '-m',
      'pip',
      'install',
      '-e',
      this.sourceDir(),
      '--no-deps',
    ], { timeoutMs: 10 * 60_000, generation });

    this.assertGeneration(generation);
    this.update({ state: 'downloading', phase: 'downloading-model', progress: 25 });
    mkdirSync(this.modelDir(), { recursive: true, mode: 0o700 });
    const script = [
      'from huggingface_hub import snapshot_download;',
      `snapshot_download(${JSON.stringify(VIBEVOICE_MODEL_ID)},`,
      `revision=${JSON.stringify(VIBEVOICE_MODEL_REVISION)},`,
      `local_dir=${JSON.stringify(this.modelDir())});`,
      `snapshot_download(${JSON.stringify(QWEN_TOKENIZER_ID)},`,
      `revision=${JSON.stringify(QWEN_TOKENIZER_REVISION)},`,
      `allow_patterns=["config.json","tokenizer.json","tokenizer_config.json","merges.txt","vocab.json"]);`,
    ].join('');
    await this.run(venv, ['-c', script], {
      timeoutMs: 90 * 60_000,
      env: this.childEnvironment({
        HF_HOME: path.join(this.root(), 'hf'),
      }),
      generation,
    });
    this.assertGeneration(generation);
    const qwenRefDir = path.join(
      this.root(),
      'hf',
      'hub',
      'models--Qwen--Qwen2.5-0.5B',
      'refs',
    );
    mkdirSync(qwenRefDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(qwenRefDir, 'main'),
      QWEN_TOKENIZER_REVISION,
      { mode: 0o600 },
    );
    this.update({ state: 'starting', phase: 'installed', progress: 100 });
  }

  private async start(generation: number): Promise<void> {
    this.assertGeneration(generation);
    if (this.server && this.server.exitCode === null && this.serverPort) {
      if (await this.serverReady(this.serverPort)) {
        this.update({ state: 'ready', phase: 'idle', port: this.serverPort });
        return;
      }
      const staleServer = this.server;
      this.server = null;
      this.serverPort = null;
      await this.terminateChild(staleServer);
      this.assertGeneration(generation);
    }
    this.update({ state: 'starting', phase: 'starting-server', error: null });
    const port = await this.availablePort(
      39_000 + (randomBytes(2).readUInt16BE(0) % 10_000),
    );
    const device = this.device();
    const child = spawn(
      this.venvPython(),
      [
        '-m',
        'uvicorn',
        'web.app:app',
        '--app-dir',
        path.join(this.sourceDir(), 'demo'),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--no-access-log',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: this.childEnvironment({
          HF_HOME: path.join(this.root(), 'hf'),
          HF_HUB_OFFLINE: '1',
          MODEL_PATH: this.modelDir(),
          MODEL_DEVICE: device,
        }),
      },
    );
    let spawnError: Error | null = null;
    let output = '';
    const onData = (chunk: Buffer) => {
      output = `${output}${chunk.toString()}`.slice(-8000);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => {
      spawnError = error;
    });
    this.server = child;
    this.serverPort = port;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      this.assertGeneration(generation);
      if (!this.childIsRunning(child)) {
        this.server = null;
        this.serverPort = null;
        throw new Error(
          `VibeVoice server exited (${
            child.exitCode ?? child.signalCode ?? 'unknown'
          }): ${output.slice(-1200)}`,
        );
      }
      if (spawnError) {
        this.server = null;
        this.serverPort = null;
        throw spawnError;
      }
      try {
        if (await this.serverReady(port)) {
          this.update({
            state: 'ready',
            phase: 'idle',
            port,
            device,
            progress: 100,
          });
          return;
        }
      } catch {
        // Model loading can take well over a minute on first start.
      }
      await delay(500);
    }
    await this.terminateChild(child);
    this.server = null;
    this.serverPort = null;
    throw new Error(
      `VibeVoice server did not become ready in two minutes: ${output.slice(-1200)}`,
    );
  }

  private async run(
    executablePath: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
      generation?: number;
    } = {},
  ): Promise<void> {
    if (options.generation !== undefined) {
      this.assertGeneration(options.generation);
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executablePath, args, {
        cwd: options.cwd,
        env: options.env ?? this.childEnvironment(),
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeChildren.add(child);
      let output = '';
      let settled = false;
      const release = () => {
        this.activeChildren.delete(child);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        void this.terminateChild(child);
        reject(new Error(
          `${path.basename(executablePath)} timed out: ${output.slice(-1000)}`,
        ));
      }, options.timeoutMs ?? 30 * 60_000);
      const onData = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-4000);
        const matches = [...output.matchAll(/(\d{1,3})%/g)];
        const percent = Number(matches.at(-1)?.[1]);
        if (Number.isFinite(percent)) {
          this.update({ progress: Math.max(0, Math.min(100, percent)) });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('error', (error) => {
        release();
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code) => {
        release();
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          try {
            if (options.generation !== undefined) {
              this.assertGeneration(options.generation);
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        } else reject(new Error(
          `${path.basename(executablePath)} failed (${code}): ${output.slice(-1000)}`,
        ));
      });
    });
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.lifecycleGeneration) {
      throw new Error('VibeVoice operation was cancelled.');
    }
  }

  private childIsRunning(child: ChildProcess): boolean {
    return child.exitCode === null && child.signalCode === null;
  }

  private signalChild(
    child: ChildProcess,
    signal: NodeJS.Signals,
  ): void {
    if (!this.childIsRunning(child)) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        const result = spawnSync(
          'taskkill.exe',
          [
            '/PID',
            String(child.pid),
            '/T',
            ...(signal === 'SIGKILL' ? ['/F'] : []),
          ],
          { stdio: 'ignore', windowsHide: true },
        );
        if (result.status !== 0 && this.childIsRunning(child)) {
          child.kill(signal);
        }
      } else if (child.pid) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  private async waitForChildExit(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<boolean> {
    if (!this.childIsRunning(child)) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (exited: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off('exit', onExit);
        child.off('error', onExit);
        resolve(exited);
      };
      const onExit = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);
      child.once('exit', onExit);
      child.once('error', onExit);
    });
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (!this.childIsRunning(child)) {
      this.activeChildren.delete(child);
      return;
    }
    this.signalChild(child, 'SIGTERM');
    if (!(await this.waitForChildExit(child, 5_000))) {
      this.signalChild(child, 'SIGKILL');
      await this.waitForChildExit(child, 5_000);
    }
    this.activeChildren.delete(child);
  }

  private async availablePort(start: number): Promise<number> {
    const { createServer } = await import('node:net');
    for (let port = start; port < start + 100; port += 1) {
      const available = await new Promise<boolean>((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve(true));
        });
      });
      if (available) return port;
    }
    throw new Error('No loopback port is available for VibeVoice.');
  }

  private async serverReady(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/config`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return false;
      const config = await response.json() as { voices?: unknown };
      return Array.isArray(config.voices);
    } catch {
      return false;
    }
  }

  private childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const allowed = [
      'PATH',
      'HOME',
      'USERPROFILE',
      'TMPDIR',
      'TEMP',
      'TMP',
      'SystemRoot',
      'ComSpec',
      'LOCALAPPDATA',
      'APPDATA',
      'ProgramFiles',
      'SSL_CERT_FILE',
      'REQUESTS_CA_BUNDLE',
      'CUDA_VISIBLE_DEVICES',
      'DYLD_LIBRARY_PATH',
      'LD_LIBRARY_PATH',
    ];
    const base: NodeJS.ProcessEnv = {};
    for (const key of allowed) {
      if (process.env[key]) base[key] = process.env[key];
    }
    return { ...base, ...extra };
  }

  private update(patch: Partial<VibeVoiceStatus>): void {
    this.current = { ...this.current, ...patch };
    this.emit(this.status());
  }
}
