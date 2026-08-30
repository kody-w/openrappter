import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { getEffectiveFeatures, type EffectiveFeatures } from '../../config/features.js';
import { buildChatEnvelope, type ChatEnvelope } from '../../gateway/chat-envelope.js';
import { parseChatRequest } from '../../gateway/chat-request.js';
import {
  assertIdentityBinding,
  type LiveRappIdentity,
} from '../../infra/process-identity.js';
import { redactCopilotSecrets } from '../../providers/copilot-authority.js';
import {
  type CopilotBrokerGrant,
  type CopilotBrokerGrantOptions,
} from '../../providers/copilot-broker.js';
import {
  RAPP_CHAT_PROTOCOL,
  RappParticipantIdentityDriftError,
  RappParticipantProtocolError,
  type RappParticipant,
  type RappParticipantChatRequest,
  type RappParticipantDescriptor,
  type RappParticipantOperation,
  type RappParticipantStatus,
} from '../participant.js';

export const PI_PROVIDER_ID = 'openrappter-copilot' as const;
export const PI_BROKER_BEARER_ENV = 'OPENRAPPTER_PI_BROKER_BEARER' as const;
export const PI_ADAPTER_RECEIPT_SCHEMA = 'rapp-pi-adapter-receipt/1.0' as const;

const PI_ENDPOINT = 'pi://local';
const PI_PROVIDER_MODE = 'loopback-broker' as const;
const PI_MODEL_AUTHORITY = 'github-copilot' as const;
const DEFAULT_PI_MODEL = 'gpt-5';
const DEFAULT_PI_TIMEOUT_MS = 45_000;
const DEFAULT_PI_PROBE_TIMEOUT_MS = 5_000;
const DEFAULT_PI_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const MAX_PI_TIMEOUT_MS = 5 * 60_000;
const MAX_PI_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const PROCESS_KILL_GRACE_MS = 250;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

const PI_CAPABILITIES = Object.freeze({
  chat: true,
  health: true,
  history: true,
  tools: false,
  streaming: false,
  voice: false,
  attachments: false,
  extensions: Object.freeze(['experimental']),
});

export type PiAdapterErrorCode =
  | 'EXPERIMENTAL_FEATURE_DISABLED'
  | 'PI_BINARY_NOT_FOUND'
  | 'PI_BINARY_INVALID'
  | 'PI_PROBE_FAILED'
  | 'PI_BROKER_GRANT_INVALID'
  | 'PI_BROKER_GRANT_EXPIRED'
  | 'PI_RUNTIME_SETUP_FAILED'
  | 'PI_PROCESS_FAILED'
  | 'PI_TIMEOUT'
  | 'PI_ABORTED'
  | 'PI_OUTPUT_LIMIT_EXCEEDED'
  | 'PI_OUTPUT_MALFORMED'
  | 'PI_PROVIDER_MISMATCH'
  | 'PI_RECEIPT_TAMPERED'
  | 'PI_RECEIPT_MISMATCH';

export class PiAdapterError extends Error {
  readonly code: PiAdapterErrorCode;

  constructor(code: PiAdapterErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PiAdapterError';
    this.code = code;
  }
}

export interface PiGrantBroker {
  issueGrant(options: CopilotBrokerGrantOptions): Promise<CopilotBrokerGrant>;
  revoke(grantId: string): boolean;
}

export interface PiAdapterReceipt {
  schema: typeof PI_ADAPTER_RECEIPT_SCHEMA;
  executable: {
    path: string;
    sha256: string;
    version: string;
  };
  providerMode: typeof PI_PROVIDER_MODE;
  piProvider: typeof PI_PROVIDER_ID;
  modelAuthority: typeof PI_MODEL_AUTHORITY;
  model: string;
  protocol: typeof RAPP_CHAT_PROTOCOL;
  features: {
    experimental: true;
    harnessAdapters: true;
    pi: true;
  };
  identity: {
    rappid: string;
    liveId: string;
    pid: number;
    incarnation: string;
  };
  issuedAt: string;
  integrity: string;
}

