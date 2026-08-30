import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';

import { getEffectiveFeatures, type EffectiveFeatures } from '../../config/features.js';
import { buildChatEnvelope, type ChatEnvelope } from '../../gateway/chat-envelope.js';
import { parseChatRequest } from '../../gateway/chat-request.js';
import {
  assertIdentityBinding,
  currentLiveIdentity,
  type LiveRappIdentity,
} from '../../infra/process-identity.js';
import { openrappterPath } from '../../infra/openrappter-home.js';
import {
  CopilotAuthority,
  redactCopilotSecrets,
} from '../../providers/copilot-authority.js';
import { COPILOT_DEFAULT_MODEL } from '../../providers/copilot-models.js';
import { parseRappChatEnvelope } from '../http-participant.js';
import {
  RAPP_CHAT_PROTOCOL,
  RappParticipantAbortedError,
  RappParticipantIdentityDriftError,
  RappParticipantProtocolError,
  RappParticipantTimeoutError,
  type RappParticipant,
  type RappParticipantChatRequest,
  type RappParticipantDescriptor,
  type RappParticipantOperation,
  type RappParticipantStatus,
} from '../participant.js';

export const HERMES_MODEL_AUTHORITY = 'github-copilot-cli' as const;
export const HERMES_TRANSPORT = 'copilot-acp' as const;
export const HERMES_RECEIPT_SCHEMA = 'openrappter.hermes-adapter-receipt/1' as const;
export const DEFAULT_HERMES_HEALTH_TIMEOUT_MS = 30_000;
export const DEFAULT_HERMES_CHAT_TIMEOUT_MS = 120_000;
export const DEFAULT_HERMES_OUTPUT_LIMIT_BYTES = 1024 * 1024;
export const DEFAULT_HERMES_MAX_INPUT_BYTES = 256 * 1024;
export const MAX_HERMES_TIMEOUT_MS = 300_000;

const HERMES_ENDPOINT = 'process://hermes';
const HEALTH_SENTINEL = 'OPENRAPPTER_HERMES_ACP_READY';
const REQUIRED_HELP_MARKERS = [
  '--provider PROVIDER',
  '--safe-mode',
  '--source SOURCE',
  '--run-budget SECONDS',
  '--query-file PATH',
  '--quiet',
] as const;
const SAFE_ENV_KEYS = [
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SystemRoot',
  'TERM',
  'TMPDIR',
  'USER',
  'WINDIR',
] as const;

type HermesChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export type HermesAdapterErrorCode =
  | 'EXPERIMENTAL_FEATURE_DISABLED'
  | 'HERMES_BINARY_MISSING'
  | 'HERMES_ACP_UNSUPPORTED'
  | 'COPILOT_UNAUTHENTICATED'
  | 'HERMES_UNHEALTHY'
  | 'HERMES_NONZERO_EXIT'
  | 'HERMES_OUTPUT_LIMIT'
  | 'HERMES_PROTOCOL_ERROR'
  | 'HERMES_RECEIPT_INVALID';

export class HermesAdapterError extends Error {
  readonly code: HermesAdapterErrorCode;

  constructor(code: HermesAdapterErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'HermesAdapterError';
    this.code = code;
  }
}

export type HermesAdapterState =
  | 'missing-binary'
  | 'unsupported-acp'
  | 'unauthenticated-copilot'
  | 'unhealthy-process'
  | 'ready';

export interface HermesAdapterReceiptBody {
  schema: typeof HERMES_RECEIPT_SCHEMA;
  generated_at: string;
  executable: {
    command: string;
    sha256: string;
    version: string;
  };
  feature_profile: {
    experimental: true;
    harness_adapters: true;
    hermes: true;
  };
  rapp_protocol: typeof RAPP_CHAT_PROTOCOL;
  model_authority: typeof HERMES_MODEL_AUTHORITY;
  transport: typeof HERMES_TRANSPORT;
  model: string;
  live_identity: {
    rappid: string;
    live_id: string;
    pid: number;
  };
  health: {
    state: 'ready';
    checked_at: string;
  };
}

export interface HermesAdapterReceipt extends HermesAdapterReceiptBody {
  receipt_sha256: string;
}

export interface HermesParticipantStatus extends RappParticipantStatus {
  adapterState: HermesAdapterState;
  message: string;
  receipt?: Readonly<HermesAdapterReceipt>;
}

export interface HermesProcessInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  outputLimitBytes: number;
  signal?: AbortSignal;
}

