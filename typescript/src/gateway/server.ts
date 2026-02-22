/**
 * WebSocket Gateway Server
 * openclaw-compatible protocol: connect handshake, frame-based messaging,
 * chat.send → agent wiring, event broadcasting
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
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

const DEFAULT_PORT = 18790;
const DEFAULT_HEARTBEAT_INTERVAL = 30000;
const DEFAULT_CONNECTION_TIMEOUT = 120000;
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 100;
const VERSION = '1.9.0';
const PROTOCOL_VERSION = 3;

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

type StreamCallback = (response: StreamingResponse) => void;

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
  private rateLimits = new Map<string, RateLimitEntry>();
  private config: GatewayConfig;
  private startedAt: number | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  // External handlers
  private agentHandler?: (
    request: AgentRequest,
    stream?: StreamCallback
  ) => Promise<AgentResponse>;
  private sessionStore = new Map<string, ChatSession>();
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
    };
    this.loadSessions();
    this.loadCronStore();
  }

  /* ---- persistence ---- */

  private get dataDir(): string {
    const dir = path.join(os.homedir(), '.openrappter');
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

  setAgentHandler(
    handler: (request: AgentRequest, stream?: StreamCallback) => Promise<AgentResponse>
  ): void {
    this.agentHandler = handler;
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
  }): void {
    this.cronService = service;
  }

  setAgentList(listFn: () => { id: string; type: string; description?: string; capabilities?: string[]; tools?: { name: string; description?: string }[]; channels?: { type: string; connected: boolean }[] }[]): void {
    this.agentList = listFn;
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
    if (this.wss) return;

    const host = this.config.bind === 'loopback' ? '127.0.0.1' : '0.0.0.0';

    this.httpServer = createServer((req, res) => this.handleHttpRequest(req, res));

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.startedAt = Date.now();

    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    this.wss.on('error', (error) => console.error('Gateway server error:', error));

    this.registerBuiltInMethods();
    this.startHeartbeat();

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(this.config.port, host, () => resolve());
      this.httpServer!.on('error', reject);
    });

    console.log(`Gateway server started on ${host}:${this.config.port}`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    this.broadcastEvent(GatewayEvents.SHUTDOWN, { reason: 'Server shutting down' });

    for (const { ws } of this.connections.values()) {
      ws.close(1000, 'Server shutting down');
    }
    this.connections.clear();

    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }

    this.startedAt = null;
  }

  getStatus(): GatewayStatus {
    return {
      running: !!this.wss,
      port: this.config.port,
      connections: this.connections.size,
      uptime: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      version: VERSION,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : '',
    };
  }

  /** Broadcast an event to all authenticated connections (type: "event" frame) */
  broadcastEvent(event: string, payload: unknown, filter?: (conn: ConnectionInfo) => boolean): void {
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

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.url === '/health' && req.method === 'GET') {
      const health = this.getHealthResponse();
      res.writeHead(health.status === 'ok' ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }
    if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.getStatus()));
      return;
    }

    // Static file serving when webRoot is configured
    if (this.config.webRoot) {
      this.serveStaticFile(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
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
      },
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

    // Rate limit
    if (!this.checkRateLimit(connId)) {
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.RATE_LIMITED, message: 'Rate limit exceeded' } });
      return;
    }

    // Find method
    const method = this.methods.get(frame.method);
    if (!method) {
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.METHOD_NOT_FOUND, message: `Method '${frame.method}' not found` } });
      return;
    }

    // Execute
    try {
      const result = await method.handler(frame.params ?? {}, info);
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: true, payload: result });
    } catch (error) {
      this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.INTERNAL_ERROR, message: (error as Error).message } });
    }
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

    // Auth check
    const authMode = this.config.auth?.mode ?? 'none';
    if (authMode === 'token') {
      const auth = params.auth as { token?: string } | undefined;
      const token = auth?.token;
      if (!token || !this.config.auth?.tokens?.includes(token)) {
        this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.UNAUTHORIZED, message: 'Invalid or missing auth token' } });
        return;
      }
    } else if (authMode === 'password') {
      const auth = params.auth as { password?: string } | undefined;
      if (!auth?.password || auth.password !== this.config.auth?.password) {
        this.sendFrame(ws, { type: 'res', id: frame.id, ok: false, error: { code: RPC_ERROR.UNAUTHORIZED, message: 'Invalid or missing password' } });
        return;
      }
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

  private registerBuiltInMethods(): void {
    // Core
    this.registerMethod('status', async () => this.getStatus());
    this.registerMethod('health', async () => this.getHealthResponse());
    this.registerMethod('ping', async () => ({ pong: Date.now() }));
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
      async (params: { sessionKey?: string; message?: string; idempotencyKey?: string }, conn) => {
        const message = params.message?.trim();
        if (!message) throw new Error('message required');
        if (!this.agentHandler) throw new Error('Agent handler not configured');

        const sessionKey = params.sessionKey || `session_${randomUUID().slice(0, 8)}`;
        const runId = `run_${randomUUID().slice(0, 8)}`;

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

        // Respond immediately with acceptance
        const accepted = { runId, sessionKey, status: 'accepted' as const, acceptedAt: Date.now() };

        // Execute agent asynchronously — defer to ensure response is sent first
        setTimeout(() => {
          void this.executeAgentWithEvents(sessionKey, runId, message, conn.id);
        }, 0);

        return accepted;
      },
      { requiresAuth: true }
    );

    // Legacy agent method (also works)
    this.registerMethod(
      'agent',
      async (params: AgentRequest & { stream?: boolean }, conn) => {
        if (!this.agentHandler) throw new Error('Agent handler not configured');
        const result = await this.agentHandler(params);
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
    this.registerMethod('chat.session', async (params: { sessionId?: string; agentId?: string }) => {
      const sessionId = params.sessionId ?? `session_${randomUUID().slice(0, 8)}`;
      return this.getOrCreateSession(sessionId, params.agentId);
    }, { requiresAuth: true });

    this.registerMethod('chat.list', async () => {
      return Array.from(this.sessionStore.values()).map((s) => ({
        id: s.id, agentId: s.agentId, messageCount: s.messages.length,
        createdAt: s.createdAt, updatedAt: s.updatedAt,
      }));
    });

    this.registerMethod('chat.messages', async (params: { sessionId: string; limit?: number }) => {
      const session = this.sessionStore.get(params.sessionId);
      if (!session) throw new Error('Session not found');
      let msgs = session.messages;
      if (params.limit) msgs = msgs.slice(-params.limit);
      return msgs;
    });

    this.registerMethod('chat.delete', async (params: { sessionId: string }) => {
      const result = { deleted: this.sessionStore.delete(params.sessionId) };
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
      // Persist channel tokens to ~/.openrappter/.env so they survive restarts
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
        await this.cronService.run(params.jobId);
        return { triggered: true };
      }
      // Fallback: trigger via agent handler if available
      const job = this.cronStore.find((j) => (j as { id: string }).id === params.jobId) as Record<string, unknown> | undefined;
      if (!job) throw new Error('Job not found');
      if (this.agentHandler) {
        const payload = job.payload as { message?: string } | undefined;
        const message = payload?.message || `Run cron job: ${(job as { name?: string }).name || params.jobId}`;
        // Fire-and-forget so the RPC call returns immediately
        this.agentHandler({ message, agentId: (job.agentId as string) || undefined }).catch((err) => {
          console.error(`Cron job ${params.jobId} failed:`, err);
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
  }

  // ── Agent Execution with Chat Events ─────────────────────────────────

  private async executeAgentWithEvents(sessionKey: string, runId: string, message: string, _connId: string): Promise<void> {
    if (!this.agentHandler) return;

    try {
      const result = await this.agentHandler(
        { message, sessionId: sessionKey },
      );

      // Send final response only (no streaming deltas — avoids duplication from multi-turn tool-call loops)
      const finalText = result.content || '';
      this.broadcastEvent(GatewayEvents.CHAT, {
        runId, sessionKey,
        state: 'final',
        message: finalText ? { role: 'assistant', content: [{ type: 'text', text: finalText }], timestamp: Date.now() } : undefined,
      });

      // Store assistant message
      const session = this.sessionStore.get(sessionKey);
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
      this.broadcastEvent(GatewayEvents.CHAT, {
        runId, sessionKey,
        state: 'error',
        errorMessage: (error as Error).message,
      });
    }
  }

  /** Map channel config keys to env var names */
  private static readonly CHANNEL_ENV_MAP: Record<string, Record<string, string>> = {
    telegram: { token: 'TELEGRAM_BOT_TOKEN' },
    discord: { botToken: 'DISCORD_BOT_TOKEN' },
    slack: { botToken: 'SLACK_BOT_TOKEN', appToken: 'SLACK_APP_TOKEN' },
    whatsapp: { token: 'WHATSAPP_TOKEN' },
  };

  /** Persist channel config values to ~/.openrappter/.env */
  private async persistChannelConfig(channelType: string, config: Record<string, unknown>): Promise<void> {
    const mapping = GatewayServer.CHANNEL_ENV_MAP[channelType];
    if (!mapping) return;

    const envFile = path.join(os.homedir(), '.openrappter', '.env');
    const existing: Record<string, string> = {};

    // Read existing env file
    try {
      const data = await fs.promises.readFile(envFile, 'utf-8');
      for (const line of data.split('\n')) {
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
