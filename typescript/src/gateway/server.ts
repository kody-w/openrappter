/**
 * WebSocket Gateway Server
 * openclaw-compatible protocol: connect handshake, frame-based messaging,
 * chat.send → agent wiring, event broadcasting
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID, createHash, timingSafeEqual } from 'crypto';
import { parseSenses } from '../channels/senses.js';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type {
  GatewayConfig,
  GatewayStatus,
  ConnectionInfo,
  RpcMethodHandler,
  StreamingResponse,
  HealthResponse,
  AgentRequest,
  AgentResponse,
  ChatSession,
  ChatMessage,
  SendMessageRequest,
} from './types.js';
import { RPC_ERROR, GatewayEvents } from './types.js';
import { registerShowcaseMethods } from './methods/showcase-methods.js';
import { registerRappterMethods } from './methods/rappter-methods.js';
import { registerAuthMethods } from './methods/auth-methods.js';
import { registerBackupMethods } from './methods/backup-methods.js';
import { registerSurgeonMethods } from './methods/surgeon-methods.js';
import { readAnatomy } from './anatomy.js';
import { renderAnatomyPage } from './anatomy-page.js';
import type { RappterManager } from './rappter-manager.js';
import type { SurgeonService } from '../surgeon/service.js';
import { VERSION } from '../version.js';
import { buildChatEnvelope } from './chat-envelope.js';
import { parseChatRequest } from './chat-request.js';
import { buildTwinResponse, parseTwinEnvelope, sayText } from './twin-chat.js';
import { currentInstanceDeclared, currentInstanceName } from '../infra/current-instance.js';
import {
  GatewayMetrics,
  GatewayTimeoutError,
  logGatewayLifecycle,
  logGatewayRequest,
} from './observability.js';

const DEFAULT_PORT = 18790;
const DEFAULT_HEARTBEAT_INTERVAL = 30000;
const DEFAULT_CONNECTION_TIMEOUT = 120000;
const DEFAULT_SHUTDOWN_TIMEOUT = 250;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 100;
const PROTOCOL_VERSION = 3;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Parse a response that may contain a |||VOICE||| delimiter into formatted + voice parts */
function parseVoiceDelimiter(content: string): { text: string; voiceText: string } {
  if (!content) return { text: '', voiceText: '' };

  // Route through the shared sense seam so the gateway parses |||VOICE||| the
  // same way every other surface does.
  const parsed = parseSenses(content);
  if (parsed.senses.voice) {
    return { text: parsed.text, voiceText: parsed.senses.voice };
  }

  // No |||VOICE||| sense — extract first sentence as fallback voice text
  const stripped = content.replace(/\*\*|`{1,3}[^`]*`{1,3}|#{1,3}\s|>|---/g, '').trim();
  const sentences = stripped.split(/(?<=[.!?])\s+/);
  const voiceText = sentences[0]?.trim() || "I've completed your request.";
  return { text: parsed.text || content.trim(), voiceText };
}

/** Resolve a session identifier from params that may use either the
 * canonical `sessionId` field or the legacy/alternate `sessionKey` field
 * used by chat.send and several native clients (e.g. the macOS app).
 * Both names refer to the same concept; this keeps every chat.* handler
 * accepting whichever one a caller sends instead of requiring exact-name
 * matches at the RPC boundary. */
function resolveSessionId(params: { sessionId?: string; sessionKey?: string }): string | undefined {
  return params.sessionId ?? params.sessionKey;
}

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  aborted: boolean;
  generation: number;
}

interface ActiveOperation {
  generation: number;
  aborted: boolean;
  counted: boolean;
  promise?: Promise<unknown>;
}

/**
 * Constant-time string comparison for secrets (tokens/passwords).
 * Hashes both inputs to fixed-length digests before comparing so that
 * neither the early-exit behavior nor the differing lengths of the raw
 * inputs can leak timing information about the secret.
 */
function safeCompare(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

type StreamCallback = (response: StreamingResponse) => void;

/**
 * The dashboard sends `raw`, the macOS Bar sends `config`, and this server
 * historically read `content`. All three are accepted so an older client keeps
 * working; `raw` is canonical.
 */
interface ConfigWriteParams {
  raw?: string;
  content?: string;
  config?: string;
  baseHash?: string;
}
export interface GatewayReadiness {
  ready: boolean;
  status: 'ready' | 'degraded';
  reason?: string;
  details?: Record<string, unknown>;
}

class GatewayStoppedError extends Error {
  constructor() {
    super('Gateway stopped during method execution');
    this.name = 'GatewayStoppedError';
  }
}

/** Parsed incoming frame — either new protocol or legacy JSON-RPC */
interface ParsedFrame {
  type: 'req';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export class GatewayServer {
  private wss: WebSocketServer | null = null;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private connections = new Map<string, { ws: WebSocket; info: ConnectionInfo }>();
  private methods = new Map<string, { handler: RpcMethodHandler; requiresAuth: boolean }>();
  private publicHttpMethods = new Map<string, { handler: RpcMethodHandler; requiresAuth: boolean }>();
  private rateLimits = new Map<string, RateLimitEntry>();
  /**
   * Largest HTTP POST body this gateway will read, in bytes.
   *
   * 2 MB is generous for a chat turn carrying forty turns of history and far
   * below anything a model API will accept, so the cap never bites a real
   * request — it only stops the ones that were never going to work.
   * Override with OPENRAPPTER_MAX_BODY_BYTES.
   */
  private readonly maxHttpBodyBytes: number = (() => {
    const raw = Number(process.env.OPENRAPPTER_MAX_BODY_BYTES);
    return Number.isFinite(raw) && raw > 0 ? raw : 2 * 1024 * 1024;
  })();
  private config: GatewayConfig;
  private startedAt: number | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private generation = 0;
  private stopping = true;
  private stopPromise: Promise<void> | null = null;
  private activeOperations = new Set<ActiveOperation>();
  private readonly metrics = new GatewayMetrics();
  private readinessProvider?: () => Promise<GatewayReadiness>;

  // Rappter multi-soul manager
  private rappterManager?: RappterManager;

  // Callback to update the running Copilot provider token after auth.login
  private onAuthTokenUpdate?: (token: string | null) => void;

  // External handlers
  private agentHandler?: (
    request: AgentRequest,
    stream?: StreamCallback
  ) => Promise<AgentResponse>;
  private sessionStore = new Map<string, ChatSession>();
  private httpChatIdempotency = new Map<string, {
    fingerprint: string;
    expiresAt: number;
    promise: Promise<Record<string, unknown>>;
  }>();
  private activeRunsById = new Map<string, ActiveRun>();
  private activeRunBySession = new Map<string, string>();
  private channelRegistry?: {
    getStatusList(): { id: string; type: string; connected: boolean; configured: boolean; running: boolean; lastActivity?: string; lastConnectedAt?: string; messageCount: number }[];
    sendMessage(request: SendMessageRequest): Promise<void>;
    connectChannel(type: string): Promise<void>;
    disconnectChannel(type: string): Promise<void>;
    probeChannel(type: string): Promise<{ ok: boolean; error?: string }>;
    configureChannel(type: string, config: Record<string, unknown>): void;
    getChannelConfig(type: string): { config: Record<string, unknown>; fields: { key: string; label: string; type: string; required: boolean }[] };
  };
  private cronService?: {
    list(): { id: string; name: string; schedule: string; enabled: boolean; agentId?: string; nextRun?: string | null; lastRun?: string | null }[];
    run(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    getRunLogs?(jobId?: string): unknown[];
    /**
     * Add a job to the LIVE scheduler.
     *
     * Optional because not every host wires one, but its absence was a real
     * defect: `cron.add` wrote to `cronStore` (a JSON file) while `cron.list`
     * read from `cronService` (the running scheduler). A job added at runtime
     * persisted to disk, vanished from the listing, and never fired until the
     * daemon was restarted — it looked accepted and did nothing.
     */
    add?(job: Record<string, unknown>): Promise<{ id: string }>;
    remove?(id: string): Promise<void>;
  };
  private agentList?: () => { id: string; type: string; description?: string; capabilities?: string[]; tools?: { name: string; description?: string }[]; channels?: { type: string; connected: boolean }[] }[];
  private cronStore: Record<string, unknown>[] = [];
  private surgeonService?: SurgeonService;

  constructor(config?: Partial<GatewayConfig>) {
    this.config = {
      port: config?.port ?? DEFAULT_PORT,
      bind: config?.bind ?? 'loopback',
      auth: config?.auth ?? { mode: 'none' },
      heartbeatInterval: config?.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
      connectionTimeout: config?.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
      webRoot: config?.webRoot,
      dataDir: config?.dataDir,
      executionTimeoutMs: config?.executionTimeoutMs,
      shutdownTimeoutMs: config?.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT,
    };
    this.loadSessions();
    this.loadCronStore();
  }

  /**
   * Add a cron job, preferring the live scheduler so it actually runs. Falling
   * back to the file-only store keeps older hosts working, but a job that only
   * reaches the file will not fire until restart — so the reply says which
   * happened rather than reporting a uniform success.
   */
  private addCronJob = async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    // The macOS Bar called the prompt `command`; everything on this side of the
    // wire calls it `message` — the CronJob type, the scheduler, the executor
    // signature `execute(agentId, message)`, and the CLI. A job created from
    // the Bar therefore reached the scheduler with `message: ''` and fired on
    // schedule forever with nothing to say. `message` is canonical here because
    // it is what gets persisted and re-read; `command` is accepted so a Bar
    // binary built before this change keeps working.
    const { command, ...rest } = params;
    const message = rest.message ?? command;
    if (typeof message !== 'string' || message.trim() === '') {
      throw new Error(
        'Cron job requires a non-empty `message` (the macOS Bar\'s legacy `command` is also accepted). '
        + 'A job with no message runs on schedule and does nothing.',
      );
    }
    // `enabled` defaults to true when adding, so persisting without the field
    // would round-trip an enabled job back as a disabled one.
    const job = { enabled: true, ...rest, message };
    if (this.cronService?.add) {
      const created = await this.cronService.add(job);
      return { ...job, ...created, scheduled: true };
    }
    const stored = { id: `cron_${randomUUID().slice(0, 8)}`, ...job };
    this.cronStore.push(stored);
    this.saveCronStore();
    return { ...stored, scheduled: false, note: 'saved to disk; will not run until the daemon restarts' };
  };

  /**
   * The one way a cron job gets removed. The live scheduler comes FIRST: a
   * delete that only filtered the file store left the running job firing while
   * telling the caller it was gone. An id nobody knows is refused rather than
   * answered with `{ removed: true }`.
   */
  private removeCronJob = async (params: { jobId: string }): Promise<{ removed: true }> => {
    const jobId = params?.jobId;
    let removed = false;

    if (jobId && this.cronService?.remove) {
      const known = this.cronService.list().some((j) => j.id === jobId);
      if (known) {
        await this.cronService.remove(jobId);
        removed = true;
      }
    }

    const previousLength = this.cronStore.length;
    this.cronStore = this.cronStore.filter((j) => (j as { id: string }).id !== jobId);
    if (this.cronStore.length !== previousLength) {
      this.saveCronStore();
      removed = true;
    }

    if (!removed) throw new Error(`Cron job not found: ${jobId || '(empty id)'}`);
    return { removed: true };
  };

  /**
   * Installs a dropped agent into the running organism.
   *
   * Injected rather than constructed here because only the daemon owns the live
   * registry; a gateway that wrote files without reaching that registry would be
   * able to report success for an agent that is not actually usable.
   */
  private agentImporter?: (filename: string, contents: Buffer) => Promise<{
    status: 'ok' | 'error';
    learned?: { name: string; description: string }[];
    file?: string;
    error?: string;
    replaced?: boolean;
  }>;

  setAgentImporter(fn: NonNullable<GatewayServer['agentImporter']>): void {
    this.agentImporter = fn;
  }

  /* ---- persistence ---- */

  private get dataDir(): string {
    const dir = this.config.dataDir ?? path.join(os.homedir(), '.openrappter');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private get sessionsPath(): string {
    return path.join(this.dataDir, 'sessions.json');
  }

  private get configPath(): string {
    return path.join(this.dataDir, 'config.yaml');
  }

  private loadSessions() {
    try {
      if (fs.existsSync(this.sessionsPath)) {
        const data = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf-8'));
        if (Array.isArray(data)) {
          for (const s of data) {
            this.sessionStore.set(s.id, s);
          }
        }
      }
    } catch { /* ignore corrupt file */ }
  }

  private saveSessions() {
    try {
      const data = Array.from(this.sessionStore.values());
      fs.writeFileSync(this.sessionsPath, JSON.stringify(data, null, 2));
    } catch { /* ignore write errors */ }
  }

  private loadConfig(): string {
    try {
      if (fs.existsSync(this.configPath)) {
        return fs.readFileSync(this.configPath, 'utf-8');
      }
    } catch { /* ignore */ }
    return '';
  }

  private saveConfig(content: string) {
    fs.writeFileSync(this.configPath, content, 'utf-8');
  }

  /**
   * Identifies the config bytes a client last read, so a save can refuse to
   * overwrite an edit it never saw.
   */
  private configHash(raw: string): string {
    return createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 16);
  }

  private get cronStorePath(): string {
    return path.join(this.dataDir, 'cron.json');
  }

  private loadCronStore() {
    try {
      if (fs.existsSync(this.cronStorePath)) {
        this.cronStore = JSON.parse(fs.readFileSync(this.cronStorePath, 'utf-8'));
      }
    } catch { /* ignore */ }
  }

  private saveCronStore() {
    try {
      fs.writeFileSync(this.cronStorePath, JSON.stringify(this.cronStore, null, 2));
    } catch { /* ignore */ }
  }

  private isGenerationActive(generation: number): boolean {
    return !this.stopping && generation === this.generation && this.wss !== null;
  }

  /**
   * Track work that ultimately runs outside the gateway (agent providers and
   * cron services). Stop can fence its callbacks and wait briefly for it, but
   * the legacy handler contracts do not expose an AbortSignal, so underlying
   * cancellation remains best effort.
   */
  private async runAgentOperation<T>(
    generation: number,
    task: () => Promise<T>,
  ): Promise<T> {
    if (!this.isGenerationActive(generation)) throw new GatewayStoppedError();

    const operation: ActiveOperation = {
      generation,
      aborted: false,
      counted: true,
    };
    this.activeOperations.add(operation);
    this.metrics.agentExecutionStarted();

    const promise = Promise.resolve().then(task);
    operation.promise = promise;

    try {
      const result = await promise;
      if (operation.aborted || !this.isGenerationActive(generation)) {
        throw new GatewayStoppedError();
      }
      return result;
    } finally {
      this.activeOperations.delete(operation);
      if (operation.counted) {
        operation.counted = false;
        this.metrics.agentExecutionFinished();
      }
    }
  }

  private abortGenerationOperations(generation: number): Promise<unknown>[] {
    const pending: Promise<unknown>[] = [];
    for (const operation of this.activeOperations) {
      if (operation.generation !== generation) continue;
      operation.aborted = true;
      if (operation.counted) {
        operation.counted = false;
        this.metrics.agentExecutionFinished();
      }
      if (operation.promise) pending.push(operation.promise);
    }
    return pending;
  }

  private async waitBoundedly(promises: Promise<unknown>[], timeoutMs: number): Promise<boolean> {
    if (promises.length === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(promises).then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  setAgentHandler(
    handler: (request: AgentRequest, stream?: StreamCallback) => Promise<AgentResponse>
  ): void {
    this.agentHandler = handler;
  }

  /**
   * Register a callback invoked when auth.login or auth.switch provides a new token.
   * Use this to update the running Copilot provider without a restart.
   */
  setAuthTokenCallback(cb: (token: string | null) => void): void {
    this.onAuthTokenUpdate = cb;
  }

  setChannelRegistry(registry: {
    getStatusList(): { id: string; type: string; connected: boolean; configured: boolean; running: boolean; lastActivity?: string; lastConnectedAt?: string; messageCount: number }[];
    sendMessage(request: SendMessageRequest): Promise<void>;
    connectChannel(type: string): Promise<void>;
    disconnectChannel(type: string): Promise<void>;
    probeChannel(type: string): Promise<{ ok: boolean; error?: string }>;
    configureChannel(type: string, config: Record<string, unknown>): void;
    getChannelConfig(type: string): { config: Record<string, unknown>; fields: { key: string; label: string; type: string; required: boolean }[] };
  }): void {
    this.channelRegistry = registry;
  }

  setCronService(service: {
    list(): { id: string; name: string; schedule: string; enabled: boolean; agentId?: string; nextRun?: string | null; lastRun?: string | null }[];
    run(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    getRunLogs?(jobId?: string): unknown[];
    add?(job: Record<string, unknown>): Promise<{ id: string }>;
    remove?(id: string): Promise<void>;
  }): void {
    this.cronService = service;
  }

  private async runCronServiceJob(jobId: string, generation = this.generation): Promise<void> {
    if (!this.cronService) throw new Error('Cron service not configured');
    const cronService = this.cronService;
    await this.runAgentOperation(generation, () => cronService.run(jobId));
  }

  setAgentList(listFn: () => { id: string; type: string; description?: string; capabilities?: string[]; tools?: { name: string; description?: string }[]; channels?: { type: string; connected: boolean }[] }[]): void {
    this.agentList = listFn;
  }

  setRappterManager(manager: RappterManager): void {
    this.rappterManager = manager;
  }

  setSurgeonService(service: SurgeonService): void {
    this.surgeonService = service;
  }

  setReadinessProvider(
    provider: (() => Promise<GatewayReadiness>) | undefined,
  ): void {
    this.readinessProvider = provider;
  }

  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: RpcMethodHandler<P, R>,
    options?: { requiresAuth?: boolean }
  ): void {
    this.methods.set(name, {
      handler: handler as RpcMethodHandler,
      requiresAuth: options?.requiresAuth ?? false,
    });
  }

  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise;
    if (this.wss) return;
    if (this.config.bind === 'all' && (this.config.auth?.mode ?? 'none') === 'none') {
      throw new Error('Gateway auth is required when binding to all interfaces');
    }

    const host = this.config.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';
    this.generation++;
    this.stopping = false;

    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));

    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: (info: { req: IncomingMessage }) => this.validateRequestSource(info.req).ok,
    });
    this.startedAt = Date.now();
    this.metrics.start();

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.wss.on('error', (error) => logGatewayLifecycle(
      'gateway', 'listener.error', `Gateway server error: ${error.message}`, undefined, 'error'
    ));

    this.registerBuiltInMethods();
    this.startHeartbeat();

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.config.port, host, () => resolve());
      this.httpServer!.on('error', reject);
    });

    logGatewayLifecycle(
      'gateway',
      'start',
      `Gateway server started on ${host}:${this.config.port}`,
      { host, port: this.config.port }
    );
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const stopPromise = this.stopInternal();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) this.stopPromise = null;
    }
  }

  private async stopInternal(): Promise<void> {
    if (!this.wss && !this.httpServer && this.startedAt === null) return;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.broadcastEvent(GatewayEvents.SHUTDOWN, { reason: 'Server shutting down' });
    const stoppedGeneration = this.generation;
    this.stopping = true;
    this.generation++;

    for (const run of [...this.activeRunsById.values()]) {
      this.abortActiveRun(run, false);
    }
    this.activeRunsById.clear();
    this.activeRunBySession.clear();
    const pendingOperations = this.abortGenerationOperations(stoppedGeneration);

    for (const { ws } of this.connections.values()) {
      ws.close(1000, 'Server shutting down');
    }
    this.connections.clear();
    this.rateLimits.clear();

    const wss = this.wss;
    const httpServer = this.httpServer;
    this.wss = null;
    this.httpServer = null;

    const shutdownWaits: Promise<unknown>[] = [...pendingOperations];
    if (wss) {
      shutdownWaits.push(new Promise<void>((resolve) => {
        try {
          wss.close(() => resolve());
        } catch {
          resolve();
        }
      }));
    }
    if (httpServer) {
      shutdownWaits.push(new Promise<void>((resolve) => {
        try {
          httpServer.close(() => resolve());
        } catch {
          resolve();
        }
      }));
    }

    const drained = await this.waitBoundedly(
      shutdownWaits,
      this.config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT,
    );
    if (!drained) {
      for (const client of wss?.clients ?? []) client.terminate();
      const forceClose = httpServer as typeof httpServer & {
        closeAllConnections?: () => void;
      };
      forceClose?.closeAllConnections?.();
    }

    this.startedAt = null;
    this.metrics.stop();
    logGatewayLifecycle('gateway', 'stop', 'Gateway server stopped');
  }

  /**
   * Everything the anatomy page can only learn from a running daemon.
   *
   * Read at request time rather than cached: a number that moves is what proves
   * the organism is alive, and a stale one would be a quiet lie.
   */
  private liveSignals(): import('./anatomy.js').LiveSignals {
    const agents = this.agentList?.() ?? [];
    return {
      awake: true,
      backend: this.backendStatus
        ? { kind: this.backendStatus.kind, reason: this.backendStatus.reason }
        : undefined,
      startedAt: this.startedAt ?? undefined,
      agents: agents.map(a => ({ id: a.id, name: a.id, description: a.description })),
      connections: this.connections.size,
      port: this.config.port,
      version: VERSION,
      cron: this.cronService?.list().map(j => ({
        name: j.name,
        agentId: j.agentId,
        nextRun: j.nextRun ?? null,
        lastRun: j.lastRun ?? null,
        enabled: j.enabled,
      })),
      channels: agents.length
        ? agents.flatMap(a => a.channels ?? []).map(c => ({ type: c.type, connected: c.connected }))
        : undefined,
    };
  }

  getStatus(): GatewayStatus {
    return {
      running: !!this.wss,
      port: this.config.port,
      connections: this.connections.size,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      version: VERSION,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : '',
      metrics: this.metrics.snapshot(this.connections.size),
    };
  }

  /** Broadcast an event to all authenticated connections (type: "event" frame) */
  broadcastEvent(event: string, payload: unknown, filter?: (conn: ConnectionInfo) => boolean): void {
    if (this.stopping || !this.wss) return;
    const frame = JSON.stringify({ type: 'event', event, payload });

    for (const { ws, info } of this.connections.values()) {
      if (!info.authenticated) continue;
      if (filter && !filter(info)) continue;
      if (!info.subscriptions.has(event) && !info.subscriptions.has('*')) continue;
      try { ws.send(frame); } catch { /* ignore */ }
    }
  }

  /** Legacy broadcast (alias for backward compat) */
  broadcast(event: string, data: unknown, filter?: (conn: ConnectionInfo) => boolean): void {
    this.broadcastEvent(event, data, filter);
  }

  getConnection(connId: string): ConnectionInfo | undefined {
    return this.connections.get(connId)?.info;
  }

  getConnections(): ConnectionInfo[] {
    return Array.from(this.connections.values()).map((c) => c.info);
  }

  // ── Private: HTTP ────────────────────────────────────────────────────

  private static readonly MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.map': 'application/json',
  };

  /**
   * Browser requests must come from the exact gateway origin. Originless
   * native clients remain supported, but Host is always validated to block
   * DNS-rebinding aliases from reaching an unauthenticated loopback gateway.
   */
  private validateRequestSource(req: IncomingMessage): { ok: boolean; origin?: string } {
    const hostHeader = req.headers.host;
    if (!hostHeader || hostHeader.length > 255) return { ok: false };

    let authority: URL;
    try {
      authority = new URL(`http://${hostHeader}`);
    } catch {
      return { ok: false };
    }
    if (
      authority.username
      || authority.password
      || authority.pathname !== '/'
      || authority.search
      || authority.hash
    ) {
      return { ok: false };
    }

    const hostname = authority.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (this.config.bind === 'loopback' && !LOOPBACK_HOSTS.has(hostname)) {
      return { ok: false };
    }

    const originHeader = req.headers.origin;
    if (originHeader === undefined) return { ok: true };
    if (Array.isArray(originHeader)) return { ok: false };

    let origin: URL;
    try {
      origin = new URL(originHeader);
    } catch {
      return { ok: false };
    }

    const expectedProtocol = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted
      ? 'https:'
      : 'http:';
    if (
      origin.protocol !== expectedProtocol
      || origin.username
      || origin.password
      || origin.pathname !== '/'
      || origin.search
      || origin.hash
      || origin.host.toLowerCase() !== authority.host.toLowerCase()
    ) {
      return { ok: false };
    }

    return { ok: true, origin: origin.origin };
  }

  private corsHeaders(origin?: string): Record<string, string> {
    return {
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Gateway-Token',
      Vary: 'Origin',
    };
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/livez' && req.method === 'GET') {
      const live = Boolean(this.wss);
      res.writeHead(live ? 200 : 503, {
        'Content-Type': 'application/json',
        Connection: 'close',
      });
      res.end(JSON.stringify({
        live,
        timestamp: new Date().toISOString(),
      }));
      return;
    }
    if (req.url === '/readyz' && req.method === 'GET') {
      const readiness = this.readinessProvider
        ? this.readinessProvider()
        : Promise.resolve<GatewayReadiness>({
            ready: Boolean(this.wss),
            status: this.wss ? 'ready' : 'degraded',
            reason: this.wss ? undefined : 'gateway_stopped',
          });
      void readiness.then(result => {
        res.writeHead(result.ready ? 200 : 503, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(JSON.stringify({
          ...result,
          timestamp: new Date().toISOString(),
        }));
      }).catch(() => {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          Connection: 'close',
        });
        res.end(JSON.stringify({
          ready: false,
          status: 'degraded',
          reason: 'readiness_check_failed',
          timestamp: new Date().toISOString(),
        }));
      });
      return;
    }
    const source = this.validateRequestSource(req);
    if (!source.ok) {
      res.writeHead(403, { 'Content-Type': 'application/json', Vary: 'Origin' });
      res.end(JSON.stringify({ error: 'Forbidden request origin' }));
      return;
    }
    const corsHeaders = this.corsHeaders(source.origin);

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      const health = this.getHealthResponse();
      res.writeHead(health.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(health));
      return;
    }
    if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(this.getStatus()));
      return;
    }

    // ── The anatomy page ──────────────────────────────────────────────────
    // One page, three surfaces: this URL, the dino's WKWebView, and the chat
    // surface. Served rather than duplicated so the three cannot drift.
    // Match on the PATH, not the raw URL. `/bones?organ=heart` is the same page
    // as `/bones`; comparing the whole request target made the deep link fall
    // through to the SPA, which silently served a different page.
    const pathOnly = (req.url ?? '').split('?')[0];
    if ((pathOnly === '/bones' || pathOnly === '/bones/' || pathOnly === '/anatomy') && req.method === 'GET') {
      const page = renderAnatomyPage(readAnatomy(undefined, this.liveSignals()));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders });
      res.end(page);
      return;
    }
    if (pathOnly === '/anatomy.json' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
      res.end(JSON.stringify(readAnatomy(undefined, this.liveSignals())));
      return;
    }
    // Voice UI (the rappter-vui fauna player) — served same-origin so it can
    // reach this gateway over WebSocket without mixed-content blocking.
    if ((req.url === '/vui' || req.url === '/vui/' || req.url === '/vui/index.html') && req.method === 'GET') {
      const vuiPath = path.join(os.homedir(), '.openrappter', 'vui', 'index.html');
      fs.readFile(vuiPath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'Content-Type': 'text/plain', ...corsHeaders });
          res.end('Voice UI not installed. Expected at ~/.openrappter/vui/index.html');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders });
        res.end(data);
      });
      return;
    }

    // JSON-RPC over HTTP POST — allows browser games and local apps to call the gateway
    if (req.method === 'POST') {
      const requestGeneration = this.generation;
      let body = '';
      let bodyBytes = 0;
      let bodyTooLarge = false;
      let discarded = 0;
      /**
       * Cap the read. `body += chunk.toString()` had no limit, so a single
       * untrusted POST could grow a string until the daemon died — and this
       * gateway is meant to face peers on a shared wire, where "untrusted" is
       * the normal case rather than the exception.
       *
       * Measured before writing this, against both runtimes on this machine:
       * a 10 MB body was accepted by BOTH, buffered whole, and forwarded to
       * the paid model API, which rejected it with 413. So the old behaviour
       * did not merely risk memory — it spent an upstream call on garbage, and
       * the two runtimes then disagreed about the wreckage (brainstem 502,
       * openrappter 503). Rejecting at the door costs nothing and is the same
       * answer every time.
       *
       * This is a DELIBERATE divergence from the brainstem, which has no cap.
       * Everywhere else on /chat the rule is to match it exactly; here matching
       * it would mean copying a hole. The brainstem should adopt the same cap —
       * it is a different repository and not mine to change.
       */
      req.on('data', (chunk: Buffer) => {
        if (bodyTooLarge) {
          // Keep DISCARDING, do not keep accumulating. Memory is protected the
          // moment we stop appending; the rest is just politeness to the client.
          discarded += chunk.length;
          if (discarded > this.maxHttpBodyBytes * 8) req.destroy();
          return;
        }
        bodyBytes += chunk.length;
        if (bodyBytes > this.maxHttpBodyBytes) {
          bodyTooLarge = true;
          body = '';                       // release what was already buffered
          return;
        }
        body += chunk.toString();
      });
      req.on('end', async () => {
        if (bodyTooLarge) {
          /**
           * Answered HERE, not the instant the limit was crossed.
           *
           * Ending the response while the client is still uploading resets the
           * connection: the caller gets ECONNRESET instead of an answer. Found
           * by probing a live daemon with 10 MB, after a unit test with a 2 MB
           * overage passed — small bodies flush before the race can happen, so
           * the first version of this looked correct and was not.
           *
           * Waiting costs nothing now that the payload is being discarded
           * rather than buffered, and the caller gets a 413 it can actually
           * read and act on.
           */
          const isChat = (req.url ?? '').split('?')[0] === '/chat';
          if (!res.writableEnded) {
            res.writeHead(413, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify(isChat
              ? { error: 'Request body too large' }
              : { error: 'Request body too large', limit_bytes: this.maxHttpBodyBytes }));
          }
          return;
        }
        const dispatchStartedAt = Date.now();
        try {
          if (!this.isGenerationActive(requestGeneration)) {
            if (!res.writableEnded) {
              res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ error: 'Gateway is stopping' }));
            }
            return;
          }

          const parsed = JSON.parse(body);

          // ── Hot-load a dropped agent ────────────────────────────────────
          // Mirrors the grail brainstem's /agents/import: verify by loading,
          // roll back on failure, refuse name collisions. "Hot" means usable in
          // the very next message — the handler is what makes that true, by
          // reaching the live registry rather than only the disk.
          // Match on the PATH, not the raw URL — the same lesson `/bones`
          // already learned above. `POST /chat?x=1` compared unequal to
          // '/chat', fell past this handler entirely, and was answered by the
          // generic echo branch below with a 200 and `Received: …`. A caller
          // could therefore skip every validation rule in the contract by
          // adding a query string, and would be told it had succeeded.
          if (pathOnly === '/agents/import') {
            /**
             * The gateway's credential, checked before the importer is
             * consulted at all. #119
             *
             * This was the third route in this dispatch block and the last one
             * with no gate, after #113 closed `/twin`. Its sink is not model
             * spend: `contents` is written to disk and then LOADED —
             * `importAgentFile` -> `introspectPythonAgents` -> `runner.py`
             * `spec.loader.exec_module`. Top-level code in an uploaded `.py`
             * runs as the daemon user, and the `.js` branch reaches the same
             * place through `reloadUserAgents()`.
             *
             * Measured on a token-mode server with a spy importer and no
             * credential: `/chat` answered 401 with the agent never invoked,
             * and `/agents/import` reached the importer. The 400 a caller sees
             * is the importer's own validation error — by then it had already
             * been given the payload.
             *
             * The gate is ahead of the `!this.agentImporter` 503 as well, so an
             * unauthenticated caller cannot learn whether this daemon installs
             * agents. Every hatched twin runs this same entry point, so each
             * one exposed it on its own port.
             */
            if (!this.resolveHttpAuthenticated(req, parsed)) {
              res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ status: 'error', error: 'Authentication required' }));
              return;
            }
            if (!this.agentImporter) {
              res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ status: 'error', error: 'This daemon cannot install agents.' }));
              return;
            }
            const filename = typeof parsed.filename === 'string' ? parsed.filename : '';
            const contents = typeof parsed.contents === 'string' ? parsed.contents : '';
            if (!filename || !contents) {
              res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ status: 'error', error: 'filename and contents are required' }));
              return;
            }
            const result = await this.agentImporter(filename, Buffer.from(contents, 'utf-8'));
            res.writeHead(result.status === 'ok' ? 200 : 400, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify(result));
            return;
          }

          if (pathOnly === '/twin') {
            /**
             * The neighborhood wire. #96.
             *
             * A `say` is a turn between two named peers, so it routes through
             * the same agent handler `/chat` uses and returns the same four
             * keys — nested in the §6e response envelope, which echoes the
             * request so a peer can match a reply to what it sent.
             *
             * `console` is refused inside parseTwinEnvelope: it operates a
             * neighbor's runtime and is sealed-only, and this gateway has no
             * seal. Nothing below authenticates `from_rappid`; it is a claim.
             */
            /**
             * The gateway's own credential, checked BEFORE the envelope is
             * parsed. #113
             *
             * `/chat` has always enforced this and `/twin` did not, while both
             * route into the same `agentHandler` — so the gateway credential,
             * whose entire purpose is keeping strangers out of the agent, was
             * closed on one path and open on the other. Measured on a real
             * server: `/chat` without a token answered 401 and `/twin` without
             * a token answered 200 with the agent having run.
             *
             * This comment originally cited `openrappter gateway --bind all
             * --token SECRET` as the configuration at risk. That command does
             * not ship: `registerGatewayCommand` is exported from
             * `cli/index.ts` and never called, and `gateway --bind all` answers
             * `unknown option '--bind'`. The credential that DOES exist is
             * `OPENRAPPTER_TOKEN` on the loopback daemon, which is the boundary
             * this actually protects. #119
             *
             * `validateRequestSource` does not cover this: its loopback check
             * is gated on `bind === 'loopback'` and is skipped under
             * `--bind all`, the only configuration where a token means
             * anything.
             *
             * Refusing `console` is not a substitute — a `say` reaches the
             * model just as surely.
             *
             * It runs before parsing so an unauthenticated caller learns
             * nothing about envelope validity; otherwise the 400s become an
             * oracle for probing the wire format without a credential.
             */
            if (!this.resolveHttpAuthenticated(req, parsed)) {
              res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ error: 'Authentication required' }));
              return;
            }

            const twin = parseTwinEnvelope(parsed);
            if (!twin.ok) {
              res.writeHead(twin.status, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ error: twin.error }));
              return;
            }
            const env = twin.value;

            // An ack is an acknowledgement, not a question. Answering it with a
            // model call would be a way to bill someone for saying "got it".
            if (env.kind === 'ack') {
              res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify(buildTwinResponse({
                envelope: env, response: '', sessionId: env.nonce,
              })));
              return;
            }

            if (!this.agentHandler) {
              res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ error: 'Agent handler not configured' }));
              return;
            }
            const text = sayText(env);
            if (!text) {
              res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ error: 'payload carries no text' }));
              return;
            }
            try {
              // The nonce is the session key: it is unique per envelope and the
              // peer already knows it, so a reply can be correlated without
              // inventing an id neither side has seen.
              const result = await this.runWithTimeout(this.agentHandler({
                message: text,
                sessionId: env.nonce,
              }));
              res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify(buildTwinResponse({
                envelope: env,
                response: result.content,
                sessionId: result.sessionId ?? env.nonce,
                agentLogs: (result.agentLogs ?? []).join('\n'),
              })));
            } catch (error) {
              res.writeHead(error instanceof GatewayTimeoutError ? 504 : 503,
                { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ error: (error as Error).message }));
            }
            return;
          }

          if (pathOnly === '/chat') {
            const authenticated = this.resolveHttpAuthenticated(req, parsed);
            if (!authenticated) {
              res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({
                schema: 'rapp-chat/1.0',
                status: 'error',
                error: 'Authentication required',
              }));
              return;
            }
            if (!this.agentHandler) {
              res.writeHead(503, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({
                schema: 'rapp-chat/1.0',
                status: 'error',
                error: 'Agent handler not configured',
              }));
              return;
            }
            // One validator, shared with the grail brainstem's `chat()`. It
            // reports the same faults in the same order and the same words —
            // and, critically, REFUSES a malformed conversation_history instead
            // of silently dropping it and answering 200 as though it had read
            // the transcript.
            const parsedRequest = parseChatRequest(parsed);
            if (!parsedRequest.ok) {
              // Bare `{error}`, exactly as the brainstem writes it. PARITY §3
              // permits extra axes, but the goal on this wire is stronger than
              // §3: a peer must not be able to tell which runtime answered. A
              // single malformed request was enough to fingerprint us, because
              // ours carried `schema` and `status` and the brainstem's does not.
              // Those keys survive on the paths the brainstem has no
              // counterpart for (401 auth, 503, 409, 504) — nothing can be
              // compared there, so nothing diverges.
              res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ error: parsedRequest.error }));
              return;
            }
            const message = parsedRequest.value.userInput;
            const sessionId = parsedRequest.value.sessionId ?? randomUUID();
            const idempotencyKey = (
              typeof parsed.idempotency_key === 'string'
                ? parsed.idempotency_key
                : typeof parsed.idempotencyKey === 'string'
                  ? parsed.idempotencyKey
                  : undefined
            );
            const conversationHistory = parsedRequest.value.conversationHistory.length > 0
              ? parsedRequest.value.conversationHistory
              : undefined;
            const agentHandler = this.agentHandler;
            const executeChat = async (): Promise<Record<string, unknown>> => {
              const result = await agentHandler({
                message,
                sessionId,
                conversationHistory,
                conversationId: typeof parsed.conversation_id === 'string'
                  ? parsed.conversation_id
                  : undefined,
                channelId: typeof parsed.channel_id === 'string'
                  ? parsed.channel_id
                  : undefined,
                userId: typeof parsed.user_id === 'string'
                  ? parsed.user_id
                  : undefined,
              });
              // One builder for both runtimes, so the two cannot drift apart
              // again. It also splits the voice seam, which is why the raw
              // |||VOICE||| marker no longer reaches the caller.
              return buildChatEnvelope({
                content: result.content,
                sessionId: result.sessionId,
                agentLogs: result.agentLogs
                  ?? (result.toolCalls ? [JSON.stringify(result.toolCalls)] : []),
                model: result.model,
                requestedModel:
                  result.requestedModel ??
                  this.backendStatus?.requestedModel,
                // Lets the envelope explain an unattributed model instead of
                // reporting the bare word "unknown".
                backendKind: this.backendStatus?.kind,
                extra: idempotencyKey ? { idempotency_key: idempotencyKey } : undefined,
              });
            };

            let responsePromise: Promise<Record<string, unknown>>;
            if (idempotencyKey) {
              const now = Date.now();
              for (const [key, value] of this.httpChatIdempotency) {
                if (value.expiresAt <= now) this.httpChatIdempotency.delete(key);
              }
              const fingerprint = createHash('sha256').update(JSON.stringify({
                message,
                session_id: parsed.session_id ?? parsed.sessionId ?? null,
                conversation_history: conversationHistory ?? null,
              })).digest('hex');
              const existing = this.httpChatIdempotency.get(idempotencyKey);
              if (existing && existing.fingerprint !== fingerprint) {
                res.writeHead(409, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({
                  schema: 'rapp-chat/1.0',
                  status: 'error',
                  error: 'Idempotency key conflicts with another request',
                }));
                return;
              }
              if (existing) {
                responsePromise = existing.promise;
              } else {
                responsePromise = executeChat();
                this.httpChatIdempotency.set(idempotencyKey, {
                  fingerprint,
                  expiresAt: now + 15 * 60 * 1000,
                  promise: responsePromise,
                });
                if (this.httpChatIdempotency.size > 512) {
                  const oldest = this.httpChatIdempotency.keys().next().value;
                  if (oldest) this.httpChatIdempotency.delete(oldest);
                }
              }
            } else {
              responsePromise = executeChat();
            }
            try {
              const responseBody = await this.runWithTimeout(responsePromise);
              if (!this.isGenerationActive(requestGeneration)) return;
              res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify(responseBody));
            } catch (error) {
              if (idempotencyKey && !(error instanceof GatewayTimeoutError)) {
                this.httpChatIdempotency.delete(idempotencyKey);
              }
              if (!this.isGenerationActive(requestGeneration)) return;
              res.writeHead(
                error instanceof GatewayTimeoutError ? 504 : 503,
                { 'Content-Type': 'application/json', ...corsHeaders }
              );
              res.end(JSON.stringify({
                schema: 'rapp-chat/1.0',
                status: 'error',
                error: (error as Error).message,
                session_id: sessionId,
                sessionId,
              }));
            }
            return;
          }
          if (parsed.jsonrpc === '2.0' && typeof parsed.method === 'string') {
            const authenticated = this.resolveHttpAuthenticated(req, parsed);
            const method = this.methods.get(parsed.method);
            const isPublicMethod = !!method
              && this.publicHttpMethods.get(parsed.method) === method;

            // HTTP is fail-closed whenever gateway credentials are configured:
            // every method except the immutable built-in health handlers
            // requires a valid credential, regardless of registration
            // metadata. A plugin replacing a public name does not inherit
            // the original handler's exemption.
            if (!isPublicMethod && !authenticated) {
              this.metrics.recordRequest('auth_failure');
              logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'http', outcome: 'auth_failure', durationMs: Date.now() - dispatchStartedAt });
              res.writeHead(401, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: RPC_ERROR.UNAUTHORIZED, message: `Method '${parsed.method}' requires authentication` } }));
              return;
            }

            if (!method) {
              this.metrics.recordRequest('error');
              logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'http', outcome: 'error', durationMs: Date.now() - dispatchStartedAt });
              res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: `Method not found: ${parsed.method}` } }));
              return;
            }

            const info: ConnectionInfo = {
              id: 'http',
              connectedAt: new Date().toISOString(),
              authenticated,
              subscriptions: new Set(),
              lastActivity: Date.now(),
              metadata: {},
            };
            try {
              const result = await this.runWithTimeout(method.handler(parsed.params || {}, info));
              if (!this.isGenerationActive(requestGeneration)) return;
              this.metrics.recordRequest('success');
              logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'http', outcome: 'success', durationMs: Date.now() - dispatchStartedAt });
              res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }));
            } catch (error) {
              if (
                error instanceof GatewayStoppedError
                || !this.isGenerationActive(requestGeneration)
              ) {
                return;
              }
              if (error instanceof GatewayTimeoutError) {
                this.metrics.recordRequest('timeout');
                logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'http', outcome: 'timeout', durationMs: Date.now() - dispatchStartedAt });
                res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: RPC_ERROR.TIMEOUT, message: error.message } }));
                return;
              }
              this.metrics.recordRequest('error');
              logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'http', outcome: 'error', durationMs: Date.now() - dispatchStartedAt });
              res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: RPC_ERROR.INTERNAL_ERROR, message: (error as Error).message } }));
            }
          } else {
            /**
             * An unknown POST path is 404, not 200.
             *
             * This branch used to answer every unrecognised path with
             * `200 {"response":"Received: …", "status":{…}}`, which broke two
             * things at once on a wire meant for peers:
             *
             *   - CAPABILITY DETECTION. A peer asking whether this runtime
             *     speaks the twin envelope would `POST /twin` and be told yes.
             *     `/twin` does not exist. Neither did `/definitely-not-real`,
             *     which also answered 200. Every probe succeeded, so no peer
             *     could distinguish an implemented endpoint from an imaginary
             *     one. The brainstem answers 404, as it should.
             *
             *   - IDENTITY. The echoed `status` carried port, uptime, version,
             *     startedAt and metrics, unauthenticated, to anyone who POSTed
             *     any path at all — a fingerprint handed over on request, on a
             *     wire whose premise is that a peer cannot tell a rappter from
             *     a brainstem from a person.
             *
             * It is also the branch `POST /chat?x=1` fell into before the route
             * was matched on the path, which let a caller skip every validation
             * rule in the contract and be told it had succeeded.
             */
            this.metrics.recordRequest('error');
            res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ error: `No such endpoint: ${pathOnly}` }));
          }
        } catch {
          // The brainstem answers malformed JSON with the same sentence it uses
          // for a non-object body — `get_json(silent=True)` yields None and
          // falls into the same branch. A `/chat` caller must not be able to
          // tell the two runtimes apart by their parse errors either.
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify(
            pathOnly === '/chat'
              ? { error: 'Request body must be a JSON object' }
              : { error: 'Invalid JSON' },
          ));
        }
      });
      return;
    }

    // Static file serving when webRoot is configured
    if (this.config.webRoot) {
      this.serveStaticFile(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private serveStaticFile(req: IncomingMessage, res: ServerResponse): void {
    const webRoot = this.config.webRoot!;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const filePath = decodeURIComponent(url.pathname);

    // Guard against path traversal
    const resolved = path.resolve(webRoot, '.' + filePath);
    if (!resolved.startsWith(path.resolve(webRoot))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }

    // Try to serve the file; fall back to index.html for SPA routing
    const tryServe = (target: string, fallback: boolean) => {
      fs.stat(target, (err, stats) => {
        if (err || !stats.isFile()) {
          if (fallback) {
            // SPA fallback: serve index.html
            const indexPath = path.join(webRoot, 'index.html');
            fs.readFile(indexPath, (indexErr, data) => {
              if (indexErr) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(data);
            });
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));
          }
          return;
        }

        const ext = path.extname(target).toLowerCase();
        const mime = GatewayServer.MIME_TYPES[ext] ?? 'application/octet-stream';
        fs.readFile(target, (readErr, data) => {
          if (readErr) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal error' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': mime });
          res.end(data);
        });
      });
    };

    // If path is / or has no extension, try index.html directly then SPA fallback
    if (filePath === '/') {
      tryServe(path.join(webRoot, 'index.html'), false);
    } else {
      tryServe(resolved, true);
    }
  }

  private getHealthResponse(): HealthResponse {
    return {
      status: this.wss ? 'ok' : 'error',
      version: VERSION,
      /**
       * Which rappter is answering. — #131
       *
       * The roster decided whether an endpoint record was still an address by
       * comparing the recorded pid to the pid holding the port, obtained from
       * `lsof`. Where `lsof` cannot answer, that comparison was skipped and the
       * record was certified anyway — the guard failed OPEN, which is the
       * defect #118 exists to prevent.
       *
       * A listener saying its own name is better evidence than a pid lookup:
       * a pid proves only "the same process wrote this record", while a name
       * proves "you have reached the rappter you asked for". It also needs no
       * external binary, so it holds on platforms where `lsof` is absent.
       *
       * `alpha` is a real answer, not a default — see infra/current-instance.
       */
      instance: currentInstanceDeclared() ? (currentInstanceName() ?? 'alpha') : undefined,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      timestamp: new Date().toISOString(),
      checks: {
        gateway: !!this.wss,
        storage: true,
        channels: !!this.channelRegistry,
        agents: !!this.agentHandler,
        copilot: !!this.onAuthTokenUpdate,
      },
      metrics: this.metrics.snapshot(this.connections.size),
    };
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      this.broadcastEvent(GatewayEvents.HEARTBEAT, {
        timestamp: new Date().toISOString(),
        connections: this.connections.size,
      });
    }, this.config.heartbeatInterval!);
  }

  // ── Private: WebSocket Connection ────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const connId = `conn_${randomUUID().slice(0, 8)}`;
    const info: ConnectionInfo = {
      id: connId,
      connectedAt: new Date().toISOString(),
      authenticated: false, // always start unauthenticated; connect handshake required
      subscriptions: new Set(['*']), // auto-subscribe to all events after auth
      lastActivity: Date.now(),
      metadata: {
        userAgent: req.headers['user-agent'],
        origin: req.headers['origin'],
      },
    };

    this.connections.set(connId, { ws, info });

    ws.on('message', async (data) => {
      info.lastActivity = Date.now();
      await this.handleMessage(connId, data.toString());
    });

    ws.on('close', () => {
      this.connections.delete(connId);
      this.rateLimits.delete(connId);
      if (info.authenticated) {
        this.broadcastEvent(GatewayEvents.PRESENCE, {
          type: 'disconnect',
          connectionId: connId,
          timestamp: new Date().toISOString(),
        });
      }
    });

    ws.on('error', () => {
      this.connections.delete(connId);
    });

    // Connection timeout
    const timeout = this.config.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT;
    const timeoutCheck = setInterval(() => {
      if (Date.now() - info.lastActivity > timeout) {
        ws.close(1000, 'Connection timeout');
        clearInterval(timeoutCheck);
      }
    }, 30000);
    ws.on('close', () => clearInterval(timeoutCheck));
  }

  // ── Private: Message Handling ────────────────────────────────────────

  private async handleMessage(connId: string, raw: string): Promise<void> {
    const conn = this.connections.get(connId);
    if (!conn) return;
    const { ws, info } = conn;

    // Parse JSON
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendFrame(ws, { type: 'res', id: '', ok: false, error: { code: RPC_ERROR.PARSE_ERROR, message: 'Invalid JSON' } });
      return;
    }

    // Normalize to a frame: accept both { type:"req", id, method, params } and legacy { id, method, params }
    const frame = this.parseFrame(parsed);
    if (!frame) {
      this.sendFrame(ws, { type: 'res', id: String(parsed.id ?? ''), ok: false, error: { code: RPC_ERROR.INVALID_REQUEST, message: 'Missing id or method' } });
      return;
    }

    // Before handshake, only "connect" is allowed
    if (!info.authenticated) {
      if (frame.method !== 'connect') {
        this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.UNAUTHORIZED, message: 'Handshake required: first message must be connect' } });
        return;
      }
      await this.handleConnect(connId, ws, info, frame);
      return;
    }

    await this.dispatchMethod(connId, ws, info, frame);
  }

  /**
   * Dispatch a parsed RPC frame to its registered method handler.
   *
   * This runs the rate limit check, method lookup, and — critically —
   * enforces each method's `requiresAuth` flag against the connection's
   * per-connection `authenticated` state before invoking the handler.
   * This check is intentionally independent of (and in addition to) the
   * connect-handshake gate in `handleMessage`: it guarantees a method
   * registered with `requiresAuth: true` can never be invoked for an
   * unauthenticated connection even if the handshake gate above is ever
   * relaxed, refactored, or bypassed (e.g. a future public-method
   * allowlist). Rejections use the standard JSON-RPC error frame shape
   * and never invoke the underlying handler.
   */
  private async dispatchMethod(connId: string, ws: WebSocket, info: ConnectionInfo, frame: ParsedFrame): Promise<void> {
    const startedAt = Date.now();
    const dispatchGeneration = this.generation;
    if (!this.isGenerationActive(dispatchGeneration)) return;

    // Rate limit
    if (!this.checkRateLimit(connId)) {
      this.metrics.recordRequest('rate_limited');
      logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'ws', outcome: 'rate_limited', durationMs: Date.now() - startedAt });
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.RATE_LIMITED, message: 'Rate limit exceeded' } });
      return;
    }

    // Find method
    const method = this.methods.get(frame.method);
    if (!method) {
      this.metrics.recordRequest('error');
      logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'ws', outcome: 'error', durationMs: Date.now() - startedAt });
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: `Method '${frame.method}' not found` } });
      return;
    }

    // Enforce per-method auth requirement — fail closed, do not call the handler.
    if (method.requiresAuth && !info.authenticated) {
      this.metrics.recordRequest('auth_failure');
      logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'ws', outcome: 'auth_failure', durationMs: Date.now() - startedAt });
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.UNAUTHORIZED, message: `Method '${frame.method}' requires authentication` } });
      return;
    }

    // Execute. Streaming calls have exactly one terminal streaming frame;
    // they never also receive a normal `type: "res"` frame.
    const wantsStream = frame.params?.stream === true;
    let providerSettled = false;
    let terminalSent = false;
    let streamErrored = false;
    const stream: StreamCallback | undefined = wantsStream
      ? (response) => {
          if (
            providerSettled
            || terminalSent
            || !this.isGenerationActive(dispatchGeneration)
          ) {
            return;
          }
          if (response.error) {
            providerSettled = true;
            terminalSent = true;
            streamErrored = true;
            this.sendFrame(ws, {
              id: frame.id,
              streaming: true,
              done: true,
              error: response.error,
            });
            return;
          }

          // Providers may emit a legacy done marker before their promise
          // resolves. It settles provider output immediately (so late
          // callbacks are ignored), while the dispatcher retains ownership
          // of the one terminal frame containing the actual method result.
          if (response.done) {
            providerSettled = true;
            return;
          }

          this.sendFrame(ws, {
            id: frame.id,
            streaming: true,
            ...(response.chunk !== undefined ? { chunk: response.chunk } : {}),
            ...(response.toolOutput !== undefined ? { toolOutput: response.toolOutput } : {}),
          });
        }
      : undefined;

    try {
      const result = await this.runWithTimeout(method.handler(frame.params ?? {}, info, stream));
      if (!this.isGenerationActive(dispatchGeneration)) return;
      const outcome = streamErrored ? 'error' : 'success';
      this.metrics.recordRequest(outcome);
      logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'ws', outcome, durationMs: Date.now() - startedAt });

      if (wantsStream) {
        if (!terminalSent) {
          providerSettled = true;
          terminalSent = true;
          this.sendFrame(ws, {
            id: frame.id,
            streaming: true,
            done: true,
            result,
            payload: result,
          });
        }
        return;
      }

      this.sendFrame(ws, { type: 'res', id: frame.id, ok: true, payload: result });
    } catch (error) {
      if (
        error instanceof GatewayStoppedError
        || !this.isGenerationActive(dispatchGeneration)
      ) {
        return;
      }
      if (error instanceof GatewayTimeoutError) {
        this.metrics.recordRequest('timeout');
        logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'ws', outcome: 'timeout', durationMs: Date.now() - startedAt });
        if (!terminalSent && wantsStream) {
          providerSettled = true;
          terminalSent = true;
          this.sendFrame(ws, {
            id: frame.id,
            streaming: true,
            done: true,
            error: { code: RPC_ERROR.TIMEOUT, message: error.message },
          });
        } else if (!wantsStream) {
          this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.TIMEOUT, message: error.message } });
        }
        return;
      }
      this.metrics.recordRequest('error');
      logGatewayRequest('gateway', 'rpc.dispatch', { transport: 'ws', outcome: 'error', durationMs: Date.now() - startedAt });
      if (!terminalSent && wantsStream) {
        providerSettled = true;
        terminalSent = true;
        this.sendFrame(ws, {
          id: frame.id,
          streaming: true,
          done: true,
          error: { code: RPC_ERROR.INTERNAL_ERROR, message: (error as Error).message },
        });
      } else if (!wantsStream) {
        this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.INTERNAL_ERROR, message: (error as Error).message } });
      }
    }
  }

  /**
   * Race a method handler's promise against `config.executionTimeoutMs`
   * (disabled by default so existing long-running methods keep working
   * unless a server explicitly opts in). On expiry the returned promise
   * rejects with `GatewayTimeoutError`, which both dispatch paths
   * classify as the `timeout` metric/error rather than a generic error.
   */
  private async runWithTimeout<T>(promise: Promise<T>): Promise<T> {
    const timeoutMs = this.config.executionTimeoutMs;
    if (!timeoutMs) return promise;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GatewayTimeoutError()), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Canonical auth-credential policy — the single source of truth for
   * whether a supplied `{ token, password }` credential satisfies the
   * gateway's configured `auth.mode`. Used by both the WebSocket connect
   * handshake (`handleConnect`) and the HTTP JSON-RPC transport
   * (`resolveHttpAuthenticated`) so neither transport can drift out of
   * sync with the other or accidentally synthesize a passing result.
   *
   * - `mode: 'none'` (default, typical for loopback binds): always valid —
   *   preserves existing trusted-local behavior.
   * - `mode: 'token'`: requires `token` to constant-time-match one of
   *   `config.auth.tokens`.
   * - `mode: 'password'`: requires `password` to constant-time-match
   *   `config.auth.password`.
   */
  private isAuthCredentialValid(credential?: { token?: string; password?: string }): boolean {
    const authMode = this.config.auth?.mode ?? 'none';
    if (authMode === 'none') return true;

    if (authMode === 'token') {
      const token = credential?.token;
      const validTokens = this.config.auth?.tokens ?? [];
      return !!token && validTokens.some((candidate) => safeCompare(candidate, token));
    }

    if (authMode === 'password') {
      const password = credential?.password;
      const expected = this.config.auth?.password;
      return !!password && !!expected && safeCompare(password, expected);
    }

    return false;
  }

  /**
   * Extract an auth credential from an HTTP request: supports the standard
   * `Authorization: Bearer <token-or-password>` header, the
   * `X-Gateway-Token` header (convenience alias), and a JSON-RPC body
   * `auth: { token, password }` field (mirrors the WS connect handshake
   * shape) for callers that cannot set custom headers. Never fabricates a
   * credential — returns `undefined` fields when nothing was supplied.
   */
  private extractHttpAuthCredential(
    req: IncomingMessage,
    body?: Record<string, unknown>
  ): { token?: string; password?: string } {
    let bearer: string | undefined;
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string') {
      const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
      if (match) bearer = match[1].trim();
    }
    if (!bearer) {
      const tokenHeader = req.headers['x-gateway-token'];
      if (typeof tokenHeader === 'string' && tokenHeader.trim()) bearer = tokenHeader.trim();
    }

    const bodyAuth = body?.auth as { token?: string; password?: string } | undefined;
    const authMode = this.config.auth?.mode ?? 'none';

    return {
      token: bodyAuth?.token ?? (authMode === 'token' ? bearer : undefined),
      password: bodyAuth?.password ?? (authMode === 'password' ? bearer : undefined),
    };
  }

  /**
   * Fail-closed HTTP authentication check for JSON-RPC-over-HTTP requests.
   * Mirrors the WS connect handshake's credential policy exactly (via
   * `isAuthCredentialValid`) instead of ever synthesizing `authenticated:
   * true`. Only matters for methods registered with `requiresAuth: true` —
   * public methods remain callable without a credential, same as the WS
   * dispatch path.
   */
  private resolveHttpAuthenticated(req: IncomingMessage, body?: Record<string, unknown>): boolean {
    const credential = this.extractHttpAuthCredential(req, body);
    return this.isAuthCredentialValid(credential);
  }

  /** Parse both new-protocol frames and legacy JSON-RPC */
  private parseFrame(parsed: Record<string, unknown>): ParsedFrame | null {
    const id = typeof parsed.id === 'string' ? parsed.id : typeof parsed.id === 'number' ? String(parsed.id) : null;
    const method = typeof parsed.method === 'string' ? parsed.method : null;
    if (!id || !method) return null;
    return {
      type: 'req',
      id,
      method,
      params: (parsed.params && typeof parsed.params === 'object') ? parsed.params as Record<string, unknown> : undefined,
    };
  }

  /** Handle the connect handshake */
  private async handleConnect(connId: string, ws: WebSocket, info: ConnectionInfo, frame: ParsedFrame): Promise<void> {
    const params = frame.params ?? {};
    const client = params.client as Record<string, unknown> | undefined;

    // Validate minimal connect params
    if (!client || typeof client.id !== 'string' || typeof client.version !== 'string' || typeof client.platform !== 'string' || typeof client.mode !== 'string') {
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.INVALID_REQUEST, message: 'Invalid connect params: client.id, client.version, client.platform, client.mode required' } });
      return;
    }

    // Auth check — delegates to the same fail-closed credential policy used
    // by the HTTP JSON-RPC transport (see `isAuthCredentialValid`) so WS and
    // HTTP callers are held to one canonical auth contract.
    const auth = params.auth as { token?: string; password?: string } | undefined;
    if (!this.isAuthCredentialValid(auth)) {
      const authMode = this.config.auth?.mode ?? 'none';
      const message = authMode === 'password' ? 'Invalid or missing password' : 'Invalid or missing auth token';
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.UNAUTHORIZED, message } });
      return;
    }

    // Handshake succeeded
    info.authenticated = true;
    info.metadata = {
      ...info.metadata,
      clientId: client.id,
      clientVersion: client.version,
      clientPlatform: client.platform,
      clientMode: client.mode,
      clientDisplayName: client.displayName,
    };

    const helloOk = {
      type: 'hello-ok',
      protocol: PROTOCOL_VERSION,
      server: {
        version: VERSION,
        host: 'localhost',
        connId,
      },
      features: {
        methods: Array.from(this.methods.keys()),
        events: Object.values(GatewayEvents),
      },
      policy: {
        maxPayload: 5_000_000,
        maxBufferedBytes: 10_000_000,
        tickIntervalMs: this.config.heartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL,
      },
    };

    this.sendFrame(ws, { type: 'res', id: frame.id, ok: true, payload: helloOk });

    // Broadcast presence
    this.broadcastEvent(GatewayEvents.PRESENCE, {
      type: 'connect',
      connectionId: connId,
      client: client.id,
      timestamp: new Date().toISOString(),
    });
  }

  /** Send a protocol frame */
  private sendFrame(ws: WebSocket, frame: Record<string, unknown>): void {
    try { ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
  }

  private checkRateLimit(connId: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(connId);
    if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(connId, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= RATE_LIMIT_MAX_REQUESTS) return false;
    entry.count++;
    return true;
  }

  // ── Built-in Methods ─────────────────────────────────────────────────

  /**
   * Canonical RPC method registration path.
   *
   * This is the *single* place production method names/handlers/auth
   * requirements are wired for the live GatewayServer — chat/channels/
   * cron/connections/config here operate on this server's real state
   * (`sessionStore`, `channelRegistry`, `cronStore`/`cronService`) and are
   * the authoritative implementations for those names.
   *
   * `typescript/src/gateway/methods/*.ts` (aggregated by
   * `methods/index.ts#registerAllMethods`) are standalone, independently
   * unit-tested RPC method modules. Several of them declare the *same*
   * method names as the ones below (e.g. `chat.list`, `channels.connect`,
   * `cron.*`, `connections.list`, `config.get`/`config.set`) against their
   * own local/disconnected dependencies. `registerAllMethods` is
   * intentionally **not** invoked here: doing so would silently duplicate
   * or override the real, wired handlers below with divergent
   * implementations (the exact failure mode this method's doc-comment
   * exists to prevent). Do not call `registerAllMethods` from
   * `GatewayServer` without first reconciling those overlaps.
   */
  /**
   * Why the assistant can or cannot talk.
   *
   * Held so the UI can render an action instead of a transport error. Kody saw
   * `Copilot CLI failed: Command failed: <entire argv>`; what he needed was
   * "your Copilot sign-in expired — reconnect", with a button.
   */
  private backendStatus: {
    kind: string;
    reason: string;
    remedy?: { title: string; detail: string; action: string };
    model?: string;
    requestedModel?: string;
  } = { kind: 'unknown', reason: 'not yet determined' };

  setBackendStatus(status: {
    kind: string;
    reason: string;
    remedy?: { title: string; detail: string; action: string };
    /** The model that actually answers — PARITY §2.4 requires reporting it. */
    model?: string;
    /** What was asked for. Differs from `model` only when fallback fired. */
    requestedModel?: string;
  }): void {
    this.backendStatus = status;
  }

  private registerBuiltInMethods(): void {
    // Core
    const publicMethods: Array<[string, RpcMethodHandler]> = [
      ['status', async () => this.getStatus()],
      ['health', async () => this.getHealthResponse()],
      ['ping', async () => ({ pong: Date.now() })],
    ];
    this.publicHttpMethods.clear();
    for (const [name, handler] of publicMethods) {
      this.registerMethod(name, handler);
      this.publicHttpMethods.set(name, this.methods.get(name)!);
    }
    this.registerMethod('methods', async () => Array.from(this.methods.keys()));

    // Agents
    this.registerMethod('agents.list', async () => this.agentList ? this.agentList() : []);

    // What the assistant is running on, and what to do when it cannot run.
    this.registerMethod('backend.status', async () => this.backendStatus);

    // Subscribe/unsubscribe
    this.registerMethod('subscribe', async (params: { events: string[] }, conn) => {
      for (const event of params.events) conn.subscriptions.add(event);
      return { subscribed: params.events };
    });
    this.registerMethod('unsubscribe', async (params: { events: string[] }, conn) => {
      for (const event of params.events) conn.subscriptions.delete(event);
      return { unsubscribed: params.events };
    });

    // chat.send — primary chat entry point (openclaw-compatible)
    this.registerMethod(
      'chat.send',
      async (params: { sessionKey?: string; sessionId?: string; message?: string; idempotencyKey?: string }, conn) => {
        const message = params.message?.trim();
        if (!message) throw new Error('message required');
        if (!this.agentHandler) throw new Error('Agent handler not configured');

        const sessionKey = resolveSessionId(params) || `session_${randomUUID().slice(0, 8)}`;
        const runId = `run_${randomUUID().slice(0, 8)}`;
        const run: ActiveRun = {
          runId,
          sessionId: sessionKey,
          aborted: false,
          generation: this.generation,
        };

        // Store user message in session
        const session = this.getOrCreateSession(sessionKey);
        const userMsg: ChatMessage = {
          id: `msg_${randomUUID().slice(0, 8)}`,
          role: 'user',
          content: message,
          timestamp: new Date().toISOString(),
        };
        session.messages.push(userMsg);
        session.updatedAt = new Date().toISOString();
        this.saveSessions();

        // A session has one current run. Superseding it aborts and unindexes
        // the prior run, while each run also has its own runId index so the
        // UI can stop a run without knowing its session.
        const previousRunId = this.activeRunBySession.get(sessionKey);
        const previousRun = previousRunId ? this.activeRunsById.get(previousRunId) : undefined;
        if (previousRun) this.abortActiveRun(previousRun);
        this.activeRunsById.set(runId, run);
        this.activeRunBySession.set(sessionKey, runId);

        const accepted = { runId, sessionKey, sessionId: sessionKey, status: 'accepted' as const, acceptedAt: Date.now() };

        // Execute agent asynchronously — defer to ensure response is sent first
        setTimeout(() => {
          if (run.aborted || !this.isGenerationActive(run.generation)) {
            this.cleanupActiveRun(run);
            return;
          }
          void this.executeAgentWithEvents(run, message, conn.id);
        }, 0);

        return accepted;
      },
      { requiresAuth: true }
    );

    // chat.abort — best-effort cancellation by runId, session alias, or both.
    this.registerMethod(
      'chat.abort',
      async (params: { sessionKey?: string; sessionId?: string; runId?: string }) => {
        const sessionId = resolveSessionId(params);
        const sessionRunId = sessionId ? this.activeRunBySession.get(sessionId) : undefined;
        if (params.runId && sessionRunId && params.runId !== sessionRunId) {
          return { aborted: false, runId: params.runId };
        }

        const runId = params.runId ?? sessionRunId;
        const active = runId ? this.activeRunsById.get(runId) : undefined;
        if (!active || (sessionId && active.sessionId !== sessionId)) {
          return { aborted: false, runId: params.runId };
        }

        this.abortActiveRun(active);
        return { aborted: true, runId: active.runId };
      },
      { requiresAuth: true }
    );

    // Legacy agent method (also works)
    this.registerMethod(
      'agent',
      async (params: AgentRequest & { stream?: boolean }, conn, stream) => {
        if (!this.agentHandler) throw new Error('Agent handler not configured');
        const generation = this.generation;
        const handler = this.agentHandler;
        const forwardStream: StreamCallback | undefined = params.stream && stream
          ? (response) => stream(response)
          : undefined;
        const result = await this.runAgentOperation(
          generation,
          () => handler(params, forwardStream),
        );
        if (!this.isGenerationActive(generation)) throw new GatewayStoppedError();
        this.broadcastEvent(GatewayEvents.AGENT, {
          sessionId: result.sessionId,
          connectionId: conn.id,
          finishReason: result.finishReason,
        });
        return result;
      },
      { requiresAuth: true }
    );

    // Chat session methods
    this.registerMethod('chat.session', async (params: { sessionId?: string; sessionKey?: string; agentId?: string }) => {
      const sessionId = resolveSessionId(params) ?? `session_${randomUUID().slice(0, 8)}`;
      return this.getOrCreateSession(sessionId, params.agentId);
    }, { requiresAuth: true });

    this.registerMethod('chat.list', async () => {
      return Array.from(this.sessionStore.values()).map((s) => ({
        id: s.id, agentId: s.agentId, messageCount: s.messages.length,
        createdAt: s.createdAt, updatedAt: s.updatedAt,
      }));
    });

    this.registerMethod('chat.messages', async (params: { sessionId?: string; sessionKey?: string; limit?: number }) => {
      const sessionId = resolveSessionId(params);
      const session = sessionId ? this.sessionStore.get(sessionId) : undefined;
      if (!session) throw new Error('Session not found');
      let msgs = session.messages;
      if (params.limit) msgs = msgs.slice(-params.limit);
      return msgs;
    });

    this.registerMethod('chat.delete', async (params: { sessionId?: string; sessionKey?: string }) => {
      const sessionId = resolveSessionId(params);
      const runId = sessionId ? this.activeRunBySession.get(sessionId) : undefined;
      const run = runId ? this.activeRunsById.get(runId) : undefined;
      if (run) this.abortActiveRun(run);
      const result = { deleted: !!sessionId && this.sessionStore.delete(sessionId) };
      this.saveSessions();
      return result;
    }, { requiresAuth: true });

    // Channel methods
    this.registerMethod('channels.list', async () => this.channelRegistry ? this.channelRegistry.getStatusList() : []);
    this.registerMethod('channels.send', async (params: SendMessageRequest) => {
      if (!this.channelRegistry) throw new Error('Channel registry not configured');
      await this.channelRegistry.sendMessage(params);
      return { sent: true };
    }, { requiresAuth: true });
    this.registerMethod('channels.connect', async (params: { type: string }) => {
      if (!this.channelRegistry) throw new Error('Channel registry not configured');
      await this.channelRegistry.connectChannel(params.type);
      return { connected: true };
    }, { requiresAuth: true });
    this.registerMethod('channels.disconnect', async (params: { type: string }) => {
      if (!this.channelRegistry) throw new Error('Channel registry not configured');
      await this.channelRegistry.disconnectChannel(params.type);
      return { disconnected: true };
    }, { requiresAuth: true });
    this.registerMethod('channels.probe', async (params: { type: string }) => {
      if (!this.channelRegistry) throw new Error('Channel registry not configured');
      return this.channelRegistry.probeChannel(params.type);
    });
    this.registerMethod('channels.configure', async (params: { type: string; config: Record<string, unknown> }) => {
      if (!this.channelRegistry) throw new Error('Channel registry not configured');
      this.channelRegistry.configureChannel(params.type, params.config);
      // Persist channel tokens in the gateway data directory so they survive restarts
      await this.persistChannelConfig(params.type, params.config);
      return { configured: true };
    }, { requiresAuth: true });
    this.registerMethod('channels.getConfig', async (params: { type: string }) => {
      if (!this.channelRegistry) throw new Error('Channel registry not configured');
      return this.channelRegistry.getChannelConfig(params.type);
    });

    // Cron methods — uses cronService if available, falls back to built-in store
    this.registerMethod('cron.list', async () => {
      if (this.cronService) return this.cronService.list();
      return this.cronStore;
    });
    this.registerMethod('cron.add', this.addCronJob, { requiresAuth: true });
    this.registerMethod('cron.remove', this.removeCronJob, { requiresAuth: true });
    this.registerMethod('cron.run', async (params: { jobId: string }) => {
      if (this.cronService) {
        await this.runCronServiceJob(params.jobId);
        return { triggered: true };
      }
      // Fallback: trigger via agent handler if available
      const job = this.cronStore.find((j) => (j as { id: string }).id === params.jobId) as Record<string, unknown> | undefined;
      if (!job) throw new Error('Job not found');
      if (this.agentHandler) {
        const payload = job.payload as { message?: string } | undefined;
        const message = payload?.message || `Run cron job: ${(job as { name?: string }).name || params.jobId}`;
        // Fire-and-forget so the RPC call returns immediately
        const generation = this.generation;
        const handler = this.agentHandler;
        void this.runAgentOperation(
          generation,
          () => handler({ message, agentId: (job.agentId as string) || undefined }),
        )
          .catch((err) => {
            if (
              !(err instanceof GatewayStoppedError)
              && this.isGenerationActive(generation)
            ) {
              console.error(`Cron job ${params.jobId} failed:`, err);
            }
          });
        return { triggered: true };
      }
      throw new Error('No cron service or agent handler configured');
    }, { requiresAuth: true });
    this.registerMethod('cron.enable', async (params: { jobId: string; enabled: boolean }) => {
      // The live scheduler comes FIRST. This used to find the job in the file
      // store, flip the flag on disk, and return success without ever telling
      // the running scheduler — so "disable" reported done while the job kept
      // firing. Toggling a job that is actively texting someone has to act on
      // the thing that is actually running.
      let applied = false;
      if (this.cronService) {
        const known = this.cronService.list().some((j) => j.id === params.jobId);
        if (known) {
          if (params.enabled) await this.cronService.enable(params.jobId);
          else await this.cronService.disable(params.jobId);
          applied = true;
        }
      }

      const job = this.cronStore.find((j) => (j as { id: string }).id === params.jobId) as Record<string, unknown> | undefined;
      if (job) {
        job.enabled = params.enabled;
        this.saveCronStore();
        applied = true;
      }

      // Reporting success for a job that does not exist is how an empty jobId
      // came back "{ enabled: false }" while the real job kept running.
      if (!applied) throw new Error(`Cron job not found: ${params.jobId || '(empty id)'}`);
      return { enabled: params.enabled };
    }, { requiresAuth: true });

    // ── Cron method aliases (menu bar app uses different names) ──
    // Must share cron.add's implementation, not re-derive it: this alias kept
    // the original file-only bug after cron.add was fixed, so the menu bar could
    // create a job that silently never ran.
    this.registerMethod('cron.create', this.addCronJob, { requiresAuth: true });
    // Same story for delete: this alias filtered the file store and reported
    // success, so the menu bar could "delete" a job that kept firing — and got
    // the same cheerful answer for ids that never existed.
    this.registerMethod('cron.delete', this.removeCronJob, { requiresAuth: true });
    this.registerMethod('cron.trigger', async (params: { jobId: string }) => {
      if (this.cronService) {
        await this.runCronServiceJob(params.jobId);
        return { triggered: true };
      }
      throw new Error('No cron service configured');
    }, { requiresAuth: true });
    this.registerMethod('cron.pause', async (params: { jobId: string }) => {
      if (this.cronService) { await this.cronService.disable(params.jobId); }
      else {
        const job = this.cronStore.find((j) => (j as { id: string }).id === params.jobId) as Record<string, unknown> | undefined;
        if (job) { job.enabled = false; this.saveCronStore(); }
      }
      return { enabled: false };
    }, { requiresAuth: true });
    this.registerMethod('cron.resume', async (params: { jobId: string }) => {
      if (this.cronService) { await this.cronService.enable(params.jobId); }
      else {
        const job = this.cronStore.find((j) => (j as { id: string }).id === params.jobId) as Record<string, unknown> | undefined;
        if (job) { job.enabled = true; this.saveCronStore(); }
      }
      return { enabled: true };
    }, { requiresAuth: true });
    this.registerMethod('cron.get', async (params: { jobId: string }) => {
      const job = this.cronStore.find((j) => (j as { id: string }).id === params.jobId);
      if (!job) throw new Error(`Job not found: ${params.jobId}`);
      return job;
    });
    this.registerMethod('cron.logs', async (params: Record<string, unknown>) => {
      if (this.cronService) {
        const svc = this.cronService as unknown as { getRunLogs?: (jobId?: string) => unknown[] };
        if (svc.getRunLogs) {
          const logs = svc.getRunLogs(params.jobId as string | undefined);
          return { runs: logs };
        }
      }
      return { runs: [] };
    });

    // Connection methods
    this.registerMethod('connections.list', async () => {
      return this.getConnections().map((c) => ({
        id: c.id, connectedAt: c.connectedAt, authenticated: c.authenticated,
        subscriptions: Array.from(c.subscriptions), deviceId: c.deviceId, deviceType: c.deviceType,
      }));
    });
    this.registerMethod('connection.identify', async (params: { deviceId?: string; deviceType?: string; metadata?: Record<string, unknown> }, conn) => {
      conn.deviceId = params.deviceId;
      conn.deviceType = params.deviceType;
      conn.metadata = { ...conn.metadata, ...params.metadata };
      return { identified: true };
    });

    // Config methods
    //
    // Three clients each spoke a different dialect here and none matched the
    // server: the dashboard sends `raw`/`baseHash`, the macOS Bar sends
    // `config`, and this handler read `content`. Every one of them therefore
    // wrote `undefined` and threw ERR_INVALID_ARG_TYPE. `config.apply` was
    // never registered at all.
    //
    // The canonical shape is the dashboard's (`raw` + a hash for optimistic
    // concurrency). The older field names are accepted as aliases so a Bar
    // built before this change keeps working, and `content` is echoed back on
    // read for the same reason.
    this.registerMethod('config.get', async () => {
      const raw = this.loadConfig();
      return { raw, hash: this.configHash(raw), format: 'yaml', content: raw };
    });

    const writeConfig = async (params: ConfigWriteParams) => {
      const raw = params.raw ?? params.content ?? params.config;
      if (typeof raw !== 'string') {
        throw new Error('config.set requires a string `raw` (or legacy `content`/`config`)');
      }
      // A baseHash that no longer matches means someone else wrote after this
      // client read. Overwriting would silently discard their edit.
      if (params.baseHash) {
        const currentHash = this.configHash(this.loadConfig());
        if (params.baseHash !== currentHash) {
          throw new Error(
            'Config changed since it was loaded; reload before saving to avoid discarding the other edit',
          );
        }
      }
      this.saveConfig(raw);
      return { saved: true, applied: true, hash: this.configHash(raw) };
    };

    this.registerMethod('config.set', writeConfig, { requiresAuth: true });
    this.registerMethod('config.apply', writeConfig, { requiresAuth: true });

    // Showcase methods
    registerShowcaseMethods(this);

    if (this.surgeonService) {
      registerSurgeonMethods(this, this.surgeonService);
    }

    // Auth profile methods (device-code login, switch, remove)
    registerAuthMethods(this, {
      onAuthTokenUpdate: (token: string | null) => this.onAuthTokenUpdate?.(token),
      dataDir: this.dataDir,
    });

    // Backup & restore methods
    registerBackupMethods(this, { dataDir: this.dataDir });

    // Rappter multi-soul methods
    if (this.rappterManager) {
      registerRappterMethods(this, { rappterManager: this.rappterManager });
    }
  }

  // ── Agent Execution with Chat Events ─────────────────────────────────

  private cleanupActiveRun(run: ActiveRun): void {
    if (this.activeRunsById.get(run.runId) === run) {
      this.activeRunsById.delete(run.runId);
    }
    if (this.activeRunBySession.get(run.sessionId) === run.runId) {
      this.activeRunBySession.delete(run.sessionId);
    }
  }

  private abortActiveRun(run: ActiveRun, broadcast = true): void {
    if (run.aborted) return;
    run.aborted = true;
    this.cleanupActiveRun(run);
    if (broadcast && this.isGenerationActive(run.generation)) {
      this.broadcastEvent(GatewayEvents.CHAT, {
        runId: run.runId,
        sessionKey: run.sessionId,
        sessionId: run.sessionId,
        state: 'aborted',
      });
    }
  }

  private async executeAgentWithEvents(run: ActiveRun, message: string, _connId: string): Promise<void> {
    if (
      !this.agentHandler
      || run.aborted
      || !this.isGenerationActive(run.generation)
    ) {
      this.cleanupActiveRun(run);
      return;
    }

    const handler = this.agentHandler;
    try {
      const result = await this.runAgentOperation(
        run.generation,
        () => handler({ message, sessionId: run.sessionId }),
      );

      if (run.aborted || !this.isGenerationActive(run.generation)) return;

      // Send final response only (no streaming deltas — avoids duplication from multi-turn tool-call loops)
      const raw = result.content || '';
      const { text: finalText, voiceText } = parseVoiceDelimiter(raw);
      // Forward modality senses (|||HOLO|||, …) so surfaces like the Voice UI
      // can render a creature/visual from the same reply.
      const allSenses = parseSenses(raw).senses;
      this.broadcastEvent(GatewayEvents.CHAT, {
        runId: run.runId,
        sessionKey: run.sessionId,
        sessionId: run.sessionId,
        state: 'final',
        message: finalText ? { role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now() } : undefined,
        voiceText: voiceText || undefined,
        holo: allSenses.holo || undefined,
        senses: Object.keys(allSenses).length ? allSenses : undefined,
      });

      // Store assistant message
      const session = this.sessionStore.get(run.sessionId);
      if (session) {
        session.messages.push({
          id: `msg_${randomUUID().slice(0, 8)}`,
          role: 'assistant',
          content: finalText,
          timestamp: new Date().toISOString(),
        });
        session.updatedAt = new Date().toISOString();
        this.saveSessions();
      }
    } catch (error) {
      if (
        run.aborted
        || error instanceof GatewayStoppedError
        || !this.isGenerationActive(run.generation)
      ) {
        return;
      }
      this.broadcastEvent(GatewayEvents.CHAT, {
        runId: run.runId,
        sessionKey: run.sessionId,
        sessionId: run.sessionId,
        state: 'error',
        errorMessage: (error as Error).message,
      });
    } finally {
      this.cleanupActiveRun(run);
    }
  }

  /** Map channel config keys to env var names */
  private static readonly CHANNEL_ENV_MAP: Record<string, Record<string, string>> = {
    telegram: { token: 'TELEGRAM_BOT_TOKEN' },
    discord: { botToken: 'DISCORD_BOT_TOKEN' },
    slack: { botToken: 'SLACK_BOT_TOKEN', appToken: 'SLACK_APP_TOKEN' },
    whatsapp: { token: 'WHATSAPP_TOKEN' },
  };

  /** Persist channel config values to the gateway data directory's .env file. */
  private async persistChannelConfig(channelType: string, config: Record<string, unknown>): Promise<void> {
    const mapping = GatewayServer.CHANNEL_ENV_MAP[channelType];
    if (!mapping) return;

    const envFile = path.join(this.dataDir, '.env');
    const existing: Record<string, string> = {};

    // Read existing env file
    try {
      const data = await fs.promises.readFile(envFile, 'utf-8');
      for (const line of data.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          existing[key] = val;
        }
      }
    } catch { /* file doesn't exist yet */ }

    // Update with new values
    let changed = false;
    for (const [configKey, envKey] of Object.entries(mapping)) {
      const val = config[configKey];
      if (typeof val === 'string' && val) {
        existing[envKey] = val;
        process.env[envKey] = val;
        changed = true;
      }
    }

    if (!changed) return;

    // Write back
    await fs.promises.mkdir(path.dirname(envFile), { recursive: true });
    const lines = ['# openrappter environment — managed by openrappter', ''];
    for (const [key, val] of Object.entries(existing)) {
      lines.push(`${key}="${val}"`);
    }
    lines.push('');
    await fs.promises.writeFile(envFile, lines.join('\n'));
  }

  private getOrCreateSession(sessionId: string, agentId?: string): ChatSession {
    let session = this.sessionStore.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        agentId: agentId ?? 'default',
        messages: [],
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.sessionStore.set(sessionId, session);
      this.saveSessions();
    }
    return session;
  }
}

export function createGatewayServer(config?: Partial<GatewayConfig>): GatewayServer {
  return new GatewayServer(config);
}