export interface HermesProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  outputLimitExceeded: boolean;
  spawnErrorCode?: string;
}

export type HermesProcessRunner = (
  invocation: HermesProcessInvocation,
) => Promise<HermesProcessResult>;

export interface HermesRappParticipantOptions {
  /** Parsed config or a live config accessor. Only literal true gates enable Hermes. */
  config: unknown | (() => unknown);
  /** Stable/live identity of the admitted OpenRappter wrapper process. */
  identity: Readonly<LiveRappIdentity>;
  /** Test/integration seam used to detect identity drift after admission. */
  identityProvider?: () => Readonly<LiveRappIdentity> | undefined;
  /** Absolute path is preferred. Bare names are resolved from the supplied PATH after gating. */
  executable?: string;
  model?: string;
  reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  maxTurns?: number;
  stateDirectory?: string;
  receiptPath?: string;
  healthTimeoutMs?: number;
  chatTimeoutMs?: number;
  outputLimitBytes?: number;
  maxInputBytes?: number;
  env?: NodeJS.ProcessEnv;
  authority?: CopilotAuthority;
  runner?: HermesProcessRunner;
  now?: () => Date;
  sessionIdFactory?: () => string;
}

interface HermesReadyProbe {
  state: 'ready';
  message: string;
  checkedAt: string;
  executable: string;
  executableHash: string;
  version: string;
}

interface HermesFailedProbe {
  state: Exclude<HermesAdapterState, 'ready'>;
  message: string;
  checkedAt: string;
}

type HermesProbe = HermesReadyProbe | HermesFailedProbe;

interface ParsedHermesOutput {
  response: string;
  sessionId?: string;
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isInteger(candidate) || candidate <= 0 || candidate > maximum) {
    throw new RangeError(`${label} must be an integer between 1 and ${maximum}`);
  }
  return candidate;
}

function safeMessage(value: unknown, secrets: readonly string[] = []): string {
  const text = value instanceof Error ? value.message : String(value);
  return redactCopilotSecrets(text, secrets)
    .replace(
      /((?:token|secret|password|credential))\s*[=:]\s*\S+/gi,
      '$1=***REDACTED***',
    )
    .slice(0, 1_024);
}

function outputText(result: HermesProcessResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function executableVersion(value: string): string | null {
  const match = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/.exec(value);
  if (match) return match[0];
  const firstLine = value.split(/\r?\n/).map(line => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 128) : null;
}

function isMissingExecutable(result: HermesProcessResult): boolean {
  return result.spawnErrorCode === 'ENOENT' || result.spawnErrorCode === 'EACCES';
}

function classifyHealthFailure(text: string): HermesFailedProbe['state'] {
  if (
    /unknown provider|invalid choice[^\n]*copilot-acp|provider[^\n]*(?:not found|unsupported)|copilot-acp[^\n]*not supported/i
      .test(text)
  ) {
    return 'unsupported-acp';
  }
  if (
    /not logged in|login required|authentication required|unauthenticated|unauthorized|missing credentials|copilot[^\n]*(?:login|log in|auth)|\b401\b/i
      .test(text)
  ) {
    return 'unauthenticated-copilot';
  }
  return 'unhealthy-process';
}

function canonicalReceiptDigest(body: HermesAdapterReceiptBody): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertReceiptShape(value: unknown): asserts value is HermesAdapterReceipt {
  if (!isRecord(value) || value.schema !== HERMES_RECEIPT_SCHEMA) {
    throw new HermesAdapterError(
      'HERMES_RECEIPT_INVALID',
      'Hermes adapter receipt has an invalid schema.',
    );
  }
  if (
    typeof value.generated_at !== 'string'
    || !isRecord(value.executable)
    || typeof value.executable.command !== 'string'
    || typeof value.executable.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.executable.sha256)
    || typeof value.executable.version !== 'string'
    || !isRecord(value.feature_profile)
    || value.feature_profile.experimental !== true
    || value.feature_profile.harness_adapters !== true
    || value.feature_profile.hermes !== true
    || value.rapp_protocol !== RAPP_CHAT_PROTOCOL
    || value.model_authority !== HERMES_MODEL_AUTHORITY
    || value.transport !== HERMES_TRANSPORT
    || typeof value.model !== 'string'
    || !isRecord(value.live_identity)
    || typeof value.live_identity.rappid !== 'string'
    || typeof value.live_identity.live_id !== 'string'
    || !Number.isSafeInteger(value.live_identity.pid)
    || !isRecord(value.health)
    || value.health.state !== 'ready'
    || typeof value.health.checked_at !== 'string'
    || typeof value.receipt_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.receipt_sha256)
  ) {
    throw new HermesAdapterError(
      'HERMES_RECEIPT_INVALID',
      'Hermes adapter receipt is malformed.',
    );
  }
}

