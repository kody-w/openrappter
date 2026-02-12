/**
 * Tests for gateway types — validates all type exports exist
 * and the event constants are correct.
 */
import { describe, it, expect } from 'vitest';
import {
  RPC_ERROR,
  GatewayEvents,
} from '../types.js';
import type {
  RpcRequest,
  RpcResponse,
  RpcError,
  RpcEvent,
  StreamingResponse,
  AgentRequest,
  AgentResponse,
  AgentOptions,
  Attachment,
  ToolOutput,
  ToolCallResult,
  TokenUsage,
  ChatSession,
  ChatMessage,
  ChatSessionSummary,
  ChannelStatus,
  SendMessageRequest,
  CronJob,
  ConfigSnapshot,
  GatewayStatus,
  HealthResponse,
  LogEntry,
  ConnectionInfo,
  GatewayEventType,
} from '../types.js';

describe('Gateway Types', () => {
  it('exports RPC_ERROR constants', () => {
    expect(RPC_ERROR.PARSE_ERROR).toBe(-32700);
    expect(RPC_ERROR.INVALID_REQUEST).toBe(-32600);
    expect(RPC_ERROR.METHOD_NOT_FOUND).toBe(-32601);
    expect(RPC_ERROR.INVALID_PARAMS).toBe(-32602);
    expect(RPC_ERROR.INTERNAL_ERROR).toBe(-32603);
    expect(RPC_ERROR.UNAUTHORIZED).toBe(-32000);
    expect(RPC_ERROR.RATE_LIMITED).toBe(-32001);
  });

  it('exports GatewayEvents constants', () => {
    expect(GatewayEvents.AGENT).toBe('agent');
    expect(GatewayEvents.AGENT_STREAM).toBe('agent.stream');
    expect(GatewayEvents.AGENT_TOOL).toBe('agent.tool');
    expect(GatewayEvents.CHAT).toBe('chat');
    expect(GatewayEvents.CHAT_MESSAGE).toBe('chat.message');
    expect(GatewayEvents.CHANNEL).toBe('channel');
    expect(GatewayEvents.CHANNEL_MESSAGE).toBe('channel.message');
    expect(GatewayEvents.CHANNEL_STATUS).toBe('channel.status');
    expect(GatewayEvents.CRON).toBe('cron');
    expect(GatewayEvents.CRON_RUN).toBe('cron.run');
    expect(GatewayEvents.CRON_COMPLETE).toBe('cron.complete');
    expect(GatewayEvents.PRESENCE).toBe('presence');
    expect(GatewayEvents.HEARTBEAT).toBe('heartbeat');
    expect(GatewayEvents.SHUTDOWN).toBe('shutdown');
    expect(GatewayEvents.ERROR).toBe('error');
    expect(GatewayEvents.LOG).toBe('log');
  });

  it('has 16 event types', () => {
    expect(Object.keys(GatewayEvents)).toHaveLength(16);
  });

  // Type-level checks — if these compile, the types are structurally valid
  it('validates RpcRequest shape', () => {
    const req: RpcRequest = { id: '1', method: 'test', params: { a: 1 } };
    expect(req.id).toBe('1');
    expect(req.method).toBe('test');
  });

  it('validates RpcResponse shape', () => {
    const res: RpcResponse = { id: '1', result: { ok: true } };
    expect(res.id).toBe('1');
    const errRes: RpcResponse = { id: '2', error: { code: -1, message: 'fail' } };
    expect(errRes.error?.code).toBe(-1);
  });

  it('validates AgentRequest shape', () => {
    const req: AgentRequest = {
      message: 'hello',
      agentId: 'assistant',
      sessionId: 's1',
      attachments: [{ type: 'image', mimeType: 'image/png', data: 'base64...' }],
      options: { stream: true, model: 'gpt-4o' },
    };
    expect(req.message).toBe('hello');
    expect(req.attachments).toHaveLength(1);
  });

  it('validates AgentResponse shape', () => {
    const res: AgentResponse = {
      sessionId: 's1',
      content: 'hello back',
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      finishReason: 'stop',
    };
    expect(res.content).toBe('hello back');
    expect(res.usage?.totalTokens).toBe(15);
  });

  it('validates ChatSession shape', () => {
    const session: ChatSession = {
      id: 's1',
      agentId: 'assistant',
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: '2025-01-01' }],
      metadata: {},
      createdAt: '2025-01-01',
      updatedAt: '2025-01-01',
    };
    expect(session.messages).toHaveLength(1);
  });

  it('validates ChannelStatus shape', () => {
    const ch: ChannelStatus = { id: 'discord', type: 'discord', connected: true };
    expect(ch.connected).toBe(true);
  });

  it('validates CronJob shape', () => {
    const job: CronJob = {
      id: 'j1',
      name: 'daily-backup',
      schedule: '0 0 * * *',
      enabled: true,
    };
    expect(job.enabled).toBe(true);
  });

  it('validates GatewayStatus shape', () => {
    const st: GatewayStatus = {
      running: true,
      port: 18790,
      connections: 2,
      uptime: 3600,
      version: '1.2.0',
      startedAt: '2025-01-01',
    };
    expect(st.running).toBe(true);
  });

  it('validates HealthResponse shape', () => {
    const h: HealthResponse = {
      status: 'ok',
      version: '1.2.0',
      uptime: 3600,
      timestamp: '2025-01-01',
      checks: { gateway: true, storage: true, channels: false },
    };
    expect(h.status).toBe('ok');
    expect(h.checks.channels).toBe(false);
  });

  it('validates LogEntry shape', () => {
    const l: LogEntry = {
      timestamp: '2025-01-01',
      level: 'info',
      source: 'gateway',
      message: 'started',
    };
    expect(l.level).toBe('info');
  });

  it('validates ConnectionInfo shape', () => {
    const c: ConnectionInfo = {
      id: 'c1',
      connectedAt: '2025-01-01',
      authenticated: true,
      deviceId: 'd1',
    };
    expect(c.authenticated).toBe(true);
  });
});
