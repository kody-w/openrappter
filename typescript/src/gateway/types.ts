/**
 * Gateway types
 */

import type { GatewayMetricsSnapshot } from './observability.js';

export interface RpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: RpcError;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcEvent {
  event: string;
  data: unknown;
}

// Standard JSON-RPC error codes
export const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32000,
  RATE_LIMITED: -32001,
  TIMEOUT: -32002,
} as const;

export interface GatewayConfig {
  port: number;
  bind: 'loopback' | 'all';
  auth?: {
    mode: 'none' | 'password' | 'token';
    password?: string;
    tokens?: string[];
  };
  heartbeatInterval?: number;
  connectionTimeout?: number;
  webRoot?: string;
  /**
   * Directory used for gateway-owned persistent state (sessions, cron,
   * config, and channel environment values). Defaults to
   * `~/.openrappter`; injectable so embedded runtimes and tests can
   * isolate state without changing the process home directory.
   */
  dataDir?: string;
  /**
   * Optional bounded execution timeout (ms) applied to RPC method handlers
   * on both the HTTP JSON-RPC and WS dispatch paths. Disabled by default
   * (undefined) to preserve existing behavior for long-running methods;
   * opt in to enforce a bound and populate the `rpcTimeoutsTotal` metric.
   */
  executionTimeoutMs?: number;
  /**
   * Maximum time to drain external agent/cron work and network listeners
   * during stop(). Work that cannot be cancelled is generation-fenced.
   */
  shutdownTimeoutMs?: number;
}

export interface GatewayStatus {
  running: boolean;
  port: number;
  connections: number;
  uptime: number;
  version: string;
  startedAt: string;
  /** Bounded, low-cardinality observability snapshot (see `gateway/observability.ts`). */
  metrics?: GatewayMetricsSnapshot;
}

export interface ConnectionInfo {
  id: string;
  connectedAt: string;
  authenticated: boolean;
  subscriptions: Set<string>;
  lastActivity: number;
  deviceId?: string;
  deviceType?: string;
  metadata?: Record<string, unknown>;
}

export type RpcStreamCallback = (response: StreamingResponse) => void;

export type RpcMethodHandler<P = unknown, R = unknown> = (
  params: P,
  connection: ConnectionInfo,
  stream?: RpcStreamCallback
) => Promise<R>;

export interface RpcMethod<P = unknown, R = unknown> {
  name: string;
  handler: RpcMethodHandler<P, R>;
  requiresAuth?: boolean;
}

// Streaming support
export interface StreamingDeltaResponse {
  id: string;
  streaming: true;
  chunk?: string;
  toolOutput?: ToolOutput;
  done?: false;
  error?: never;
  result?: never;
  payload?: never;
}

export interface StreamingTerminalResponse<T = unknown> {
  id: string;
  streaming: true;
  done: true;
  chunk?: never;
  toolOutput?: never;
  error?: RpcError;
  /** Final method value on the single terminal (`done: true`) frame. */
  result?: T;
  /** Backward-compatible alias for clients that use response payloads. */
  payload?: T;
}

export type StreamingResponse<T = unknown> =
  | StreamingDeltaResponse
  | StreamingTerminalResponse<T>;

export interface ToolOutput {
  toolCallId: string;
  name: string;
  result: unknown;
  status: 'success' | 'error';
}

// Agent request/response types
export interface AgentRequest {
  agentId?: string;
  message: string;
  sessionId?: string;
  conversationId?: string;
  channelId?: string;
  userId?: string;
  conversationHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  attachments?: Attachment[];
  options?: AgentOptions;
}

export interface Attachment {
  type: 'image' | 'audio' | 'document' | 'file';
  url?: string;
  data?: string;
  mimeType: string;
  filename?: string;
}

export interface AgentOptions {
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
  tools?: string[];
  model?: string;
}

export interface AgentResponse {
  sessionId: string;
  content: string;
  toolCalls?: ToolCallResult[];
  usage?: TokenUsage;
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
  agentLogs?: string[];
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: 'pending' | 'running' | 'success' | 'error';
  error?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Chat session types
export interface ChatSession {
  id: string;
  agentId: string;
  channelId?: string;
  conversationId?: string;
  userId?: string;
  messages: ChatMessage[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCallResult[];
  toolCallId?: string;
  timestamp: string;
}

// Channel types for gateway
export interface ChannelStatus {
  id: string;
  type: string;
  connected: boolean;
  lastActivity?: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageRequest {
  channelId: string;
  conversationId: string;
  content: string;
  replyTo?: string;
  attachments?: Attachment[];
}

// Event types
export const GatewayEvents = {
  AGENT: 'agent',
  AGENT_STREAM: 'agent.stream',
  AGENT_TOOL: 'agent.tool',
  CHAT: 'chat',
  CHAT_MESSAGE: 'chat.message',
  CHANNEL: 'channel',
  CHANNEL_MESSAGE: 'channel.message',
  CHANNEL_STATUS: 'channel.status',
  CRON: 'cron',
  CRON_RUN: 'cron.run',
  CRON_COMPLETE: 'cron.complete',
  PRESENCE: 'presence',
  HEARTBEAT: 'heartbeat',
  RAPPTER: 'rappter',
  RAPPTER_SUMMON: 'rappter.summon',
  SHUTDOWN: 'shutdown',
  ERROR: 'error',
} as const;

export type GatewayEventType = (typeof GatewayEvents)[keyof typeof GatewayEvents];

// Health check response
export interface HealthResponse {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  uptime: number;
  timestamp: string;
  checks: {
    gateway: boolean;
    storage?: boolean;
    channels?: boolean;
    agents?: boolean;
    copilot?: boolean;
  };
  /** Bounded, low-cardinality observability snapshot (see `gateway/observability.ts`). */
  metrics?: GatewayMetricsSnapshot;
}