function receiptBody(receipt: HermesAdapterReceipt): HermesAdapterReceiptBody {
  return {
    schema: receipt.schema,
    generated_at: receipt.generated_at,
    executable: { ...receipt.executable },
    feature_profile: { ...receipt.feature_profile },
    rapp_protocol: receipt.rapp_protocol,
    model_authority: receipt.model_authority,
    transport: receipt.transport,
    model: receipt.model,
    live_identity: { ...receipt.live_identity },
    health: { ...receipt.health },
  };
}

function validateReceiptDigest(receipt: HermesAdapterReceipt): void {
  if (canonicalReceiptDigest(receiptBody(receipt)) !== receipt.receipt_sha256) {
    throw new HermesAdapterError(
      'HERMES_RECEIPT_INVALID',
      'Hermes adapter receipt integrity check failed.',
    );
  }
}

function defaultHermesEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  env.NO_COLOR = '1';
  env.PYTHONUNBUFFERED = '1';
  return env;
}

async function resolveExecutable(
  configured: string,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<string | null> {
  const hasPathSeparator = configured.includes('/') || configured.includes('\\');
  const candidates: string[] = [];
  if (path.isAbsolute(configured) || hasPathSeparator) {
    candidates.push(path.resolve(configured));
  } else {
    const pathEntries = (sourceEnv.PATH ?? '').split(path.delimiter).filter(Boolean);
    const extensions = process.platform === 'win32'
      ? (sourceEnv.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
    for (const entry of pathEntries) {
      for (const extension of extensions) {
        candidates.push(path.join(entry, `${configured}${extension}`));
      }
    }
  }

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH without exposing which private directories exist.
    }
  }
  return null;
}

async function sha256File(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function defaultKillProcessTree(
  child: HermesChildProcess,
  signal: NodeJS.Signals,
): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', args, {
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      try {
        child.kill(signal);
      } catch {
        // The process already exited between the group and direct kill attempts.
      }
    }
  }
}

export const runHermesProcess: HermesProcessRunner = async (
  invocation,
): Promise<HermesProcessResult> => {
  if (invocation.signal?.aborted) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: true,
      outputLimitExceeded: false,
    };
  }

  return new Promise<HermesProcessResult>((resolve) => {
    let child: HermesChildProcess;
    try {
      child = spawn(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        env: { ...invocation.env },
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        outputLimitExceeded: false,
        spawnErrorCode: (error as NodeJS.ErrnoException).code,
      });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputLimitExceeded = false;
    let finished = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: 'timeout' | 'abort' | 'output-limit'): void => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') aborted = true;
      if (reason === 'output-limit') outputLimitExceeded = true;
      void defaultKillProcessTree(child, 'SIGTERM');
      forceKillTimer ??= setTimeout(() => {
        void defaultKillProcessTree(child, 'SIGKILL');
      }, 250);
      forceKillTimer.unref?.();
    };

    const capture = (target: Buffer[], chunk: Buffer): void => {
      const remaining = Math.max(0, invocation.outputLimitBytes - outputBytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      outputBytes += chunk.length;
      if (outputBytes > invocation.outputLimitBytes && !outputLimitExceeded) {
        terminate('output-limit');
      }
    };

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));

    const onAbort = (): void => {
      if (!finished && !aborted) terminate('abort');
    };
    invocation.signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => {
      if (!finished && !timedOut) terminate('timeout');
    }, invocation.timeoutMs);
    timeout.unref?.();

    const finish = (
      exitCode: number | null,
      signal: NodeJS.Signals | null,
      spawnErrorCode?: string,
    ): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      invocation.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode,
        signal,
        timedOut,
        aborted,
        outputLimitExceeded,
        ...(spawnErrorCode === undefined ? {} : { spawnErrorCode }),
      });
    };

    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(null, null, error.code);
    });
    child.once('close', (exitCode, signal) => {
      finish(exitCode, signal);
    });
  });
};

