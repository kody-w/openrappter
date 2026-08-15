import { createHash, randomBytes } from 'node:crypto';
import {
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  NARRATION_MODEL_DOWNLOAD_LABEL,
  NarrationService,
} from './narration.js';
import {
  VIBEVOICE_MODEL_LABEL,
  VibeVoiceService,
} from './vibevoice.js';
import { SECURE_RENDERER_PREFERENCES } from './window-security.js';

const packageRoot = path.join(
  import.meta.dirname,
  '..',
  'runtime',
  'node_modules',
  'openrappter',
);
const gatewayBinary = path.join(packageRoot, 'bin', 'openrappter.mjs');
const uiRoot = path.join(packageRoot, 'ui', 'dist');
const uiIndex = path.join(uiRoot, 'index.html');
const uiRootUrl = pathToFileURL(`${uiRoot}${path.sep}`).href;
let gatewayPort = Number.parseInt(
  process.env.OPENRAPPTER_DESKTOP_PORT ?? '18791',
  10,
);
let gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
const configuredGatewayToken = process.env.OPENRAPPTER_DESKTOP_TOKEN;
const gatewayToken =
  configuredGatewayToken && /^[0-9a-f]{64}$/i.test(configuredGatewayToken)
    ? configuredGatewayToken.toLowerCase()
    : randomBytes(32).toString('hex');
const allowedActions = new Set([
  'start',
  'status',
  'note',
  'capture',
  'observe',
  'stop',
  'analyze',
  'review',
  'build',
  'replay',
  'test',
  'list',
  'delete',
]);

let gatewayProcess: ChildProcess | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let smokeRoot: string | undefined;
let commandTimer: NodeJS.Timeout | undefined;
let processingCommand = false;
let rendererReady = false;
let narrationService: NarrationService | undefined;
let vibeVoiceService: VibeVoiceService | undefined;
let tray: Tray | undefined;
let endpointFile: string | undefined;
let smokeWatchdog: NodeJS.Timeout | undefined;
let smokeFinishing = false;
let microphonePermissionGrantedUntil = 0;
const desktopOwnedSessions = new Set<string>();
let desktopQueue:
  | {
      claimNext(): {
        id: string;
        action: string;
        args: Record<string, unknown>;
        expiresAt: number;
      } | null;
      complete(
        command: { id: string },
        outcome:
          | { status: 'success'; result: unknown }
          | { status: 'error'; error: string },
      ): void;
    }
  | undefined;
let desktopControlAgent:
  | { execute(input: Record<string, unknown>): Promise<string> }
  | undefined;
let showRuntime:
  | {
      agent: { execute(input: Record<string, unknown>): Promise<string> };
      store: {
        initialize(): Promise<void>;
        sessionDir(id: string): string;
        appendEvent(
          sessionId: string,
          type: string,
          source: string,
          data?: Record<string, unknown>,
        ): Promise<unknown>;
        hardenFile(file: string): void;
        database(): {
          prepare(sql: string): {
            run(...params: unknown[]): unknown;
          };
        };
      };
    }
  | undefined;

async function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function chooseGatewayPort(): Promise<void> {
  for (let candidate = gatewayPort; candidate < gatewayPort + 30; candidate += 1) {
    if (await portIsAvailable(candidate)) {
      gatewayPort = candidate;
      gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
      process.env.OPENRAPPTER_PORT = String(gatewayPort);
      process.env.OPENRAPPTER_TOKEN = gatewayToken;
      return;
    }

  }
  throw new Error('No local port is available for OpenRappter Desktop.');
}

