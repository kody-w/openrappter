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
import type { RappterManager } from './rappter-manager.js';
import { VERSION } from '../version.js';
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
  private onAuthTokenUpdate?: (token: string) => void;

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
    list(): { id: string; name: string; schedule: string; enabled: boolean }[];
    run(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    getRunLogs?(jobId?: string): unknown[];
  };
  private agentList?: () => { id: string; type: string; description?: string; capabilities?: string[]; tools?: { name: string; description?: string }[]; channels?: { type: string; connected: boolean }[] }[];
  private cronStore: Record<string, unknown>[] = [];

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
  setAuthTokenCallback(cb: (token: string) => void): void {
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
    list(): { id: string; name: string; schedule: string; enabled: boolean }[];
    run(id: string): Promise<void>;
    enable(id: string): Promise<void>;
    disable(id: string): Promise<void>;
    getRunLogs?(jobId?: string): unknown[];
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
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
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
          if (req.url === '/chat') {
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
            const rawMessage = typeof parsed.message === 'string'
              ? parsed.message
              : parsed.user_input;
            const message = typeof rawMessage === 'string' ? rawMessage.trim() : '';
            if (!message) {
              res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
              res.end(JSON.stringify({
                schema: 'rapp-chat/1.0',
                status: 'error',
                error: 'message is required',
              }));
              return;
            }
            const sessionId = (
              typeof parsed.session_id === 'string'
                ? parsed.session_id
                : typeof parsed.sessionId === 'string'
                  ? parsed.sessionId
                  : randomUUID()
            );
            const idempotencyKey = (
              typeof parsed.idempotency_key === 'string'
                ? parsed.idempotency_key
                : typeof parsed.idempotencyKey === 'string'
                  ? parsed.idempotencyKey
                  : undefined
            );
            const historyValue = Array.isArray(parsed.conversation_history)
              ? parsed.conversation_history
              : Array.isArray(parsed.history)
                ? parsed.history
                : undefined;
            const conversationHistory = historyValue?.filter(
              (entry: unknown): entry is { role: 'user' | 'assistant'; content: string } => {
                if (!entry || typeof entry !== 'object') return false;
                const item = entry as Record<string, unknown>;
                return (
                  (item.role === 'user' || item.role === 'assistant')
                  && typeof item.content === 'string'
                );
              }
            ).map((entry: { role: 'user' | 'assistant'; content: string }) => ({
              role: entry.role,
              content: entry.content,
            }));
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
              return {
                schema: 'rapp-chat/1.0',
                status: 'success',
                response: result.content,
                content: result.content,
                session_id: result.sessionId,
                sessionId: result.sessionId,
                agent_logs: result.agentLogs?.join('\n')
                  ?? (result.toolCalls ? JSON.stringify(result.toolCalls) : ''),
                ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
              };
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
            // Plain chat message (backwards compatible) — not an RPC dispatch, not counted in metrics
            const chatMsg = parsed.message || parsed.query || body;
            const status = this.getStatus();
            res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
            res.end(JSON.stringify({ response: `Received: ${chatMsg}`, status }));
          }
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
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
    // Same-machine (loopback) callers — e.g. the local Voice UI served at /vui —
    // are trusted; the gateway binds to localhost only.
    const ra = req.socket?.remoteAddress || '';
    if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return true;
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
    this.registerMethod('cron.add', async (params: Record<string, unknown>) => {
      const job = { id: `cron_${randomUUID().slice(0, 8)}`, ...params };
      this.cronStore.push(job);
      this.saveCronStore();
      return job;
    }, { requiresAuth: true });
    this.registerMethod('cron.remove', async (params: { jobId: string }) => {
      this.cronStore = this.cronStore.filter((j) => (j as { id: string }).id !== params.jobId);
      this.saveCronStore();
      return { removed: true };
    }, { requiresAuth: true });
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
      // Update in built-in store
      const job = this.cronStore.find((j) => (j as { id: string }).id === params.jobId) as Record<string, unknown> | undefined;
      if (job) {
        job.enabled = params.enabled;
        this.saveCronStore();
        return { enabled: params.enabled };
      }
      if (!this.cronService) throw new Error('Cron service not configured');
      if (params.enabled) await this.cronService.enable(params.jobId);
      else await this.cronService.disable(params.jobId);
      return { enabled: params.enabled };
    }, { requiresAuth: true });

    // ── Cron method aliases (menu bar app uses different names) ──
    this.registerMethod('cron.create', async (params: Record<string, unknown>) => {
      const job = { id: `cron_${randomUUID().slice(0, 8)}`, ...params };
      this.cronStore.push(job);
      this.saveCronStore();
      return job;
    }, { requiresAuth: true });
    this.registerMethod('cron.delete', async (params: { jobId: string }) => {
      this.cronStore = this.cronStore.filter((j) => (j as { id: string }).id !== params.jobId);
      this.saveCronStore();
      return { removed: true };
    }, { requiresAuth: true });
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
    this.registerMethod('config.get', async () => {
      return { content: this.loadConfig() };
    });
    this.registerMethod('config.set', async (params: { content: string }) => {
      this.saveConfig(params.content);
      return { saved: true };
    }, { requiresAuth: true });

    // Showcase methods
    registerShowcaseMethods(this);

    // Auth profile methods (device-code login, switch, remove)
    registerAuthMethods(this, {
      onAuthTokenUpdate: (token: string) => this.onAuthTokenUpdate?.(token),
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
