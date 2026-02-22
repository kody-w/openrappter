/**
 * Dashboard API Parity Tests
 *
 * Tests the REST API endpoints for the web dashboard.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DashboardHandler, createDashboardHandler } from '../../gateway/dashboard.js';
import { BasicAgent } from '../../agents/BasicAgent.js';
import type { AgentMetadata } from '../../agents/types.js';
import type { IncomingMessage, ServerResponse } from 'http';
import { EventEmitter } from 'events';

// ── Test helpers ──

class EchoAgent extends BasicAgent {
  constructor(name = 'Echo') {
    const metadata: AgentMetadata = {
      name,
      description: 'Echoes input for testing',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Input' } },
        required: [],
      },
    };
    super(name, metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({ status: 'success', echo: kwargs.query ?? 'no-query' });
  }
}

class FailAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Fail',
      description: 'Always fails',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('Fail', metadata);
  }

  async perform(): Promise<string> {
    throw new Error('Intentional failure');
  }
}

// Mock HTTP request/response
function createMockReq(method: string, url: string, body?: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = { host: 'localhost:18790' };

  // Simulate body
  if (body !== undefined) {
    setTimeout(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    }, 0);
  } else {
    setTimeout(() => req.emit('end'), 0);
  }

  return req;
}

function createMockRes(): ServerResponse & { _statusCode: number; _headers: Record<string, string>; _body: string } {
  const res = {
    _statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: '',
    writeHead(statusCode: number, headers?: Record<string, string>) {
      res._statusCode = statusCode;
      if (headers) Object.assign(res._headers, headers);
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
      return res;
    },
    end(data?: string) {
      if (data) res._body = data;
    },
  } as unknown as ServerResponse & { _statusCode: number; _headers: Record<string, string>; _body: string };
  return res;
}

describe('DashboardHandler', () => {
  let handler: DashboardHandler;

  beforeEach(() => {
    handler = new DashboardHandler();
    handler.registerAgents([new EchoAgent(), new EchoAgent('Echo2')]);
  });

  // ── Construction ──

  describe('Construction', () => {
    it('should create with defaults', () => {
      const h = new DashboardHandler();
      expect(h.agentCount).toBe(0);
    });

    it('should create via factory', () => {
      const h = createDashboardHandler({ prefix: '/v2', cors: false });
      expect(h.agentCount).toBe(0);
    });

    it('should register agents', () => {
      expect(handler.agentCount).toBe(2);
      expect(handler.hasAgent('Echo')).toBe(true);
      expect(handler.hasAgent('Echo2')).toBe(true);
    });
  });

  // ── Route Matching ──

  describe('Route Matching', () => {
    it('should not handle non-prefixed routes', async () => {
      const req = createMockReq('GET', '/other/path');
      const res = createMockRes();
      const handled = await handler.handle(req, res);
      expect(handled).toBe(false);
    });

    it('should handle prefixed routes', async () => {
      const req = createMockReq('GET', '/api/agents');
      const res = createMockRes();
      const handled = await handler.handle(req, res);
      expect(handled).toBe(true);
    });

    it('should return 404 for unknown API routes', async () => {
      const req = createMockReq('GET', '/api/nonexistent');
      const res = createMockRes();
      await handler.handle(req, res);
      expect(res._statusCode).toBe(404);
    });
  });

  // ── GET /api/agents ──

  describe('GET /api/agents', () => {
    it('should list all agents', async () => {
      const req = createMockReq('GET', '/api/agents');
      const res = createMockRes();
      await handler.handle(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.count).toBe(2);
      expect(body.agents).toHaveLength(2);
      expect(body.agents[0]).toHaveProperty('name');
      expect(body.agents[0]).toHaveProperty('description');
      expect(body.agents[0]).toHaveProperty('parameters');
    });
  });

  // ── POST /api/agents/execute ──

  describe('POST /api/agents/execute', () => {
    it('should execute an agent', async () => {
      const body = JSON.stringify({ agentName: 'Echo', kwargs: { query: 'test' } });
      const req = createMockReq('POST', '/api/agents/execute', body);
      const res = createMockRes();
      await handler.handle(req, res);

      expect(res._statusCode).toBe(200);
      const result = JSON.parse(res._body);
      expect(result.status).toBe('success');
      expect(result.agentName).toBe('Echo');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.result.echo).toBe('test');
    });

    it('should return 404 for unknown agent', async () => {
      const body = JSON.stringify({ agentName: 'NonExistent', kwargs: {} });
      const req = createMockReq('POST', '/api/agents/execute', body);
      const res = createMockRes();
      await handler.handle(req, res);

      expect(res._statusCode).toBe(404);
    });

    it('should return 400 when agentName missing', async () => {
      const body = JSON.stringify({ kwargs: {} });
      const req = createMockReq('POST', '/api/agents/execute', body);
      const res = createMockRes();
      await handler.handle(req, res);

      expect(res._statusCode).toBe(400);
    });

    it('should return 400 for invalid JSON', async () => {
      const req = createMockReq('POST', '/api/agents/execute', 'not json');
      const res = createMockRes();
      await handler.handle(req, res);

      expect(res._statusCode).toBe(400);
    });

    it('should handle agent execution errors', async () => {
      handler.registerAgent(new FailAgent());
      const body = JSON.stringify({ agentName: 'Fail', kwargs: {} });
      const req = createMockReq('POST', '/api/agents/execute', body);
      const res = createMockRes();
      await handler.handle(req, res);

      expect(res._statusCode).toBe(200);
      const result = JSON.parse(res._body);
      expect(result.status).toBe('error');
      expect(result.error).toContain('Intentional failure');
    });
  });

  // ── Traces ──

  describe('Traces', () => {
    it('should start with empty traces', async () => {
      const req = createMockReq('GET', '/api/traces');
      const res = createMockRes();
      await handler.handle(req, res);

      const body = JSON.parse(res._body);
      expect(body.count).toBe(0);
      expect(body.traces).toEqual([]);
    });

    it('should record traces from execution', async () => {
      // Execute an agent to generate a trace
      const execBody = JSON.stringify({ agentName: 'Echo', kwargs: { query: 'trace-test' } });
      const execReq = createMockReq('POST', '/api/agents/execute', execBody);
      const execRes = createMockRes();
      await handler.handle(execReq, execRes);

      // Now get traces
      const traceReq = createMockReq('GET', '/api/traces');
      const traceRes = createMockRes();
      await handler.handle(traceReq, traceRes);

      const body = JSON.parse(traceRes._body);
      expect(body.count).toBe(1);
      expect(body.traces[0].agentName).toBe('Echo');
      expect(body.traces[0].status).toBe('success');
    });

    it('should support limit parameter', async () => {
      // Add multiple traces
      handler.addTrace({ id: 't1', agentName: 'A', operation: 'exec', status: 'success', durationMs: 10, startTime: '', endTime: '' });
      handler.addTrace({ id: 't2', agentName: 'B', operation: 'exec', status: 'success', durationMs: 20, startTime: '', endTime: '' });
      handler.addTrace({ id: 't3', agentName: 'C', operation: 'exec', status: 'success', durationMs: 30, startTime: '', endTime: '' });

      const req = createMockReq('GET', '/api/traces?limit=2');
      const res = createMockRes();
      await handler.handle(req, res);

      const body = JSON.parse(res._body);
      expect(body.count).toBe(2);
    });

    it('should clear traces', async () => {
      handler.addTrace({ id: 't1', agentName: 'A', operation: 'exec', status: 'success', durationMs: 10, startTime: '', endTime: '' });

      const req = createMockReq('DELETE', '/api/traces');
      const res = createMockRes();
      await handler.handle(req, res);

      expect(JSON.parse(res._body).cleared).toBe(true);
      expect(handler.getTraces()).toHaveLength(0);
    });
  });

  // ── GET /api/status ──

  describe('GET /api/status', () => {
    it('should return dashboard status', async () => {
      const req = createMockReq('GET', '/api/status');
      const res = createMockRes();
      await handler.handle(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.agentCount).toBe(2);
      expect(body.agents).toContain('Echo');
    });
  });

  // ── CORS ──

  describe('CORS', () => {
    it('should add CORS headers by default', async () => {
      const req = createMockReq('GET', '/api/agents');
      const res = createMockRes();
      await handler.handle(req, res);

      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
    });

    it('should handle OPTIONS preflight', async () => {
      const req = createMockReq('OPTIONS', '/api/agents');
      const res = createMockRes();
      const handled = await handler.handle(req, res);

      expect(handled).toBe(true);
      expect(res._statusCode).toBe(204);
    });

    it('should skip CORS when disabled', async () => {
      const h = createDashboardHandler({ cors: false });
      h.registerAgent(new EchoAgent());
      const req = createMockReq('GET', '/api/agents');
      const res = createMockRes();
      await h.handle(req, res);

      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });
  });

  // ── Custom Prefix ──

  describe('Custom Prefix', () => {
    it('should use custom prefix', async () => {
      const h = createDashboardHandler({ prefix: '/v2/dashboard' });
      h.registerAgent(new EchoAgent());

      const req = createMockReq('GET', '/v2/dashboard/agents');
      const res = createMockRes();
      const handled = await h.handle(req, res);
      expect(handled).toBe(true);

      const body = JSON.parse(res._body);
      expect(body.count).toBe(1);
    });
  });
});