export interface PiRappParticipantOptions {
  config: unknown | (() => unknown);
  identity: Readonly<LiveRappIdentity> | (() => Readonly<LiveRappIdentity>);
  broker: PiGrantBroker;
  binaryPath?: string;
  resolveBinary?: () => Promise<string>;
  runtimeRoot?: string;
  model?: string;
  timeoutMs?: number;
  probeTimeoutMs?: number;
  maxOutputBytes?: number;
  grantTtlMs?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  receipt?: PiAdapterReceipt;
}

interface PiExecutableEvidence {
  path: string;
  sha256: string;
  version: string;
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface PiAssistantMessage {
  provider: string;
  model: string;
  responseModel?: string;
  text: string;
}

function boundedInteger(
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

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function receiptPayload(receipt: PiAdapterReceipt): Omit<PiAdapterReceipt, 'integrity'> {
  return {
    schema: receipt.schema,
    executable: {
      path: receipt.executable.path,
      sha256: receipt.executable.sha256,
      version: receipt.executable.version,
    },
    providerMode: receipt.providerMode,
    piProvider: receipt.piProvider,
    modelAuthority: receipt.modelAuthority,
    model: receipt.model,
    protocol: receipt.protocol,
    features: {
      experimental: receipt.features.experimental,
      harnessAdapters: receipt.features.harnessAdapters,
      pi: receipt.features.pi,
    },
    identity: {
      rappid: receipt.identity.rappid,
      liveId: receipt.identity.liveId,
      pid: receipt.identity.pid,
      incarnation: receipt.identity.incarnation,
    },
    issuedAt: receipt.issuedAt,
  };
}

function receiptIntegrity(payload: Omit<PiAdapterReceipt, 'integrity'>): string {
  return createHash('sha256')
    .update('openrappter/pi-adapter-receipt/1\0')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function freezeReceipt(receipt: PiAdapterReceipt): Readonly<PiAdapterReceipt> {
  Object.freeze(receipt.executable);
  Object.freeze(receipt.features);
  Object.freeze(receipt.identity);
  return Object.freeze(receipt);
}

export function verifyPiAdapterReceipt(
  receipt: PiAdapterReceipt,
): Readonly<PiAdapterReceipt> {
  let payload: Omit<PiAdapterReceipt, 'integrity'>;
  try {
    payload = receiptPayload(receipt);
  } catch (error) {
    throw new PiAdapterError(
      'PI_RECEIPT_TAMPERED',
      'Pi adapter receipt is malformed.',
      error,
    );
  }
  const validShape =
    receipt.schema === PI_ADAPTER_RECEIPT_SCHEMA
    && receipt.providerMode === PI_PROVIDER_MODE
    && receipt.piProvider === PI_PROVIDER_ID
    && receipt.modelAuthority === PI_MODEL_AUTHORITY
    && receipt.protocol === RAPP_CHAT_PROTOCOL
    && receipt.features.experimental === true
    && receipt.features.harnessAdapters === true
    && receipt.features.pi === true
    && nonEmpty(receipt.executable.path)
    && /^[0-9a-f]{64}$/.test(receipt.executable.sha256)
    && nonEmpty(receipt.executable.version)
    && nonEmpty(receipt.model)
    && nonEmpty(receipt.identity.rappid)
    && nonEmpty(receipt.identity.liveId)
    && Number.isSafeInteger(receipt.identity.pid)
    && receipt.identity.pid > 0
    && nonEmpty(receipt.identity.incarnation)
    && !Number.isNaN(Date.parse(receipt.issuedAt))
    && /^[0-9a-f]{64}$/.test(receipt.integrity);
  if (!validShape || receiptIntegrity(payload) !== receipt.integrity) {
    throw new PiAdapterError(
      'PI_RECEIPT_TAMPERED',
      'Pi adapter receipt failed its integrity check.',
    );
  }
  return receipt;
}

function createReceipt(
  executable: PiExecutableEvidence,
  model: string,
  features: EffectiveFeatures,
  identity: Readonly<LiveRappIdentity>,
  now: number,
): Readonly<PiAdapterReceipt> {
  if (!features.experimental || !features.harnessAdapters || !features.pi) {
    throw new PiAdapterError(
      'EXPERIMENTAL_FEATURE_DISABLED',
      'The experimental Pi RAPP adapter is disabled.',
    );
  }
  const payload: Omit<PiAdapterReceipt, 'integrity'> = {
    schema: PI_ADAPTER_RECEIPT_SCHEMA,
    executable,
    providerMode: PI_PROVIDER_MODE,
    piProvider: PI_PROVIDER_ID,
    modelAuthority: PI_MODEL_AUTHORITY,
    model,
    protocol: RAPP_CHAT_PROTOCOL,
    features: {
      experimental: true,
      harnessAdapters: true,
      pi: true,
    },
    identity: {
      rappid: identity.rappid,
      liveId: identity.liveId,
      pid: identity.pid,
      incarnation: identity.incarnation,
    },
    issuedAt: new Date(now).toISOString(),
  };
  return freezeReceipt({
    ...payload,
    integrity: receiptIntegrity(payload),
  });
}

function sameReceiptBinding(
  expected: PiAdapterReceipt,
  actual: PiAdapterReceipt,
): boolean {
  return expected.executable.path === actual.executable.path
    && expected.executable.sha256 === actual.executable.sha256
    && expected.executable.version === actual.executable.version
    && expected.providerMode === actual.providerMode
    && expected.piProvider === actual.piProvider
    && expected.modelAuthority === actual.modelAuthority
    && expected.model === actual.model
    && expected.protocol === actual.protocol
    && expected.features.experimental === actual.features.experimental
    && expected.features.harnessAdapters === actual.features.harnessAdapters
    && expected.features.pi === actual.features.pi
    && expected.identity.rappid === actual.identity.rappid
    && expected.identity.liveId === actual.identity.liveId
    && expected.identity.pid === actual.identity.pid
    && expected.identity.incarnation === actual.identity.incarnation;
}

function safeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TERM',
    'NO_COLOR',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
  ];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function sanitize(value: string, secrets: readonly string[] = []): string {
  return redactCopilotSecrets(value, secrets)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if it did not establish a process group.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

function runProcess(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  secrets?: readonly string[];
}): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new PiAdapterError('PI_ABORTED', 'Pi invocation was cancelled.'));
  }

  return new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(new PiAdapterError(
        'PI_PROCESS_FAILED',
        `Pi could not be started: ${sanitize(error instanceof Error ? error.message : String(error))}`,
        error,
      ));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let terminalError: PiAdapterError | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const reject = (error: PiAdapterError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const terminate = (error: PiAdapterError): void => {
      if (terminalError) return;
      terminalError = error;
      killProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), PROCESS_KILL_GRACE_MS);
      killTimer.unref();
    };
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, options.maxOutputBytes - outputBytes);
      if (remaining > 0) target.push(buffer.subarray(0, remaining));
      outputBytes += buffer.length;
      if (outputBytes > options.maxOutputBytes) {
        terminate(new PiAdapterError(
          'PI_OUTPUT_LIMIT_EXCEEDED',
          `Pi output exceeded the ${options.maxOutputBytes}-byte limit.`,
        ));
      }
    };
    const onAbort = (): void => {
      terminate(new PiAdapterError('PI_ABORTED', 'Pi invocation was cancelled.'));
    };
    const timeoutTimer = setTimeout(() => {
      terminate(new PiAdapterError(
        'PI_TIMEOUT',
        `Pi invocation timed out after ${options.timeoutMs}ms.`,
      ));
    }, options.timeoutMs);
    timeoutTimer.unref();

    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer | string) => collect(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => collect(stderr, chunk));
    child.once('error', (error) => {
      reject(new PiAdapterError(
        'PI_PROCESS_FAILED',
        `Pi process failed: ${sanitize(error.message, options.secrets)}`,
        error,
      ));
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminalError) {
        rejectPromise(terminalError);
        return;
      }
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', rejectPromise);
    stream.once('end', resolvePromise);
  });
  return hash.digest('hex');
}