async function publishDesktopEndpoint(): Promise<void> {
  const { hardenPrivatePath } = await import(pathToFileURL(
    path.join(
      packageRoot,
      'dist',
      'flight-recorder',
      'permissions.js',
    ),
  ).href) as {
    hardenPrivatePath(target: string, directory?: boolean): void;
  };
  const directory = path.join(os.homedir(), '.openrappter');
  const gatewayPid = gatewayProcess?.pid;
  if (!gatewayPid) {
    throw new Error('Cannot publish a desktop endpoint before gateway readiness.');
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  hardenPrivatePath(directory, true);
  endpointFile = path.join(directory, 'desktop-gateway.json');
  const temporary = `${endpointFile}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({
      schema: 'openrappter-desktop-endpoint/1.0',
      host: '127.0.0.1',
      port: gatewayPort,
      token: gatewayToken,
      pid: gatewayPid,
      ownerPid: process.pid,
      updatedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  if (process.platform !== 'win32') hardenPrivatePath(temporary);
  if (existsSync(endpointFile)) {
    const linked = lstatSync(endpointFile);
    if (linked.isSymbolicLink() || !linked.isFile()) {
      throw new Error('Desktop endpoint path is not a regular file.');
    }
    if (process.platform === 'win32') unlinkSync(endpointFile);
  }
  renameSync(temporary, endpointFile);
}

async function waitForRenderer(window: BrowserWindow): Promise<void> {
  if (
    !window.webContents.isLoadingMainFrame() &&
    window.webContents.getURL().startsWith('file:')
  ) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('OpenRappter Desktop did not finish loading.'));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      window.webContents.off('did-finish-load', finish);
      window.webContents.off('did-fail-load', fail);
      window.webContents.off('render-process-gone', gone);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const fail = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
    ) => {
      cleanup();
      reject(new Error(
        `OpenRappter Desktop load failed (${errorCode}): ${errorDescription}`,
      ));
    };
    const gone = () => {
      cleanup();
      reject(new Error('OpenRappter Desktop renderer exited while loading.'));
    };
    window.webContents.once('did-finish-load', finish);
    window.webContents.once('did-fail-load', fail);
    window.webContents.once('render-process-gone', gone);
  });
}

async function focusWindow(view?: string): Promise<void> {
  if (!mainWindow) mainWindow = createWindow();
  const window = mainWindow;
  await waitForRenderer(window);
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (view) {
    await window.webContents.executeJavaScript(`
      (async () => {
        const app = document.querySelector('openrappter-app');
        if (!app) throw new Error('OpenRappter app surface is not mounted.');
        app.navigate(${JSON.stringify(view)});
        await app.updateComplete;
      })()
    `);
  }
}

function trayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <rect width="22" height="22" rx="6" fill="#10231f"/>
      <path d="M5 13c1.5-5 5-7 9-5 2 1 3 3 2 5-1 2-3 3-5 2l-1 3-2-1 1-3c-2 0-3 0-4-1z" fill="#58f5d2"/>
      <circle cx="13.8" cy="9.7" r="1" fill="#10231f"/>
    </svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  );
  image.setTemplateImage(true);
  return image;
}

function refreshTray(): void {
  if (!tray) return;
  const voice = vibeVoiceService?.status();
  const login = app.getLoginItemSettings().openAtLogin;
  const barPath = process.platform === 'darwin'
    ? '/Applications/OpenRappter Bar.app'
    : '';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open OpenRappter', click: () => void focusWindow().catch(showTrayError) },
    { label: 'Quick Chat', click: () => void focusWindow('chat').catch(showTrayError) },
    {
      label: 'Show-and-Tell',
      click: () => void focusWindow('show-and-tell').catch(showTrayError),
    },
    { type: 'separator' },
    {
      label: `Local voice: ${voice?.state ?? 'not enabled'}`,
      enabled: false,
    },
    {
      label: 'Enable VibeVoice',
      click: () => {
        void (async () => {
          await focusWindow('chat');
          await handleVoice(
            {
              senderFrame: mainWindow!.webContents.mainFrame,
              sender: mainWindow!.webContents,
            } as IpcMainInvokeEvent,
            { action: 'enable' },
          );
        })().catch(showTrayError).finally(refreshTray);
      },
    },
    {
      label: 'Launch OpenRappter Bar',
      visible: process.platform === 'darwin' && existsSync(barPath),
      click: () => {
        void shell.openPath(barPath);
      },
    },
    { type: 'separator' },
    {
      label: 'Open at Login',
      type: 'checkbox',
      checked: login,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        refreshTray();
      },
    },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function createTray(): void {
  tray = new Tray(trayIcon());
  tray.setToolTip('OpenRappter');
  tray.on('click', () => void focusWindow('chat').catch(showTrayError));
  refreshTray();
}

async function showTrayError(error: unknown): Promise<void> {
  await dialog.showMessageBox({
    type: 'error',
    title: 'OpenRappter action failed',
    message: error instanceof Error ? error.message : String(error),
  });
}

async function ensureGateway(): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      gatewayBinary,
      '--daemon',
      '--instance',
      `desktop-${process.pid}`,
      '--port',
      String(gatewayPort),
    ],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPENRAPPTER_DESKTOP: '1',
        OPENRAPPTER_DESKTOP_OWNER_PID: String(process.pid),
        OPENRAPPTER_PORT: String(gatewayPort),
        OPENRAPPTER_TOKEN: gatewayToken,
        ...(smokeRoot
          ? {
              HOME: smokeRoot,
              USERPROFILE: smokeRoot,
              OPENRAPPTER_FLIGHT_RECORDER: '0',
            }
          : {}),
      },
    },
  );
  gatewayProcess = child;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onMessage = (message: unknown) => {
      const ready = message as {
        schema?: unknown;
        pid?: unknown;
        port?: unknown;
      };
      if (
        ready?.schema === 'openrappter-gateway-ready/1.0' &&
        ready.pid === child.pid &&
        ready.port === gatewayPort
      ) {
        finish();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(
        `OpenRappter gateway exited during desktop startup (${
          code ?? signal ?? 'unknown'
        }).`,
      ));
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('OpenRappter gateway did not become ready in 30 seconds.'));
    }, 30_000);
    child.on('error', (error) => finish(error));
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

async function loadShowRuntime() {
  if (showRuntime) return showRuntime;
  const [{ ShowAndTellAgent }, { ShowAndTellStore }] = await Promise.all([
    import(pathToFileURL(
      path.join(packageRoot, 'dist', 'agents', 'ShowAndTellAgent.js'),
    ).href) as Promise<{
      ShowAndTellAgent: new (options?: {
        store?: unknown;
        localSurface?: boolean;
      }) => {
        execute(input: Record<string, unknown>): Promise<string>;
      };
    }>,
    import(pathToFileURL(
      path.join(packageRoot, 'dist', 'show-and-tell', 'store.js'),
    ).href) as Promise<{
      ShowAndTellStore: new (
        root?: string,
        databaseFactory?: (filename: string, options?: {
          readonly?: boolean;
          timeout?: number;
        }) => unknown,
      ) => {
        initialize(): Promise<void>;
        sessionDir(id: string): string;
        appendEvent(
          sessionId: string,
          type: string,
          source: string,
          data?: Record<string, unknown>,
        ): Promise<unknown>;
        hardenFile(file: string): void;
        database(): {
          prepare(sql: string): {
            run(...params: unknown[]): unknown;
          };
        };
      };
    }>,
  ]);
  const store = new ShowAndTellStore();
  await store.initialize();
  showRuntime = {
    agent: new ShowAndTellAgent({ store, localSurface: true }),
    store,
  };
  return showRuntime!;
}

function narration(): NarrationService {
  narrationService ??= new NarrationService((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('openrappter:narration-status', status);
    }
  });
  return narrationService;
}

function vibeVoice(): VibeVoiceService {
  vibeVoiceService ??= new VibeVoiceService((status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('openrappter:voice-status', status);
    }
  });
  return vibeVoiceService;
}

async function runWhisperModelSmoke(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('The bundled Whisper speech fixture currently requires macOS.');
  }

  const scratch = mkdtempSync(
    path.join(app.getPath('temp'), 'openrappter-whisper-'),
  );
  try {
    const aiff = path.join(scratch, 'voice.aiff');
    const raw = path.join(scratch, 'voice.f32le');
    const phrase =
      'OpenRappter local narration is working and this sentence stays on the device.';
    const spoken = spawnSync('/usr/bin/say', ['-o', aiff, phrase], {
      encoding: 'utf8',
    });
    if (spoken.status !== 0) throw new Error(spoken.stderr);
    const ffmpeg = existsSync('/opt/homebrew/bin/ffmpeg')
      ? '/opt/homebrew/bin/ffmpeg'
      : 'ffmpeg';
    const converted = spawnSync(ffmpeg, [
      '-loglevel',
      'error',
      '-y',
      '-i',
      aiff,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'f32le',
      raw,
    ], { encoding: 'utf8' });
    if (converted.status !== 0) throw new Error(converted.stderr);
    const audio = readFileSync(raw);
    const samples = new Float32Array(
      audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    );
    await narration().download();
    const transcript = await narration().transcribe(samples, 'en');
    const normalized = transcript.text.toLowerCase();
    if (
      !normalized.includes('openrappter') &&
      !normalized.includes('local narration')
    ) {
      throw new Error(`Unexpected Whisper transcript: ${transcript.text}`);
    }
    console.log(
      `OPENRAPPTER_WHISPER_SMOKE ${JSON.stringify({
        model: transcript.model,
        text: transcript.text,
      })}`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function runVibeVoiceModelSmoke(): Promise<void> {
  await vibeVoice().enable();
  const wav = await vibeVoice().speak(
    'OpenRappter local voice is running entirely on this device.',
    'en-Carter_man',
  );
  if (
    wav.length <= 44 ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('VibeVoice did not return a valid WAV file.');
  }
  console.log(
    `OPENRAPPTER_VIBEVOICE_SMOKE ${JSON.stringify({
      bytes: wav.length,
      status: vibeVoice().status(),
    })}`,
  );
  await vibeVoice().stop();
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error('Narration payload is not binary audio.');
}

async function handleNarration(
  event: IpcMainInvokeEvent,
  request: unknown,
): Promise<unknown> {
  const input = validateTrustedRequest(event, request);
  const action = input.action;
  if (action === 'status') return narration().status();
  if (action === 'download') {
    if (process.env.OPENRAPPTER_DESKTOP_SMOKE !== '1') {
      const approval = await dialog.showMessageBox(mainWindow!, {
        type: 'question',
        title: 'Download local Whisper?',
        message: 'Download the on-device narration model?',
        detail:
          `Whisper Small q8 is ${NARRATION_MODEL_DOWNLOAD_LABEL}. ` +
          'It is downloaded once, cached locally, and used offline. Audio never leaves this device.',
        buttons: ['Cancel', 'Download model'],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
      });
      if (approval.response !== 1) {
        throw new Error('Whisper download was cancelled.');
      }
    }
    return narration().download();
  }
  if (action !== 'transcribe') {
    throw new Error(`Unsupported narration action: ${String(action)}`);
  }

  const sessionId =
    typeof input.session_id === 'string' ? input.session_id : '';
  const language =
    typeof input.language === 'string' && /^[a-z]{2,3}$/i.test(input.language)
      ? input.language.toLowerCase()
      : 'en';
  if (!sessionId) throw new Error('A Show-and-Tell session is required.');
  const audio = bytes(input.audio);
  const sampleBytes = bytes(input.samples);
  if (sampleBytes.byteLength % 4 !== 0) {
    throw new Error('Narration samples are not Float32 audio.');
  }
  const samples = new Float32Array(
    sampleBytes.buffer.slice(
      sampleBytes.byteOffset,
      sampleBytes.byteOffset + sampleBytes.byteLength,
    ),
  );
  const transcript = await narration().transcribe(samples, language);
  if (!transcript.text) {
    throw new Error('Whisper did not detect meaningful narration.');
  }

  const runtime = await loadShowRuntime();
  const audioDir = path.join(runtime.store.sessionDir(sessionId), 'audio');
  mkdirSync(audioDir, { recursive: true, mode: 0o700 });
  const filename = `narration-${Date.now()}-${randomBytes(4).toString('hex')}.webm`;
  const audioFile = path.join(audioDir, filename);
  writeFileSync(audioFile, audio, { mode: 0o600 });
  runtime.store.hardenFile(audioFile);
  await runtime.store.appendEvent(
    sessionId,
    'narration.transcribed',
    'local-whisper',
    {
      model: transcript.model,
      language,
      text: transcript.text,
      audioFile: path.posix.join('audio', filename),
      segments: transcript.segments,
    },
  );
  return transcript;
}

async function handleVoice(
  event: IpcMainInvokeEvent,
  request: unknown,
): Promise<unknown> {
  const input = validateTrustedRequest(event, request);
  const action = input.action;
  if (action === 'status') return vibeVoice().status();
  if (action === 'stop') {
    await vibeVoice().stop();
    return vibeVoice().status();
  }
  if (action === 'enable') {
    if (process.env.OPENRAPPTER_DESKTOP_SMOKE !== '1') {
      const approval = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'Enable local VibeVoice?',
        message: 'Install Microsoft VibeVoice Realtime locally?',
        detail:
          `The preview downloads about ${VIBEVOICE_MODEL_LABEL} of model weights, ` +
          'creates an isolated Python 3.11 environment, and runs only on 127.0.0.1. ' +
          'Do not use it for impersonation, deception, or undisclosed synthetic speech.',
        buttons: ['Cancel', 'Enable local voice'],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
      });
      if (approval.response !== 1) {
        throw new Error('VibeVoice setup was cancelled.');
      }
    }
    return vibeVoice().enable();
  }
  if (action !== 'speak') {
    throw new Error(`Unsupported voice action: ${String(action)}`);
  }
  if (!vibeVoice().isInstalled()) {
    throw new Error(
      'Enable local VibeVoice and approve its model download before speaking.',
    );
  }
  const text = typeof input.text === 'string' ? input.text : '';
  const voice =
    typeof input.voice === 'string' ? input.voice : 'en-Carter_man';
  const audio = await vibeVoice().speak(text, voice);
  return {
    status: 'success',
    voice,
    mimeType: 'audio/wav',
    audio: new Uint8Array(audio),
  };
}

async function loadDesktopControlRuntime() {
  if (desktopQueue && desktopControlAgent) {
    return { queue: desktopQueue!, agent: desktopControlAgent! };
  }
  const [{ DesktopCommandQueue }, { DesktopControlAgent }] = await Promise.all([
    import(pathToFileURL(
      path.join(packageRoot, 'dist', 'desktop-control', 'queue.js'),
    ).href) as Promise<{
      DesktopCommandQueue: new () => NonNullable<typeof desktopQueue>;
    }>,
    import(pathToFileURL(
      path.join(packageRoot, 'dist', 'agents', 'DesktopControlAgent.js'),
    ).href) as Promise<{
      DesktopControlAgent: new (
        queue?: NonNullable<typeof desktopQueue>,
      ) => NonNullable<typeof desktopControlAgent>;
    }>,
  ]);
  desktopQueue = new DesktopCommandQueue();
  desktopControlAgent = new DesktopControlAgent(desktopQueue);
  return { queue: desktopQueue!, agent: desktopControlAgent! };
}

function trustedRenderer(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? event.sender.getURL();
  return url === pathToFileURL(uiIndex).href || url.startsWith(uiRootUrl);
}

async function nativeConsent(
  purpose: 'start' | 'capture' | 'approve' | 'delete',
): Promise<boolean> {
  const copy = {
    start: {
      title: 'Start Show-and-Tell?',
      detail:
        'OpenRappter will record active app/window changes. Screenshots remain explicit-only. Keep passwords, tokens, and private material off screen.',
      button: 'Start recording',
    },
    capture: {
      title: 'Capture this window?',
      detail:
        'Only the currently validated active window will be saved as a private local frame.',
      button: 'Capture window',
    },
    approve: {
      title: 'Approve this workflow?',
      detail:
        'The reviewed intent and steps will become the exact source for generated skills and automations.',
      button: 'Approve workflow',
    },
    delete: {
      title: 'Delete this recording?',
      detail:
        'The local session, events, and captured frames will be permanently removed.',
      button: 'Delete recording',
    },
  }[purpose];
  const result = await dialog.showMessageBox(mainWindow!, {
    type: purpose === 'delete' ? 'warning' : 'question',
    title: copy.title,
    message: copy.title,
    detail: copy.detail,
    buttons: ['Cancel', copy.button],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  });
  return result.response === 1;
}

async function seedConsent(
  purpose: 'start' | 'capture' | 'approve' | 'delete',
): Promise<string> {
  const runtime = await loadShowRuntime();
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  runtime.store.database()
    .prepare(
      'INSERT INTO show_consents(token_hash, purpose, issued_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .run(
      createHash('sha256').update(token).digest('hex'),
      purpose,
      now,
      now + 60_000,
    );
  return token;
}

function validateTrustedRequest(
  event: IpcMainInvokeEvent,
  request: unknown,
): Record<string, unknown> {
  if (!trustedRenderer(event)) throw new Error('Untrusted desktop renderer.');
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid desktop request.');
  }
  return { ...(request as Record<string, unknown>) };
}

function scanAgentCapabilities(filename: string, source: string): string[] {
    const capabilities = new Set<string>(['dynamic-code']);
    const checks: Array<[RegExp, string]> = [
      [/\b(?:child_process|subprocess|Popen|os\.system|execFile|spawn)\b/, 'process-exec'],
      [/\b(?:writeFile|appendFile|unlink|rename|mkdir|rmdir|shutil|Path\([^)]*\)\.write|open\([^)]*,\s*['"][wa])/i, 'filesystem-write'],
      [/\b(?:readFile|readdir|statSync|Path\([^)]*\)\.read|open\()/i, 'filesystem-read'],
      [/\b(?:fetch\(|https?\.|requests\.|urllib\.|socket\b|WebSocket)\b/i, 'network'],
      [/\b(?:process\.env|os\.environ|getenv|keychain|credential|token|secret)\b/i, 'credential-access'],
      [/\b(?:ui_commands|DesktopControl|desktop-control)\b/i, 'ui-control'],
    ];
    for (const [pattern, capability] of checks) {
      if (pattern.test(source)) capabilities.add(capability);
    }
    if (/\.py$/i.test(filename)) capabilities.add('python');
    if (/\.tsx?$/i.test(filename)) capabilities.add('typescript');
    return [...capabilities].sort();
}

async function compileAgentForImport(
    filename: string,
    source: string,
  ): Promise<{ filename: string; contents: string }> {
    const leaf = path.basename(filename).replace(/[^A-Za-z0-9._-]/g, '_');
    if (/\.py$/i.test(leaf)) return { filename: leaf, contents: source };
    if (/\.js$/i.test(leaf)) {
      if (!/_agent\.js$/i.test(leaf)) {
        throw new Error('JavaScript agents must be named *_agent.js.');
      }
      return { filename: leaf, contents: source };
    }
    if (!/_agent\.ts$/i.test(leaf)) {
      throw new Error('TypeScript agents must be named *_agent.ts.');
    }
    if (!/\bcreateAgent\s*\(/.test(source)) {
      throw new Error(
        'Hot-loaded TypeScript agents must export createAgent(BasicAgent).',
      );
    }
    const ts = await import('typescript');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        strict: true,
      },
      fileName: leaf,
      reportDiagnostics: true,
    });
    const errors = (compiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    if (errors.length) {
      throw new Error(
        `TypeScript agent did not compile: ${errors
          .map((diagnostic) => ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            ' ',
          ))
          .join('; ')}`,
      );
    }
    return {
      filename: leaf.replace(/\.ts$/i, '.js'),
      contents: compiled.outputText,
    };
}

async function installAgentFromCommand(
    args: Record<string, unknown>,
    expiresAt: number,
  ): Promise<unknown> {
    const filename = typeof args.filename === 'string' ? args.filename : '';
    const source = typeof args.source === 'string' ? args.source : '';
    if (!filename || !source) throw new Error('filename and source are required.');
    if (Buffer.byteLength(source, 'utf8') > 500_000) {
      throw new Error('Agent source exceeds the 500 KB desktop approval limit.');
    }
    const compiled = await compileAgentForImport(filename, source);
    const capabilities = scanAgentCapabilities(compiled.filename, source);
    if (Date.now() > expiresAt) {
      throw new Error('Agent installation request expired before approval.');
    }
    if (process.env.OPENRAPPTER_DESKTOP_SMOKE !== '1') {
      const hash = createHash('sha256').update(source).digest('hex');
      const approval = await dialog.showMessageBox(mainWindow!, {
        type: 'warning',
        title: 'Install a hot-loaded agent?',
        message: `Install ${compiled.filename}?`,
        detail:
          `This code will run with your full user authority after verification. ` +
          `The capability list is a heuristic, not a sandbox.\n\n` +
          `Detected hints: ${capabilities.join(', ')}\n` +
          `SHA-256: ${hash}`,
        buttons: ['Cancel', 'Install agent'],
        cancelId: 0,
        defaultId: 0,
        noLink: true,
      });
      if (approval.response !== 1) {
        throw new Error('Agent installation was cancelled.');
      }
    }
    if (Date.now() > expiresAt) {
      throw new Error('Agent installation request expired before import.');
    }
    const response = await fetch(`${gatewayOrigin}/agents/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify(compiled),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json() as Record<string, unknown>;
    if (!response.ok || result.status !== 'ok') {
      throw new Error(String(result.error ?? 'Agent import failed.'));
    }
    return {
      ...result,
      sourceFilename: path.basename(filename),
      installedFilename: compiled.filename,
      detectedCapabilities: capabilities,
    };
}