function parseHermesOutput(raw: string): ParsedHermesOutput {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let sessionId: string | undefined;
  const responseLines: string[] = [];
  for (const line of lines) {
    const sessionMatch = /^\s*session_id:\s*(\S+)\s*$/i.exec(line);
    if (sessionMatch) {
      sessionId = sessionMatch[1];
    } else {
      responseLines.push(line);
    }
  }
  const response = responseLines.join('\n').trim();
  if (!response) {
    throw new HermesAdapterError(
      'HERMES_PROTOCOL_ERROR',
      'Hermes returned no final response.',
    );
  }
  return { response, sessionId };
}

function formatHermesPrompt(request: RappParticipantChatRequest): string {
  const transcript = request.conversationHistory.map((message) =>
    `${message.role.toUpperCase()}:\n${message.content}`,
  );
  transcript.push(`USER:\n${request.userInput}`);
  return [
    'Continue this RAPP/1 conversation. Return only the assistant response.',
    ...transcript,
  ].join('\n\n');
}

export class HermesRappParticipant implements RappParticipant {
  private readonly configSource: () => unknown;
  private readonly admittedIdentity: Readonly<LiveRappIdentity>;
  private readonly identityProvider: () => Readonly<LiveRappIdentity> | undefined;
  private readonly configuredExecutable: string;
  private readonly model: string;
  private readonly reasoning: NonNullable<HermesRappParticipantOptions['reasoning']>;
  private readonly maxTurns: number;
  private readonly stateDirectory: string;
  private readonly hermesHomeDirectory: string;
  private readonly temporaryDirectory: string;
  private readonly workingDirectory: string;
  private readonly promptsDirectory: string;
  private readonly receiptFile: string;
  private readonly healthTimeoutMs: number;
  private readonly chatTimeoutMs: number;
  private readonly outputLimitBytes: number;
  private readonly maxInputBytes: number;
  private readonly sourceEnv: NodeJS.ProcessEnv;
  private readonly childEnv: NodeJS.ProcessEnv;
  private readonly authority: CopilotAuthority;
  private readonly runner: HermesProcessRunner;
  private readonly now: () => Date;
  private readonly sessionIdFactory: () => string;
  private currentDescriptor: Readonly<RappParticipantDescriptor>;

  constructor(options: HermesRappParticipantOptions) {
    this.configSource = typeof options.config === 'function'
      ? options.config as () => unknown
      : () => options.config;
    this.admittedIdentity = Object.freeze({ ...options.identity });
    assertIdentityBinding(this.admittedIdentity);
    this.identityProvider = options.identityProvider ?? currentLiveIdentity;
    this.sourceEnv = { ...(options.env ?? process.env) };
    this.configuredExecutable =
      options.executable?.trim()
      || this.sourceEnv.OPENRAPPTER_HERMES_PATH?.trim()
      || 'hermes';
    this.model = options.model?.trim() || COPILOT_DEFAULT_MODEL;
    this.reasoning = options.reasoning ?? 'low';
    this.maxTurns = boundedPositiveInteger(options.maxTurns, 1, 500, 'maxTurns');
    this.stateDirectory =
      options.stateDirectory ?? openrappterPath('harness-adapters', 'hermes');
    this.hermesHomeDirectory = path.join(this.stateDirectory, 'home');
    this.temporaryDirectory = path.join(this.stateDirectory, 'tmp');
    this.workingDirectory = path.join(this.stateDirectory, 'workspace');
    this.promptsDirectory = path.join(this.stateDirectory, 'prompts');
    this.childEnv = {
      ...defaultHermesEnvironment(this.sourceEnv),
      HERMES_HOME: this.hermesHomeDirectory,
      TMPDIR: this.temporaryDirectory,
    };
    this.receiptFile =
      options.receiptPath ?? path.join(this.stateDirectory, 'adapter-receipt.json');
    this.healthTimeoutMs = boundedPositiveInteger(
      options.healthTimeoutMs,
      DEFAULT_HERMES_HEALTH_TIMEOUT_MS,
      MAX_HERMES_TIMEOUT_MS,
      'healthTimeoutMs',
    );
    this.chatTimeoutMs = boundedPositiveInteger(
      options.chatTimeoutMs,
      DEFAULT_HERMES_CHAT_TIMEOUT_MS,
      MAX_HERMES_TIMEOUT_MS,
      'chatTimeoutMs',
    );
    this.outputLimitBytes = boundedPositiveInteger(
      options.outputLimitBytes,
      DEFAULT_HERMES_OUTPUT_LIMIT_BYTES,
      64 * 1024 * 1024,
      'outputLimitBytes',
    );
    this.maxInputBytes = boundedPositiveInteger(
      options.maxInputBytes,
      DEFAULT_HERMES_MAX_INPUT_BYTES,
      4 * 1024 * 1024,
      'maxInputBytes',
    );
    this.authority = options.authority ?? new CopilotAuthority();
    this.runner = options.runner ?? runHermesProcess;
    this.now = options.now ?? (() => new Date());
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.currentDescriptor = this.descriptorFor();
  }