function candidateNames(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return ['pi'];
  const extensions = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .filter(Boolean);
  return extensions.map(extension => `pi${extension.toLowerCase()}`);
}

async function executablePath(path: string): Promise<string> {
  const resolved = await realpath(isAbsolute(path) ? path : resolve(path));
  const metadata = await stat(resolved);
  if (!metadata.isFile()) {
    throw new PiAdapterError('PI_BINARY_INVALID', 'Configured Pi executable is not a file.');
  }
  try {
    await access(resolved, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (error) {
    throw new PiAdapterError(
      'PI_BINARY_INVALID',
      'Configured Pi executable is not executable.',
      error,
    );
  }
  return resolved;
}

async function discoverPiBinary(env: NodeJS.ProcessEnv): Promise<string> {
  for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of candidateNames(env)) {
      try {
        return await executablePath(join(directory, name));
      } catch {
        // Continue through PATH without invoking a shell.
      }
    }
  }
  throw new PiAdapterError(
    'PI_BINARY_NOT_FOUND',
    'Pi was not found on the configured executable path.',
  );
}

function piPrompt(request: {
  userInput: string;
  conversationHistory: Array<{ role: string; content: string }>;
}): string {
  return [
    'Answer the current user message directly.',
    'Use the prior conversation only as context and return only the assistant reply.',
    JSON.stringify({
      protocol: RAPP_CHAT_PROTOCOL,
      conversation_history: request.conversationHistory,
      user_input: request.userInput,
    }),
  ].join('\n');
}