async function dispatchRendererCommand(
    command: { action: string; args: Record<string, unknown> },
  ): Promise<unknown> {
    if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) {
      throw new Error('OpenRappter Desktop renderer is not ready.');
    }
    const encoded = Buffer.from(JSON.stringify(command), 'utf8').toString('base64');
    return mainWindow.webContents.executeJavaScript(`
      window.__openrappterDesktopCommand(
        JSON.parse(atob(${JSON.stringify(encoded)}))
      )
    `);
}

async function processDesktopCommands(): Promise<void> {
    if (processingCommand || !rendererReady) return;
    const { queue } = await loadDesktopControlRuntime();
    const command = queue.claimNext();
    if (!command) return;
    processingCommand = true;
    try {
      const result = command.action === 'install_agent'
        ? await installAgentFromCommand(command.args, command.expiresAt)
        : await dispatchRendererCommand(command);
      queue.complete(command, { status: 'success', result });
    } catch (error) {
      queue.complete(command, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      processingCommand = false;
    }
}

function startDesktopCommandPump(): void {
    if (commandTimer) return;
    commandTimer = setInterval(() => {
      void processDesktopCommands();
    }, 100);
    commandTimer.unref();
}

async function invokeAgentForSmoke(agentName: string): Promise<unknown> {
  if (process.env.OPENRAPPTER_DESKTOP_SMOKE !== '1' || !smokeRoot) {
    throw new Error('Smoke agent invocation is unavailable.');
  }
  const mcp = path.join(packageRoot, 'dist', 'mcp', 'stdio.js');
  const request = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: agentName,
      arguments: {},
    },
  })}\n`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [mcp], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HOME: smokeRoot,
        USERPROFILE: smokeRoot,
        OPENRAPPTER_FLIGHT_RECORDER: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Smoke agent invocation timed out.'));
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(stderr || `MCP child exited ${code}`));
        return;
      }
      const line = stdout
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.startsWith('{'));
      resolve(line ? JSON.parse(line) : { stdout });
    });
    child.stdin.end(request);
  });
}

async function handleShowAndTell(
  event: IpcMainInvokeEvent,
  request: unknown,
): Promise<unknown> {
  const input = validateTrustedRequest(event, request);
  const action = typeof input.action === 'string' ? input.action : '';
  if (!allowedActions.has(action)) {
    throw new Error(`Unsupported Show-and-Tell action: ${action}`);
  }
  delete input.consent_token;
  const smokeBypass =
    process.env.OPENRAPPTER_DESKTOP_SMOKE === '1' &&
    input.__smoke === true;
  delete input.__smoke;
  if (action === 'start') input._desktop_owner_pid = process.pid;

  let purpose: 'start' | 'capture' | 'approve' | 'delete' | undefined;
  if (action === 'start') purpose = 'start';
  else if (action === 'capture') purpose = 'capture';
  else if (action === 'delete') purpose = 'delete';
  else if (action === 'review' && input.approve === true) purpose = 'approve';
  if (purpose) {
    if (!smokeBypass && !(await nativeConsent(purpose))) {
      return {
        status: 'error',
        action,
        code: 'cancelled',
        message: 'Action cancelled.',
      };
    }
    input.consent_token = await seedConsent(purpose);
  }
  if (action === 'analyze') input.enhance = false;

  const runtime = await loadShowRuntime();
  const result = JSON.parse(await runtime.agent.execute(input)) as Record<string, unknown>;
  const session = result.session as { id?: unknown } | undefined;
  const sessionId =
    typeof session?.id === 'string'
      ? session.id
      : typeof result.session_id === 'string'
        ? result.session_id
        : typeof input.session_id === 'string'
          ? input.session_id
          : undefined;
  if (action === 'start' && result.status === 'success' && sessionId) {
    desktopOwnedSessions.add(sessionId);
  }
  if (
    ['stop', 'delete'].includes(action) &&
    result.status === 'success' &&
    sessionId
  ) {
    desktopOwnedSessions.delete(sessionId);
  }
  return result;
}

async function stopOwnedShowSessions(): Promise<void> {
  if (desktopOwnedSessions.size === 0) return;
  const runtime = await loadShowRuntime();
  await Promise.allSettled(
    [...desktopOwnedSessions].map((sessionId) =>
      runtime.agent.execute({ action: 'stop', session_id: sessionId })),
  );
  desktopOwnedSessions.clear();
}

function createWindow(): BrowserWindow {
  if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
    console.log(`OPENRAPPTER_DESKTOP_SMOKE create-window ui=${uiIndex}`);
  }
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 700,
    show: false,
    title: 'OpenRappter',
    backgroundColor: '#050711',
    webPreferences: {
      preload: path.join(import.meta.dirname, 'preload.cjs'),
      ...SECURE_RENDERER_PREFERENCES,
    },
  });
  window.removeMenu();
  window.webContents.on('did-finish-load', () => {
    rendererReady = true;
    startDesktopCommandPump();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(uiIndex).href && !url.startsWith(uiRootUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    rendererReady = false;
    if (
      quitting ||
      details.reason === 'clean-exit' ||
      window.isDestroyed()
    ) {
      return;
    }
    setTimeout(() => {
      if (!quitting && !window.isDestroyed()) window.webContents.reload();
    }, 250);
  });
  window.once('ready-to-show', () => window.show());
  if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
    window.webContents.once('did-finish-load', () => {
      void window.webContents.executeJavaScript(`
        (async () => {
          await customElements.whenDefined('openrappter-show-and-tell');
          const appElement = document.querySelector('openrappter-app');
          const deadline = Date.now() + 15000;
          while (
            Date.now() < deadline &&
            (!appElement?.shadowRoot ||
              /Waking the OpenRappter patient|patient is unreachable/.test(
                appElement.shadowRoot.textContent || ''
              ))
          ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (!appElement?.shadowRoot) throw new Error('OpenRappter app did not render');
          if (/patient is unreachable/.test(appElement.shadowRoot.textContent || '')) {
            throw new Error('OpenRappter UI could not connect to the gateway');
          }
          const smokeScope = ${JSON.stringify(
            process.env.OPENRAPPTER_DESKTOP_SMOKE_SCOPE ?? 'full',
          )};
          let recorder = null;
          if (smokeScope !== 'boot') {
            appElement.navigate('show-and-tell');
            await appElement.updateComplete;
            recorder = appElement.shadowRoot.querySelector(
              'openrappter-show-and-tell'
            );
            await recorder?.updateComplete;
          }
          const info = await window.openrappterDesktop.getInfo();
          const narrationStatus = await window.openrappterDesktop.narration({
            action: 'status'
          });
          const voiceStatus = await window.openrappterDesktop.voice({
            action: 'status'
          });
          if (smokeScope === 'boot') {
            return {
              smokeScope: 'boot',
              bridge: Boolean(window.openrappterDesktop),
              component: Boolean(customElements.get('openrappter-show-and-tell')),
              narrationBridge: Boolean(narrationStatus.model),
              voiceBridge: Boolean(voiceStatus.state),
              gatewayUrl: window.openrappterDesktop.gatewayUrl,
              platform: info.platform,
              protocol: location.protocol,
            };
          }
          const status = await window.openrappterDesktop.showAndTell({
            action: 'status'
          });
          const controlSnapshot = await window.openrappterDesktop.desktopControl({
            action: 'snapshot'
          });
          const controlled = await window.openrappterDesktop.desktopControl({
            action: 'navigate',
            view: 'show-and-tell'
          });
          const installed = await window.openrappterDesktop.desktopControl({
            action: 'install_agent',
            filename: 'desktop_smoke_agent.ts',
            source:
              "export function createAgent(BasicAgent: any) {\\n" +
              "  return class DesktopSmokeAgent extends BasicAgent {\\n" +
              "    constructor() { super('DesktopSmoke', { name: 'DesktopSmoke', description: 'Smoke agent that can drive the UI.', parameters: { type: 'object', properties: {}, required: [] } }); }\\n" +
              "    async perform() { return JSON.stringify({ status: 'success', ui_commands: [{ action: 'navigate', view: 'agents' }] }); }\\n" +
              "  };\\n" +
              "}\\n"
          });
          const agentRun = await window.openrappterDesktop.desktopControl({
            action: '__smoke_invoke_agent',
            agent: 'DesktopSmoke'
          });
          const agentSnapshot = await window.openrappterDesktop.desktopControl({
            action: 'snapshot'
          });
          const installedPython = await window.openrappterDesktop.desktopControl({
            action: 'install_agent',
            filename: 'desktop_python_smoke_agent.py',
            source:
              "import json\\n" +
              "from openrappter.agents.basic_agent import BasicAgent\\n" +
              "class DesktopPythonSmokeAgent(BasicAgent):\\n" +
              "    def __init__(self):\\n" +
              "        self.name = 'DesktopPythonSmoke'\\n" +
              "        self.metadata = {'name': self.name, 'description': 'Python smoke agent that can drive the UI.', 'parameters': {'type': 'object', 'properties': {}, 'required': []}}\\n" +
              "        super().__init__(name=self.name, metadata=self.metadata)\\n" +
              "    def perform(self, **kwargs):\\n" +
              "        return json.dumps({'status': 'success', 'ui_commands': [{'action': 'navigate', 'view': 'skills'}]})\\n"
          });
          const pythonRun = await window.openrappterDesktop.desktopControl({
            action: '__smoke_invoke_agent',
            agent: 'DesktopPythonSmoke'
          });
          const pythonSnapshot = await window.openrappterDesktop.desktopControl({
            action: 'snapshot'
          });
          const started = await window.openrappterDesktop.showAndTell({
            action: 'start',
            intent: 'Electron recorder smoke',
            poll_interval_ms: 60000,
            max_duration_ms: 60000,
            __smoke: true
          });
          await new Promise((resolve) => setTimeout(resolve, 800));
          const live = await window.openrappterDesktop.showAndTell({
            action: 'status',
            session_id: started.session.id
          });
          const stopped = await window.openrappterDesktop.showAndTell({
            action: 'stop',
            session_id: started.session.id
          });
          return {
            smokeScope: 'full',
            bridge: Boolean(window.openrappterDesktop),
            component: Boolean(customElements.get('openrappter-show-and-tell')),
            recorderSurface: /Show it once/.test(
              recorder?.shadowRoot?.textContent || ''
            ),
            recorderStatus: status.status,
            desktopControl:
              controlSnapshot.status === 'success' &&
              controlled.status === 'success' &&
              controlled.result.view === 'show-and-tell',
            hotLoadedAgents:
              installed.status === 'success' &&
              installed.result.status === 'ok' &&
              installed.result.installedFilename === 'desktop_smoke_agent.js' &&
              agentRun.status === 'success' &&
              agentSnapshot.result.view === 'agents' &&
              installedPython.status === 'success' &&
              installedPython.result.status === 'ok' &&
              installedPython.result.installedFilename === 'desktop_python_smoke_agent.py' &&
              pythonRun.status === 'success' &&
              pythonSnapshot.result.view === 'skills',
            narrationBridge: Boolean(narrationStatus.model),
            voiceBridge: Boolean(voiceStatus.state),
            recorderLifecycle:
              started.status === 'success' &&
              live.collector_healthy === true &&
              stopped.session.state === 'stopped',
            gatewayUrl: window.openrappterDesktop.gatewayUrl,
            platform: info.platform,
            protocol: location.protocol,
          };
        })()
      `).then((result) => {
        console.log(`OPENRAPPTER_DESKTOP_SMOKE ${JSON.stringify(result)}`);
        const required = [
          'bridge',
          'component',
          'narrationBridge',
          'voiceBridge',
        ] as const;
        const fullRequired = [
          'recorderSurface',
          'desktopControl',
          'hotLoadedAgents',
          'recorderLifecycle',
        ] as const;
        if (
          (
            result.smokeScope !== 'boot' &&
            result.recorderStatus !== 'success'
          ) ||
          result.protocol !== 'file:' ||
          !required.every((key) => result[key] === true) ||
          (
            result.smokeScope !== 'boot' &&
            !fullRequired.every((key) => result[key] === true)
          )
        ) {
          process.exitCode = 1;
        }
        void finishDesktopSmoke(
          typeof process.exitCode === 'number' ? process.exitCode : 0,
        );
      }).catch((error) => {
        console.error(`OPENRAPPTER_DESKTOP_SMOKE_ERROR ${String(error)}`);
        process.exitCode = 1;
        void finishDesktopSmoke(1);
      });
    });
  }
  window.on('closed', () => {
    rendererReady = false;
    mainWindow = null;
  });
  void window.loadFile(uiIndex).catch((error) => {
    console.error(`OPENRAPPTER_DESKTOP_LOAD_ERROR ${String(error)}`);
  });
  return window;
}

async function stopOwnedGateway(): Promise<void> {
  const child = gatewayProcess;
  gatewayProcess = null;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

async function finishDesktopSmoke(exitCode: number): Promise<void> {
  if (smokeFinishing) return;
  smokeFinishing = true;
  if (smokeWatchdog) clearTimeout(smokeWatchdog);
  await Promise.allSettled([
    stopOwnedShowSessions(),
    stopOwnedGateway(),
    vibeVoiceService?.stop() ?? Promise.resolve(),
  ]);
  process.exit(exitCode);
}

if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
  console.log('OPENRAPPTER_DESKTOP_SMOKE boot');
}
const ownsInstanceLock = app.requestSingleInstanceLock();
if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
  console.log(`OPENRAPPTER_DESKTOP_SMOKE lock=${ownsInstanceLock}`);
}
if (!ownsInstanceLock) {
  if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
    console.error('OPENRAPPTER_DESKTOP_SMOKE_ERROR instance lock unavailable');
    app.exit(1);
  } else {
    app.quit();
  }
} else {
  if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
    for (const eventName of ['ready', 'window-all-closed', 'before-quit', 'will-quit', 'quit']) {
      app.on(eventName as 'ready', () => {
        console.log(`OPENRAPPTER_DESKTOP_SMOKE event=${eventName}`);
      });
    }
  }
  app.on('second-instance', () => {
    void focusWindow().catch(showTrayError);
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!gatewayProcess && !vibeVoiceService) return;
    event.preventDefault();
    quitting = true;
    void Promise.all([
      stopOwnedShowSessions(),
      stopOwnedGateway(),
      vibeVoiceService?.stop() ?? Promise.resolve(),
    ]).finally(() => app.quit());
  });

  app.on('window-all-closed', () => {
    // The tray is the persistent desktop projection on every platform.
  });

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow();
  });

  void app.whenReady().then(async () => {
    if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
      console.log('OPENRAPPTER_DESKTOP_SMOKE ready-handler');
      smokeRoot = path.join(
        app.getPath('temp'),
        `openrappter-desktop-smoke-${process.pid}`,
      );
      process.env.OPENRAPPTER_SHOW_AND_TELL_DIR = smokeRoot;
      process.env.OPENRAPPTER_SHOW_TEST_MODE = '1';
      process.env.OPENRAPPTER_DESKTOP_CONTROL_DIR = path.join(
        smokeRoot,
        'desktop-control',
      );
      smokeWatchdog = setTimeout(() => {
        console.error('OPENRAPPTER_DESKTOP_SMOKE_ERROR timed out after three minutes');
        void finishDesktopSmoke(1);
      }, 180_000);
    }
    try {
      await chooseGatewayPort();
      if (process.env.OPENRAPPTER_DESKTOP_WHISPER_SMOKE === '1') {
        await runWhisperModelSmoke();
        app.exit(0);
        return;
      }
      if (process.env.OPENRAPPTER_DESKTOP_VIBEVOICE_SMOKE === '1') {
        await runVibeVoiceModelSmoke();
        app.exit(0);
        return;
      }
      const bootSmoke =
        process.env.OPENRAPPTER_DESKTOP_SMOKE === '1' &&
        process.env.OPENRAPPTER_DESKTOP_SMOKE_SCOPE === 'boot';
      session.defaultSession.webRequest.onBeforeSendHeaders(
        { urls: [`ws://127.0.0.1:${gatewayPort}/*`] },
        (details, callback) => {
          callback({
            requestHeaders: {
              ...details.requestHeaders,
              Origin: gatewayOrigin,
            },
          });
        },
      );
      session.defaultSession.setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
          const trusted =
            permission === 'media' &&
            trustedRenderer({
              senderFrame: webContents.mainFrame,
              sender: webContents,
            } as IpcMainInvokeEvent);
          const mediaTypes =
            'mediaTypes' in details ? details.mediaTypes : undefined;
          const audioOnly =
            !mediaTypes ||
            mediaTypes.every((type: string) => type === 'audio');
          if (!trusted || !audioOnly) {
            callback(false);
            return;
          }
          if (Date.now() < microphonePermissionGrantedUntil) {
            callback(true);
            return;
          }
          void dialog.showMessageBox(mainWindow!, {
            type: 'question',
            title: 'Allow local narration?',
            message: 'Allow OpenRappter to use the microphone?',
            detail:
              'Audio is recorded only for the active Show-and-Tell narration and transcribed locally with Whisper.',
            buttons: ['Cancel', 'Allow microphone'],
            cancelId: 0,
            defaultId: 0,
            noLink: true,
          }).then((result) => {
            if (result.response === 1) {
              microphonePermissionGrantedUntil = Date.now() + 5 * 60_000;
              callback(true);
            } else {
              callback(false);
            }
          }).catch(() => callback(false));
        },
      );
      ipcMain.handle('openrappter:show-and-tell', handleShowAndTell);
      ipcMain.handle('openrappter:narration', handleNarration);
      ipcMain.handle('openrappter:voice', handleVoice);
      ipcMain.handle(
        'openrappter:desktop-control',
        async (event, request: unknown) => {
          if (!trustedRenderer(event)) {
            throw new Error('Untrusted desktop renderer.');
          }
          if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new Error('Invalid desktop control request.');
          }
          const input = request as Record<string, unknown>;
          if (
            process.env.OPENRAPPTER_DESKTOP_SMOKE === '1' &&
            input.action === '__smoke_invoke_agent'
          ) {
            return {
              status: 'success',
              result: await invokeAgentForSmoke(String(input.agent ?? '')),
            };
          }
          const { agent } = await loadDesktopControlRuntime();
          return JSON.parse(
            await agent.execute(input),
          );
        },
      );
      ipcMain.handle('openrappter:desktop-info', () => ({
        platform: process.platform,
        electron: process.versions.electron,
        gateway: gatewayOrigin,
      }));
      if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
        console.log('OPENRAPPTER_DESKTOP_SMOKE ensure-gateway');
      }
      await ensureGateway();
      if (process.env.OPENRAPPTER_DESKTOP_SMOKE === '1') {
        console.log('OPENRAPPTER_DESKTOP_SMOKE gateway-ready');
      }
      if (!bootSmoke) await publishDesktopEndpoint();
      mainWindow = createWindow();
      if (!bootSmoke) createTray();
    } catch (error) {
      if (
        process.env.OPENRAPPTER_DESKTOP_SMOKE === '1' ||
        process.env.OPENRAPPTER_DESKTOP_WHISPER_SMOKE === '1' ||
        process.env.OPENRAPPTER_DESKTOP_VIBEVOICE_SMOKE === '1'
      ) {
        console.error(
          `OPENRAPPTER_SMOKE_ERROR ${
            error instanceof Error ? error.stack ?? error.message : String(error)
          }`,
        );
        process.exitCode = 1;
        await finishDesktopSmoke(1);
        return;
      }
      await dialog.showMessageBox({
        type: 'error',
        title: 'OpenRappter could not start',
        message: 'The local OpenRappter gateway did not start.',
        detail: error instanceof Error ? error.message : String(error),
      });
      app.quit();
    }
  });

  app.on('quit', () => {
    if (smokeWatchdog) clearTimeout(smokeWatchdog);
    if (commandTimer) clearInterval(commandTimer);
    if (smokeRoot) {
      rmSync(smokeRoot, { recursive: true, force: true });
    }
    if (endpointFile) {
      try {
        const endpoint = JSON.parse(
          readFileSync(endpointFile, 'utf8'),
        ) as { pid?: unknown };
        if (endpoint.pid === process.pid) rmSync(endpointFile, { force: true });
      } catch {
        // A newer desktop process may own the endpoint.
      }
    }
  });
}