  get descriptor(): Readonly<RappParticipantDescriptor> {
    return this.currentDescriptor;
  }

  get receiptPath(): string {
    return this.receiptFile;
  }

  async status(signal?: AbortSignal): Promise<HermesParticipantStatus> {
    const features = this.requireEnabled();
    this.assertIdentityContinuity('health');
    const probe = await this.probe(features, signal);
    if (probe.state !== 'ready') {
      return Object.freeze({
        status: 'degraded',
        adapterState: probe.state,
        message: probe.message,
        descriptor: this.currentDescriptor,
        checkedAt: probe.checkedAt,
      });
    }
    this.assertIdentityContinuity('health');

    const receipt = this.makeReceipt(probe);
    const existing = await this.readReceipt();
    if (existing) {
      this.assertReceiptMatches(existing, receipt);
    } else {
      await this.writeReceipt(receipt);
    }
    this.currentDescriptor = this.descriptorFor(probe);
    return Object.freeze({
      status: 'ok',
      adapterState: 'ready',
      message: probe.message,
      descriptor: this.currentDescriptor,
      checkedAt: probe.checkedAt,
      receipt: existing ?? receipt,
    });
  }

  async chat(
    request: RappParticipantChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatEnvelope> {
    const features = this.requireEnabled();
    this.assertIdentityContinuity('chat');
    const parsedRequest = parseChatRequest({
      user_input: request.userInput,
      conversation_history: request.conversationHistory,
      ...(request.sessionId === undefined ? {} : { session_id: request.sessionId }),
    });
    if (!parsedRequest.ok) {
      throw new RappParticipantProtocolError(
        'chat',
        HERMES_ENDPOINT,
        `request is invalid: ${parsedRequest.error}`,
      );
    }

    const existingReceipt = await this.readReceipt();
    const probe = await this.probe(features, signal);
    if (probe.state !== 'ready') throw this.probeError(probe, 'chat');
    this.assertIdentityContinuity('chat');
    const currentReceipt = this.makeReceipt(probe);
    if (existingReceipt) {
      this.assertReceiptMatches(existingReceipt, currentReceipt);
    } else {
      await this.writeReceipt(currentReceipt);
    }

    const prompt = formatHermesPrompt({
      ...request,
      userInput: parsedRequest.value.userInput,
      conversationHistory: parsedRequest.value.conversationHistory,
      sessionId: parsedRequest.value.sessionId,
    });
    if (Buffer.byteLength(prompt, 'utf8') > this.maxInputBytes) {
      throw new HermesAdapterError(
        'HERMES_PROTOCOL_ERROR',
        `Hermes RAPP input exceeded the ${this.maxInputBytes}-byte limit.`,
      );
    }

    const promptFile = await this.writePrompt(prompt);
    let result: HermesProcessResult;
    try {
      result = await this.run(
        this.chatArgs({ queryFile: promptFile, timeoutMs: this.chatTimeoutMs }),
        this.chatTimeoutMs,
        signal,
        this.outputLimitBytes,
        probe.executable,
      );
    } finally {
      await unlink(promptFile).catch(() => {});
    }
    this.throwForProcessFailure(result, 'chat', this.chatTimeoutMs);
    this.assertIdentityContinuity('chat');

    let parsedOutput: ParsedHermesOutput;
    try {
      parsedOutput = parseHermesOutput(result.stdout);
    } catch (error) {
      if (error instanceof HermesAdapterError) throw error;
      throw new HermesAdapterError(
        'HERMES_PROTOCOL_ERROR',
        'Hermes returned malformed output.',
        error,
      );
    }
    const sessionId =
      parsedRequest.value.sessionId
      ?? parsedOutput.sessionId
      ?? this.sessionIdFactory();
    const logs = [
      `Hermes ${probe.version} via ${HERMES_TRANSPORT}`,
      ...(parsedOutput.sessionId ? [`hermes_session_id=${parsedOutput.sessionId}`] : []),
      ...(result.stderr.trim() ? [safeMessage(result.stderr)] : []),
    ];
    return parseRappChatEnvelope(buildChatEnvelope({
      content: parsedOutput.response,
      sessionId,
      requestedModel: this.model,
      backendKind: 'hermes',
      agentLogs: logs,
      extra: {
        rappid: this.admittedIdentity.rappid,
        live_id: this.admittedIdentity.liveId,
        ...(request.idempotencyKey === undefined
          ? {}
          : { idempotency_key: request.idempotencyKey }),
      },
    }), HERMES_ENDPOINT);
  }

  private requireEnabled(): EffectiveFeatures {
    const features = getEffectiveFeatures(this.configSource());
    if (!(features.experimental && features.harnessAdapters && features.hermes)) {
      throw new HermesAdapterError(
        'EXPERIMENTAL_FEATURE_DISABLED',
        'The experimental Hermes adapter is disabled.',
      );
    }
    return features;
  }

  private assertIdentityContinuity(operation: RappParticipantOperation): void {
    assertIdentityBinding(this.admittedIdentity);
    const current = this.identityProvider();
    if (!current) return;
    assertIdentityBinding(current);
    if (current.rappid !== this.admittedIdentity.rappid) {
      throw new RappParticipantIdentityDriftError(
        operation,
        HERMES_ENDPOINT,
        'rappid',
        this.admittedIdentity.rappid,
        current.rappid,
      );
    }
    if (current.liveId !== this.admittedIdentity.liveId) {
      throw new RappParticipantIdentityDriftError(
        operation,
        HERMES_ENDPOINT,
        'liveId',
        this.admittedIdentity.liveId,
        current.liveId,
      );
    }
  }

  private descriptorFor(probe?: HermesReadyProbe): Readonly<RappParticipantDescriptor> {
    return Object.freeze({
      rappid: this.admittedIdentity.rappid,
      liveId: this.admittedIdentity.liveId,
      pid: this.admittedIdentity.pid,
      harness: Object.freeze({
        name: 'hermes',
        displayName: 'Hermes',
        ...(probe === undefined ? {} : { version: probe.version }),
        metadata: Object.freeze({
          transport: HERMES_TRANSPORT,
          feature: 'frontier-experimental',
          ...(probe === undefined ? {} : { executableSha256: probe.executableHash }),
        }),
      }),
      endpoint: HERMES_ENDPOINT,
      protocol: RAPP_CHAT_PROTOCOL,
      modelAuthority: HERMES_MODEL_AUTHORITY,
      capabilities: Object.freeze({
        chat: true,
        health: true,
        history: true,
        tools: false,
        streaming: false,
        voice: true,
        attachments: false,
        extensions: Object.freeze(['hermes-copilot-acp']),
      }),
    });
  }

  private async probe(
    _features: EffectiveFeatures,
    signal?: AbortSignal,
  ): Promise<HermesProbe> {
    const checkedAt = this.now().toISOString();
    this.authority.assertModelAllowed(this.model);
    if (signal?.aborted) {
      throw new RappParticipantAbortedError('health', HERMES_ENDPOINT);
    }

    const executable = await resolveExecutable(
      this.configuredExecutable,
      this.sourceEnv,
    );
    if (!executable) {
      return {
        state: 'missing-binary',
        message: 'Hermes executable was not found or is not executable.',
        checkedAt,
      };
    }

    let executableHash: string;
    try {
      executableHash = await sha256File(executable);
    } catch (error) {
      return {
        state: 'unhealthy-process',
        message: `Hermes executable could not be verified: ${safeMessage(error)}`,
        checkedAt,
      };
    }

    await this.prepareDirectories();
    const versionResult = await this.run(
      ['--version'],
      this.healthTimeoutMs,
      signal,
      64 * 1024,
      executable,
    );
    if (versionResult.aborted) {
      throw new RappParticipantAbortedError('health', HERMES_ENDPOINT);
    }
    if (isMissingExecutable(versionResult)) {
      return {
        state: 'missing-binary',
        message: 'Hermes executable disappeared during its version probe.',
        checkedAt,
      };
    }
    if (
      versionResult.timedOut
      || versionResult.outputLimitExceeded
      || versionResult.exitCode !== 0
    ) {
      return {
        state: 'unhealthy-process',
        message: `Hermes version probe failed: ${safeMessage(outputText(versionResult) || 'no output')}`,
        checkedAt,
      };
    }
    const version = executableVersion(outputText(versionResult));
    if (!version) {
      return {
        state: 'unhealthy-process',
        message: 'Hermes version probe returned no version.',
        checkedAt,
      };
    }

    const helpResult = await this.run(
      ['chat', '--help'],
      this.healthTimeoutMs,
      signal,
      128 * 1024,
      executable,
    );
    if (helpResult.aborted) {
      throw new RappParticipantAbortedError('health', HERMES_ENDPOINT);
    }
    const help = outputText(helpResult);
    if (
      helpResult.timedOut
      || helpResult.outputLimitExceeded
      || helpResult.exitCode !== 0
      || REQUIRED_HELP_MARKERS.some(marker => !help.includes(marker))
    ) {
      return {
        state: 'unsupported-acp',
        message: 'Hermes does not expose the required safe copilot-acp CLI contract.',
        checkedAt,
      };
    }

    const healthResult = await this.run(
      this.chatArgs({
        query: `Reply with exactly: ${HEALTH_SENTINEL}`,
        timeoutMs: this.healthTimeoutMs,
      }),
      this.healthTimeoutMs,
      signal,
      256 * 1024,
      executable,
    );
    if (healthResult.aborted) {
      throw new RappParticipantAbortedError('health', HERMES_ENDPOINT);
    }
    if (
      healthResult.timedOut
      || healthResult.outputLimitExceeded
      || healthResult.exitCode !== 0
    ) {
      const detail = outputText(healthResult);
      const state = classifyHealthFailure(detail);
      return {
        state,
        message: state === 'unauthenticated-copilot'
          ? 'GitHub Copilot CLI is not authenticated for Hermes ACP.'
          : state === 'unsupported-acp'
            ? 'Hermes rejected the copilot-acp provider.'
            : `Hermes ACP health probe failed: ${safeMessage(detail || 'no output')}`,
        checkedAt,
      };
    }

    let parsed: ParsedHermesOutput;
    try {
      parsed = parseHermesOutput(healthResult.stdout);
    } catch (error) {
      return {
        state: 'unhealthy-process',
        message: safeMessage(error),
        checkedAt,
      };
    }
    if (parsed.response !== HEALTH_SENTINEL) {
      return {
        state: 'unhealthy-process',
        message: 'Hermes ACP health probe returned an unexpected response.',
        checkedAt,
      };
    }
    return {
      state: 'ready',
      message: 'Hermes copilot-acp transport is ready.',
      checkedAt,
      executable,
      executableHash,
      version,
    };
  }

  private chatArgs(options: {
    query?: string;
    queryFile?: string;
    timeoutMs: number;
  }): string[] {
    const runBudgetSeconds = Math.max(1, Math.floor(options.timeoutMs / 1_000));
    return [
      'chat',
      '--safe-mode',
      '--source',
      'tool',
      '--provider',
      HERMES_TRANSPORT,
      '--model',
      this.model,
      '--reasoning',
      this.reasoning,
      '--max-turns',
      String(this.maxTurns),
      '--run-budget',
      String(runBudgetSeconds),
      '--in',
      this.workingDirectory,
      '-Q',
      ...(options.queryFile
        ? ['--query-file', options.queryFile]
        : ['-q', options.query ?? '']),
    ];
  }

  private async run(
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
    outputLimitBytes = this.outputLimitBytes,
    executable = this.configuredExecutable,
  ): Promise<HermesProcessResult> {
    return this.runner({
      executable,
      args,
      cwd: this.workingDirectory,
      env: { ...this.childEnv },
      timeoutMs,
      outputLimitBytes,
      signal,
    });
  }

  private throwForProcessFailure(
    result: HermesProcessResult,
    operation: RappParticipantOperation,
    timeoutMs: number,
  ): void {
    if (result.aborted) {
      throw new RappParticipantAbortedError(operation, HERMES_ENDPOINT);
    }
    if (result.timedOut) {
      throw new RappParticipantTimeoutError(operation, HERMES_ENDPOINT, timeoutMs);
    }
    if (result.outputLimitExceeded) {
      throw new HermesAdapterError(
        'HERMES_OUTPUT_LIMIT',
        `Hermes ${operation} output exceeded the configured limit.`,
      );
    }
    if (isMissingExecutable(result)) {
      throw new HermesAdapterError(
        'HERMES_BINARY_MISSING',
        'Hermes executable disappeared before invocation.',
      );
    }
    if (result.exitCode !== 0) {
      throw new HermesAdapterError(
        'HERMES_NONZERO_EXIT',
        `Hermes ${operation} failed: ${safeMessage(outputText(result) || `exit ${result.exitCode}`)}`,
      );
    }
  }

  private probeError(
    probe: HermesFailedProbe,
    _operation: RappParticipantOperation,
  ): HermesAdapterError {
    const code: HermesAdapterErrorCode = probe.state === 'missing-binary'
      ? 'HERMES_BINARY_MISSING'
      : probe.state === 'unsupported-acp'
        ? 'HERMES_ACP_UNSUPPORTED'
        : probe.state === 'unauthenticated-copilot'
          ? 'COPILOT_UNAUTHENTICATED'
          : 'HERMES_UNHEALTHY';
    return new HermesAdapterError(code, probe.message);
  }

  private makeReceipt(probe: HermesReadyProbe): HermesAdapterReceipt {
    const body: HermesAdapterReceiptBody = {
      schema: HERMES_RECEIPT_SCHEMA,
      generated_at: probe.checkedAt,
      executable: {
        command: path.basename(probe.executable),
        sha256: probe.executableHash,
        version: probe.version,
      },
      feature_profile: {
        experimental: true,
        harness_adapters: true,
        hermes: true,
      },
      rapp_protocol: RAPP_CHAT_PROTOCOL,
      model_authority: HERMES_MODEL_AUTHORITY,
      transport: HERMES_TRANSPORT,
      model: this.model,
      live_identity: {
        rappid: this.admittedIdentity.rappid,
        live_id: this.admittedIdentity.liveId,
        pid: this.admittedIdentity.pid,
      },
      health: {
        state: 'ready',
        checked_at: probe.checkedAt,
      },
    };
    return Object.freeze({
      ...body,
      receipt_sha256: canonicalReceiptDigest(body),
    });
  }

  private async readReceipt(): Promise<HermesAdapterReceipt | null> {
    let raw: string;
    try {
      raw = await readFile(this.receiptFile, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new HermesAdapterError(
        'HERMES_RECEIPT_INVALID',
        'Hermes adapter receipt could not be read.',
        error,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new HermesAdapterError(
        'HERMES_RECEIPT_INVALID',
        'Hermes adapter receipt is not valid JSON.',
        error,
      );
    }
    assertReceiptShape(parsed);
    validateReceiptDigest(parsed);
    return parsed;
  }

  private assertReceiptMatches(
    existing: HermesAdapterReceipt,
    current: HermesAdapterReceipt,
  ): void {
    const comparableExisting = receiptBody(existing);
    const comparableCurrent = receiptBody(current);
    comparableExisting.generated_at = comparableCurrent.generated_at;
    comparableExisting.health.checked_at = comparableCurrent.health.checked_at;
    if (JSON.stringify(comparableExisting) !== JSON.stringify(comparableCurrent)) {
      throw new HermesAdapterError(
        'HERMES_RECEIPT_INVALID',
        'Hermes adapter receipt no longer matches the executable, feature profile, model authority, or live identity.',
      );
    }
  }

  private async prepareDirectories(): Promise<void> {
    await mkdir(this.hermesHomeDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.temporaryDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.workingDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.promptsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.stateDirectory, 0o700);
    await chmod(this.hermesHomeDirectory, 0o700);
    await chmod(this.temporaryDirectory, 0o700);
    await chmod(this.workingDirectory, 0o700);
    await chmod(this.promptsDirectory, 0o700);
  }

  private async writeReceipt(receipt: HermesAdapterReceipt): Promise<void> {
    await this.prepareDirectories();
    await mkdir(path.dirname(this.receiptFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.receiptFile}.${process.pid}.${randomUUID()}.new`;
    try {
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.receiptFile);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  private async writePrompt(prompt: string): Promise<string> {
    await this.prepareDirectories();
    const promptFile = path.join(
      this.promptsDirectory,
      `.${process.pid}.${randomUUID()}.query.txt`,
    );
    await writeFile(promptFile, prompt, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await chmod(promptFile, 0o600);
    return promptFile;
  }
}

export function createHermesParticipant(
  options: HermesRappParticipantOptions,
): HermesRappParticipant {
  return new HermesRappParticipant(options);
}