function piArguments(model: string, prompt: string): string[] {
  return [
    '--mode',
    'json',
    '--provider',
    PI_PROVIDER_ID,
    '--model',
    model,
    '--thinking',
    'off',
    '--no-session',
    '--no-context-files',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-tools',
    '--offline',
    '-p',
    '--',
    prompt,
  ];
}

function parsePiOutput(
  stdout: string,
  expectedModel: string,
  secrets: readonly string[],
): PiAssistantMessage {
  let assistant: Record<string, unknown> | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new PiAdapterError(
        'PI_OUTPUT_MALFORMED',
        `Pi emitted invalid JSON output: ${sanitize(line.slice(0, 200), secrets)}`,
      );
    }
    if (
      typeof event === 'object'
      && event !== null
      && (event as Record<string, unknown>).type === 'message_end'
    ) {
      const message = (event as Record<string, unknown>).message;
      if (
        typeof message === 'object'
        && message !== null
        && (message as Record<string, unknown>).role === 'assistant'
      ) {
        assistant = message as Record<string, unknown>;
      }
    }
  }
  if (!assistant) {
    throw new PiAdapterError(
      'PI_OUTPUT_MALFORMED',
      'Pi output did not contain a final assistant message.',
    );
  }
  if (assistant.provider !== PI_PROVIDER_ID) {
    throw new PiAdapterError(
      'PI_PROVIDER_MISMATCH',
      `Pi answered with an unexpected provider instead of ${PI_PROVIDER_ID}.`,
    );
  }
  if (assistant.model !== expectedModel) {
    throw new PiAdapterError(
      'PI_PROVIDER_MISMATCH',
      'Pi answered with a model outside the broker grant.',
    );
  }
  if (!Array.isArray(assistant.content)) {
    throw new PiAdapterError(
      'PI_OUTPUT_MALFORMED',
      'Pi assistant content must be an array.',
    );
  }
  const text = assistant.content
    .filter((entry): entry is { type: 'text'; text: string } =>
      typeof entry === 'object'
      && entry !== null
      && (entry as Record<string, unknown>).type === 'text'
      && typeof (entry as Record<string, unknown>).text === 'string')
    .map(entry => redactCopilotSecrets(entry.text, secrets))
    .join('');
  if (!text) {
    throw new PiAdapterError(
      'PI_OUTPUT_MALFORMED',
      'Pi final assistant message did not contain text.',
    );
  }
  const responseModel = assistant.responseModel;
  if (responseModel !== undefined && !nonEmpty(responseModel)) {
    throw new PiAdapterError(
      'PI_OUTPUT_MALFORMED',
      'Pi responseModel must be a non-empty string when present.',
    );
  }
  return {
    provider: assistant.provider,
    model: assistant.model,
    ...(responseModel === undefined ? {} : { responseModel }),
    text,
  };
}

