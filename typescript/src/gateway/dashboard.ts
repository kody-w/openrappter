/**
 * Dashboard REST API — HTTP endpoints for the web dashboard.
 *
 * Provides REST endpoints for agent management, execution, tracing,
 * and chain/graph status. Designed to be mounted on the existing
 * GatewayServer's HTTP handler.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { BasicAgent } from '../agents/BasicAgent.js';
import type { AgentResult } from '../agents/types.js';

// ── Types ────────────────────────────────────────────────────────────

export interface DashboardAgent {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DashboardExecuteRequest {
  agentName: string;
  kwargs: Record<string, unknown>;
}

export interface DashboardExecuteResponse {
  status: 'success' | 'error';
  agentName: string;
  result: AgentResult | null;
  durationMs: number;
  error?: string;
}

export interface DashboardTraceEntry {
  id: string;
  agentName: string;
  operation: string;
  status: string;
  durationMs: number | null;
  startTime: string;
  endTime: string | null;
}

export interface DashboardOptions {
  /** URL prefix for all dashboard routes (default: '/api') */
  prefix?: string;
  /** Enable CORS headers (default: true) */
  cors?: boolean;
  /**
   * Hostnames or authorities accepted by this handler. A hostname entry
   * permits any port; include a port to require it exactly.
   */
  trustedHosts?: string[];
  /** Additional exact browser origins allowed to call read-only routes. */
  trustedOrigins?: string[];
  /** Bearer/X-Gateway-Token credential accepted by privileged routes. */
  authToken?: string;
  /** Mount-provided authorization hook for privileged routes. */
  authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;
}

interface TrustedHost {
  hostname: string;
  port?: string;
}

interface DashboardRequestSource {
  origin?: string;
  localSameOrigin: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const DEFAULT_TRUSTED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '');
}

function parseTrustedHost(value: string): TrustedHost {
  if (!value || value !== value.trim() || value.includes('://')) {
    throw new Error(`Invalid trusted dashboard host: ${value}`);
  }
  const authority = value === '::1' ? '[::1]' : value;
  let parsed: URL;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw new Error(`Invalid trusted dashboard host: ${value}`);
  }
  if (
    parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`Invalid trusted dashboard host: ${value}`);
  }
  return { hostname: normalizeHostname(parsed.hostname), port: parsed.port || undefined };
}

function parseTrustedOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid trusted dashboard origin: ${value}`);
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`Invalid trusted dashboard origin: ${value}`);
  }
  return parsed.origin;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === '::1'
    || normalized === '127.0.0.1'
    || normalized.startsWith('127.')
    || normalized.startsWith('::ffff:127.');
}

function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

export class DashboardHandler {
  private agents = new Map<string, BasicAgent>();
  private traceStore: DashboardTraceEntry[] = [];
  private maxTraceEntries: number = 500;
  private prefix: string;
  private corsEnabled: boolean;
  private trustedHosts: TrustedHost[];
  private trustedOrigins: Set<string>;
  private authToken?: string;
  private authorize?: (req: IncomingMessage) => boolean | Promise<boolean>;

  constructor(options?: DashboardOptions) {
    this.prefix = options?.prefix ?? '/api';
    this.corsEnabled = options?.cors ?? true;
    this.trustedHosts = (options?.trustedHosts ?? DEFAULT_TRUSTED_HOSTS).map(parseTrustedHost);
    this.trustedOrigins = new Set((options?.trustedOrigins ?? []).map(parseTrustedOrigin));
    this.authToken = options?.authToken;
    this.authorize = options?.authorize;
  }

  /** Register an agent for the dashboard */
  registerAgent(agent: BasicAgent): void {
    this.agents.set(agent.name, agent);
  }

  /** Register multiple agents */
  registerAgents(agents: BasicAgent[]): void {
    for (const agent of agents) {
      this.registerAgent(agent);
    }
  }

  /** Add a trace entry */
  addTrace(entry: DashboardTraceEntry): void {
    this.traceStore.push(entry);
    if (this.traceStore.length > this.maxTraceEntries) {
      this.traceStore = this.traceStore.slice(-this.maxTraceEntries);
    }
  }

  /** Get all trace entries */
  getTraces(limit?: number): DashboardTraceEntry[] {
    if (limit) {
      return this.traceStore.slice(-limit);
    }
    return [...this.traceStore];
  }

  /** Clear trace entries */
  clearTraces(): void {
    this.traceStore = [];
  }

  /**
   * Handle an HTTP request. Returns true if the request was handled,
   * false if it should be passed to the next handler.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://dashboard.invalid');
    const pathname = url.pathname;

    // Only handle requests under our prefix
    if (pathname !== this.prefix && !pathname.startsWith(`${this.prefix}/`)) {
      return false;
    }

    const source = this.validateRequestSource(req);
    if (!source) {
      this.sendJson(res, 403, { error: 'Forbidden request origin' });
      return true;
    }

    // CORS headers
    if (this.corsEnabled) {
      if (source.origin) {
        res.setHeader('Access-Control-Allow-Origin', source.origin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Gateway-Token');
      res.setHeader('Vary', 'Origin');

      if (req.method === 'OPTIONS') {
        if (!source.origin) {
          this.sendJson(res, 403, { error: 'CORS preflight requires a trusted origin' });
          return true;
        }
        res.writeHead(204);
        res.end();
        return true;
      }
    }

    const route = pathname.slice(this.prefix.length);

    try {
      switch (true) {
        case route === '/agents' && req.method === 'GET':
          return this.handleAgentList(res);

        case route === '/agents/execute' && req.method === 'POST':
          if (!(await this.isPrivilegedRequestAuthorized(req, source))) {
            this.sendJson(res, 401, { error: 'Authorization required' });
            return true;
          }
          return await this.handleAgentExecute(req, res);

        case route === '/traces' && req.method === 'GET': {
          const limitParam = url.searchParams.get('limit');
          const limit = limitParam ? parseInt(limitParam, 10) : undefined;
          return this.handleTraceList(res, limit);
        }

        case route === '/traces' && req.method === 'DELETE':
          return this.handleTraceClear(res);

        case route === '/status' && req.method === 'GET':
          return this.handleStatus(res);

        default:
          this.sendJson(res, 404, { error: 'Not found', path: route });
          return true;
      }
    } catch (e) {
      const error = e as Error;
      this.sendJson(res, 500, { error: error.message });
      return true;
    }
  }

  private validateRequestSource(req: IncomingMessage): DashboardRequestSource | null {
    const host = req.headers.host;
    if (!host || host !== host.trim() || host.length > 255) return null;

    let authority: URL;
    try {
      authority = new URL(`http://${host}`);
    } catch {
      return null;
    }
    if (authority.username || authority.password || authority.pathname !== '/') {
      return null;
    }
    if (authority.search || authority.hash) return null;

    const hostname = normalizeHostname(authority.hostname);
    const trustedHost = this.trustedHosts.some((candidate) => (
      candidate.hostname === hostname
      && (candidate.port === undefined || candidate.port === authority.port)
    ));
    if (!trustedHost) return null;

    const header = req.headers.origin;
    if (header === undefined) return { localSameOrigin: false };
    if (Array.isArray(header)) return null;

    try {
      const origin = new URL(header);
      const expectedProtocol = (req.socket as (typeof req.socket & { encrypted?: boolean }) | undefined)?.encrypted
        ? 'https:'
        : 'http:';
      const requestOrigin = new URL(`${expectedProtocol}//${authority.host}`).origin;
      const sameOrigin = origin.origin === requestOrigin;
      if (
        !['http:', 'https:'].includes(origin.protocol)
        || origin.username
        || origin.password
        || origin.pathname !== '/'
        || origin.search
        || origin.hash
        || (!sameOrigin && !this.trustedOrigins.has(origin.origin))
      ) {
        return null;
      }
      return {
        origin: origin.origin,
        localSameOrigin: sameOrigin
          && LOCAL_HOSTS.has(hostname)
          && isLoopbackAddress(req.socket?.remoteAddress),
      };
    } catch {
      return null;
    }
  }

  private async isPrivilegedRequestAuthorized(
    req: IncomingMessage,
    source: DashboardRequestSource,
  ): Promise<boolean> {
    if (source.localSameOrigin) return true;

    if (this.authorize) {
      try {
        if (await this.authorize(req)) return true;
      } catch {
        return false;
      }
    }

    if (!this.authToken) return false;
    const authorization = req.headers.authorization;
    const bearer = typeof authorization === 'string'
      ? authorization.match(/^Bearer ([^\s,]+)$/i)?.[1]
      : undefined;
    const gatewayTokenHeader = req.headers['x-gateway-token'];
    const gatewayToken = typeof gatewayTokenHeader === 'string'
      ? gatewayTokenHeader
      : undefined;
    const presented = bearer ?? gatewayToken;
    return presented !== undefined && safeEqual(presented, this.authToken);
  }

  private handleAgentList(res: ServerResponse): boolean {
    const agents: DashboardAgent[] = [];
    for (const agent of this.agents.values()) {
      agents.push({
        name: agent.metadata.name,
        description: agent.metadata.description,
        parameters: agent.metadata.parameters as unknown as Record<string, unknown>,
      });
    }
    this.sendJson(res, 200, { agents, count: agents.length });
    return true;
  }

  private async handleAgentExecute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const body = await this.readBody(req);
    if (!body) {
      this.sendJson(res, 400, { error: 'Request body required' });
      return true;
    }

    let parsed: DashboardExecuteRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }

    if (!parsed.agentName) {
      this.sendJson(res, 400, { error: 'agentName is required' });
      return true;
    }

    const agent = this.agents.get(parsed.agentName);
    if (!agent) {
      this.sendJson(res, 404, { error: `Agent not found: ${parsed.agentName}` });
      return true;
    }

    const startTime = Date.now();
    const traceId = `trace_${Date.now().toString(36)}`;

    try {
      const resultStr = await agent.execute(parsed.kwargs ?? {});
      const durationMs = Date.now() - startTime;
      let result: AgentResult;
      try {
        result = JSON.parse(resultStr);
      } catch {
        result = { status: 'success', raw: resultStr } as unknown as AgentResult;
      }

      // Record trace
      this.addTrace({
        id: traceId,
        agentName: parsed.agentName,
        operation: 'execute',
        status: 'success',
        durationMs,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
      });

      const response: DashboardExecuteResponse = {
        status: 'success',
        agentName: parsed.agentName,
        result,
        durationMs,
      };
      this.sendJson(res, 200, response);
    } catch (e) {
      const error = e as Error;
      const durationMs = Date.now() - startTime;

      this.addTrace({
        id: traceId,
        agentName: parsed.agentName,
        operation: 'execute',
        status: 'error',
        durationMs,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
      });

      const response: DashboardExecuteResponse = {
        status: 'error',
        agentName: parsed.agentName,
        result: null,
        durationMs,
        error: error.message,
      };
      this.sendJson(res, 200, response);
    }

    return true;
  }

  private handleTraceList(res: ServerResponse, limit?: number): boolean {
    const traces = this.getTraces(limit);
    this.sendJson(res, 200, { traces, count: traces.length });
    return true;
  }

  private handleTraceClear(res: ServerResponse): boolean {
    this.clearTraces();
    this.sendJson(res, 200, { cleared: true });
    return true;
  }

  private handleStatus(res: ServerResponse): boolean {
    this.sendJson(res, 200, {
      agentCount: this.agents.size,
      traceCount: this.traceStore.length,
      agents: Array.from(this.agents.keys()),
    });
    return true;
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf-8'));
      });
      req.on('error', () => resolve(null));
    });
  }

  /** Get agent count */
  get agentCount(): number {
    return this.agents.size;
  }

  /** Check if an agent is registered */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }
}

export function createDashboardHandler(options?: DashboardOptions): DashboardHandler {
  return new DashboardHandler(options);
}