function assertLoopbackGrant(
  grant: CopilotBrokerGrant,
  model: string,
  now: number,
  requiredLifetimeMs: number,
): void {
  const descriptor = grant.descriptor;
  let url: URL;
  try {
    url = new URL(descriptor.baseUrl);
  } catch (error) {
    throw new PiAdapterError(
      'PI_BROKER_GRANT_INVALID',
      'Pi broker grant has an invalid endpoint.',
      error,
    );
  }
  const valid =
    descriptor.version === 1
    && url.protocol === 'http:'
    && LOOPBACK_HOSTS.has(url.hostname)
    && url.pathname === '/v1'
    && url.username === ''
    && url.password === ''
    && url.search === ''
    && url.hash === ''
    && nonEmpty(descriptor.grantId)
    && descriptor.modelPolicy.allowedModels.includes(model)
    && descriptor.modelPolicy.defaultModel === model
    && grant.authorization.scheme === 'Bearer'
    && nonEmpty(grant.authorization.bearerToken);
  if (!valid) {
    throw new PiAdapterError(
      'PI_BROKER_GRANT_INVALID',
      'Pi broker grant is not bound to the required loopback model policy.',
    );
  }
  if (descriptor.expiresAt <= now + requiredLifetimeMs) {
    throw new PiAdapterError(
      'PI_BROKER_GRANT_EXPIRED',
      'Pi broker grant expires before the bounded invocation can finish.',
    );
  }
}

/**
 * Frontier-only Pi compatibility participant.
 *
 * It is never selected implicitly. Callers must both enable the experimental
 * gate and instantiate this participant explicitly.
 */
export class PiRappParticipant implements RappParticipant {
  private readonly config: unknown | (() => unknown);
  private readonly identitySource:
    | Readonly<LiveRappIdentity>
    | (() => Readonly<LiveRappIdentity>);
  private readonly expectedIdentity: Readonly<LiveRappIdentity>;
  private readonly broker: PiGrantBroker;
  private readonly configuredBinaryPath?: string;
  private readonly resolveBinaryHook?: () => Promise<string>;
  private readonly runtimeRoot?: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly grantTtlMs: number;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private currentDescriptor: Readonly<RappParticipantDescriptor>;
  private currentReceipt?: Readonly<PiAdapterReceipt>;

  constructor(options: PiRappParticipantOptions) {
    this.config = options.config;
    this.identitySource = options.identity;
    const initialIdentity = typeof options.identity === 'function'
      ? options.identity()
      : options.identity;
    assertIdentityBinding(initialIdentity);
    this.expectedIdentity = Object.freeze({ ...initialIdentity });
    this.broker = options.broker;
    this.configuredBinaryPath = options.binaryPath;
    this.resolveBinaryHook = options.resolveBinary;
    this.runtimeRoot = options.runtimeRoot;
    this.model = options.model?.trim() || DEFAULT_PI_MODEL;
    this.timeoutMs = boundedInteger(
      options.timeoutMs,
      DEFAULT_PI_TIMEOUT_MS,
      MAX_PI_TIMEOUT_MS,
      'timeoutMs',
    );
    this.probeTimeoutMs = boundedInteger(
      options.probeTimeoutMs,
      DEFAULT_PI_PROBE_TIMEOUT_MS,
      MAX_PI_TIMEOUT_MS,
      'probeTimeoutMs',
    );
    this.maxOutputBytes = boundedInteger(
      options.maxOutputBytes,
      DEFAULT_PI_OUTPUT_LIMIT_BYTES,
      MAX_PI_OUTPUT_LIMIT_BYTES,
      'maxOutputBytes',
    );
    this.grantTtlMs = boundedInteger(
      options.grantTtlMs,
      Math.min(MAX_PI_TIMEOUT_MS, Math.max(60_000, this.timeoutMs + 5_000)),
      MAX_PI_TIMEOUT_MS,
      'grantTtlMs',
    );
    if (this.grantTtlMs <= this.timeoutMs) {
      throw new RangeError('grantTtlMs must be greater than timeoutMs');
    }
    this.env = options.env;
    this.now = options.now ?? Date.now;
    this.currentReceipt = options.receipt === undefined
      ? undefined
      : verifyPiAdapterReceipt(options.receipt);
    this.currentDescriptor = this.descriptorForIdentity(this.expectedIdentity);
  }

  get descriptor(): Readonly<RappParticipantDescriptor> {
    return this.currentDescriptor;
  }

  get receipt(): Readonly<PiAdapterReceipt> | undefined {
    return this.currentReceipt;
  }

  async status(signal?: AbortSignal): Promise<RappParticipantStatus> {
    const features = this.assertEnabled();
    const identity = this.assertIdentityContinuity('health');
    if (signal?.aborted) {
      throw new PiAdapterError('PI_ABORTED', 'Pi status probe was cancelled.');
    }
    if (this.currentReceipt) verifyPiAdapterReceipt(this.currentReceipt);

    const executable = await this.probeExecutable(signal);
    const receipt = createReceipt(executable, this.model, features, identity, this.now());
    if (this.currentReceipt && !sameReceiptBinding(this.currentReceipt, receipt)) {
      throw new PiAdapterError(
        'PI_RECEIPT_MISMATCH',
        'Pi executable, provider policy, feature profile, or live identity changed after receipt issuance.',
      );
    }
    this.currentReceipt = receipt;
    this.currentDescriptor = Object.freeze({
      ...this.descriptorForIdentity(identity),
      harness: Object.freeze({
        name: 'pi',
        displayName: 'Pi',
        version: executable.version,
        metadata: Object.freeze({
          experimental: true,
          providerMode: PI_PROVIDER_MODE,
          piProvider: PI_PROVIDER_ID,
          executableSha256: executable.sha256,
          receiptIntegrity: receipt.integrity,
        }),
      }),
    });
    return Object.freeze({
      status: 'ok',
      descriptor: this.currentDescriptor,
      checkedAt: new Date(this.now()).toISOString(),
    });
  }

  async chat(
    request: RappParticipantChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatEnvelope> {
    this.assertEnabled();
    const parsed = parseChatRequest({
      user_input: request.userInput,
      conversation_history: request.conversationHistory,
      ...(request.sessionId === undefined ? {} : { session_id: request.sessionId }),
    });
    if (!parsed.ok) {
      throw new RappParticipantProtocolError(
        'chat',
        PI_ENDPOINT,
        `request is invalid: ${parsed.error}`,
      );
    }
    await this.status(signal);
    const identity = this.assertIdentityContinuity('chat');
    const receipt = this.currentReceipt;
    if (!receipt) {
      throw new PiAdapterError(
        'PI_RECEIPT_MISMATCH',
        'Pi invocation requires a revalidated adapter receipt.',
      );
    }
    verifyPiAdapterReceipt(receipt);

    if (signal?.aborted) {
      throw new PiAdapterError('PI_ABORTED', 'Pi invocation was cancelled.');
    }
    const grant = await this.broker.issueGrant({
      allowedModels: [this.model],
      defaultModel: this.model,
      ttlMs: this.grantTtlMs,
    });
    const bearer = grant.authorization.bearerToken;
    let runtimeDirectory: string | undefined;
    try {
      assertLoopbackGrant(grant, this.model, this.now(), this.timeoutMs);
      runtimeDirectory = await this.createRuntimeDirectory(grant);
      const result = await runProcess({
        executable: receipt.executable.path,
        args: piArguments(this.model, piPrompt(parsed.value)),
        cwd: runtimeDirectory,
        env: {
          ...safeChildEnvironment(this.environment()),
          PI_CODING_AGENT_DIR: runtimeDirectory,
          PI_CODING_AGENT_SESSION_DIR: join(runtimeDirectory, 'sessions'),
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          [PI_BROKER_BEARER_ENV]: bearer,
        },
        timeoutMs: this.timeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        signal,
        secrets: [bearer],
      });
      if (result.code !== 0) {
        const detail = sanitize(result.stderr || result.stdout, [bearer]).slice(0, 2_000);
        throw new PiAdapterError(
          'PI_PROCESS_FAILED',
          `Pi exited with code ${result.code ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}${detail ? `: ${detail}` : ''}.`,
        );
      }
      const assistant = parsePiOutput(
        result.stdout,
        this.model,
        [bearer],
      );
      this.assertIdentityContinuity('chat');
      return buildChatEnvelope({
        content: assistant.text,
        sessionId: parsed.value.sessionId ?? `pi-${randomUUID()}`,
        model: assistant.responseModel ?? assistant.model,
        requestedModel: this.model,
        backendKind: 'pi',
        extra: {
          rappid: identity.rappid,
          live_id: identity.liveId,
        },
      });
    } catch (error) {
      if (
        error instanceof PiAdapterError
        || error instanceof RappParticipantIdentityDriftError
        || error instanceof RappParticipantProtocolError
      ) {
        throw error;
      }
      throw new PiAdapterError(
        'PI_PROCESS_FAILED',
        `Pi invocation failed: ${sanitize(
          error instanceof Error ? error.message : String(error),
          [bearer],
        )}`,
        error,
      );
    } finally {
      let cleanupError: unknown;
      try {
        this.broker.revoke(grant.descriptor.grantId);
      } catch (error) {
        cleanupError = error;
      }
      if (runtimeDirectory) {
        try {
          await rm(runtimeDirectory, { recursive: true, force: true });
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (cleanupError) {
        throw new PiAdapterError(
          'PI_RUNTIME_SETUP_FAILED',
          'Could not revoke or remove the transient Pi provider profile.',
          cleanupError,
        );
      }
    }
  }

  private assertEnabled(): EffectiveFeatures {
    const config = typeof this.config === 'function' ? this.config() : this.config;
    const features = getEffectiveFeatures(config);
    if (!features.pi) {
      throw new PiAdapterError(
        'EXPERIMENTAL_FEATURE_DISABLED',
        'The experimental Pi RAPP adapter is disabled.',
      );
    }
    return features;
  }

  private assertIdentityContinuity(
    operation: RappParticipantOperation,
  ): Readonly<LiveRappIdentity> {
    const actual = typeof this.identitySource === 'function'
      ? this.identitySource()
      : this.identitySource;
    assertIdentityBinding(actual);
    if (actual.rappid !== this.expectedIdentity.rappid) {
      throw new RappParticipantIdentityDriftError(
        operation,
        PI_ENDPOINT,
        'rappid',
        this.expectedIdentity.rappid,
        actual.rappid,
      );
    }
    if (actual.liveId !== this.expectedIdentity.liveId) {
      throw new RappParticipantIdentityDriftError(
        operation,
        PI_ENDPOINT,
        'liveId',
        this.expectedIdentity.liveId,
        actual.liveId,
      );
    }
    return this.expectedIdentity;
  }

  private descriptorForIdentity(
    identity: Readonly<LiveRappIdentity>,
  ): Readonly<RappParticipantDescriptor> {
    return Object.freeze({
      rappid: identity.rappid,
      liveId: identity.liveId,
      pid: identity.pid,
      harness: Object.freeze({
        name: 'pi',
        displayName: 'Pi',
        metadata: Object.freeze({
          experimental: true,
          providerMode: PI_PROVIDER_MODE,
          piProvider: PI_PROVIDER_ID,
        }),
      }),
      endpoint: PI_ENDPOINT,
      protocol: RAPP_CHAT_PROTOCOL,
      modelAuthority: PI_MODEL_AUTHORITY,
      capabilities: PI_CAPABILITIES,
    });
  }

  private environment(): NodeJS.ProcessEnv {
    return this.env ?? process.env;
  }

  private async resolveExecutablePath(): Promise<string> {
    if (this.resolveBinaryHook) {
      return executablePath(await this.resolveBinaryHook());
    }
    if (this.configuredBinaryPath) {
      return executablePath(this.configuredBinaryPath);
    }
    return discoverPiBinary(this.environment());
  }

  private async probeExecutable(signal?: AbortSignal): Promise<PiExecutableEvidence> {
    let path: string;
    try {
      path = await this.resolveExecutablePath();
    } catch (error) {
      if (error instanceof PiAdapterError) throw error;
      throw new PiAdapterError(
        'PI_BINARY_NOT_FOUND',
        'Pi executable discovery failed.',
        error,
      );
    }
    const sha256 = await hashFile(path);
    const probeDirectory = await this.createPrivateDirectory('openrappter-pi-probe-');
    let result: ProcessResult;
    try {
      result = await runProcess({
        executable: path,
        args: ['--version'],
        cwd: probeDirectory,
        env: {
          ...safeChildEnvironment(this.environment()),
          PI_CODING_AGENT_DIR: probeDirectory,
          PI_CODING_AGENT_SESSION_DIR: join(probeDirectory, 'sessions'),
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
        },
        timeoutMs: this.probeTimeoutMs,
        maxOutputBytes: 16 * 1024,
        signal,
      });
    } finally {
      await rm(probeDirectory, { recursive: true, force: true });
    }
    if (result.code !== 0) {
      throw new PiAdapterError(
        'PI_PROBE_FAILED',
        `Pi version probe failed with code ${result.code ?? 'unknown'}.`,
      );
    }
    const version = sanitize(result.stdout).split(/\r?\n/, 1)[0]?.trim();
    if (!version) {
      throw new PiAdapterError(
        'PI_PROBE_FAILED',
        'Pi version probe returned no version.',
      );
    }
    return { path, sha256, version };
  }

  private async createRuntimeDirectory(grant: CopilotBrokerGrant): Promise<string> {
    const runtimeDirectory = await this.createPrivateDirectory('openrappter-pi-');
    try {
      const models = {
        providers: {
          [PI_PROVIDER_ID]: {
            baseUrl: grant.descriptor.baseUrl,
            apiKey: `$${PI_BROKER_BEARER_ENV}`,
            api: 'openai-completions',
            models: [{ id: this.model }],
          },
        },
      };
      const modelsPath = join(runtimeDirectory, 'models.json');
      await writeFile(modelsPath, `${JSON.stringify(models, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await chmod(modelsPath, 0o600);
      return runtimeDirectory;
    } catch (error) {
      await rm(runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw new PiAdapterError(
        'PI_RUNTIME_SETUP_FAILED',
        'Could not create the transient Pi provider profile.',
        error,
      );
    }
  }

  private async createPrivateDirectory(prefix: string): Promise<string> {
    const root = this.runtimeRoot ?? tmpdir();
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await mkdtemp(join(root, prefix));
      await chmod(directory, 0o700);
      return directory;
    } catch (error) {
      throw new PiAdapterError(
        'PI_RUNTIME_SETUP_FAILED',
        'Could not create a private Pi runtime directory.',
        error,
      );
    }
  }
}

export function createPiParticipant(
  options: PiRappParticipantOptions,
): PiRappParticipant {
  return new PiRappParticipant(options);
}
