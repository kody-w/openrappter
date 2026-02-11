# Implementation Plan: OpenClaw Feature Parity

This document provides the step-by-step implementation plan for adding openclaw-equivalent features to openrappter.

## Phase 1: Foundation

### Feature 1.1: Enhanced Configuration System

**Files to create:**
```
typescript/src/config/
├── index.ts           # Export barrel
├── schema.ts          # Zod schemas for config validation
├── loader.ts          # JSON5 loading with env var substitution
├── watcher.ts         # Hot reload support
└── types.ts           # TypeScript types

python/openrappter/config/
├── __init__.py
├── schema.py          # Pydantic schemas
├── loader.py          # JSON5 loading
└── watcher.py         # Hot reload
```

**Config schema:**
```typescript
// typescript/src/config/schema.ts
import { z } from 'zod';

export const ModelConfigSchema = z.object({
  id: z.string(),
  provider: z.enum(['anthropic', 'openai', 'gemini', 'bedrock', 'ollama', 'copilot']),
  model: z.string(),
  auth: z.object({
    type: z.enum(['api-key', 'oauth']),
    token_env: z.string().optional(),
  }),
  fallbacks: z.array(z.string()).optional(),
});

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  model: z.string().or(z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()).optional(),
  })),
  workspace: z.string().optional(),
  skills: z.array(z.string()).optional(),
  sandbox: z.object({
    docker: z.boolean().optional(),
  }).optional(),
});

export const ChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowFrom: z.array(z.string()).optional(),
  mentionGating: z.boolean().optional(),
});

export const OpenRappterConfigSchema = z.object({
  models: z.array(ModelConfigSchema).optional(),
  agents: z.object({
    list: z.array(AgentConfigSchema).optional(),
    defaults: AgentConfigSchema.partial().optional(),
  }).optional(),
  channels: z.record(ChannelConfigSchema).optional(),
  gateway: z.object({
    port: z.number().default(18789),
    bind: z.enum(['loopback', 'all']).default('loopback'),
    auth: z.object({
      mode: z.enum(['none', 'password']).default('none'),
      password: z.string().optional(),
    }).optional(),
  }).optional(),
  cron: z.object({
    enabled: z.boolean().default(false),
  }).optional(),
  memory: z.object({
    provider: z.enum(['openai', 'gemini', 'local']).default('openai'),
    chunkTokens: z.number().default(512),
    chunkOverlap: z.number().default(64),
  }).optional(),
});
```

**Dependencies to add:**
```json
{
  "json5": "^2.2.3",
  "zod": "^3.23.0",
  "chokidar": "^5.0.0"
}
```

---

### Feature 1.2: Multi-Provider LLM Support

**Files to create:**
```
typescript/src/providers/
├── index.ts           # Export barrel
├── types.ts           # Provider interfaces
├── base.ts            # Base provider class
├── anthropic.ts       # Anthropic Claude
├── openai.ts          # OpenAI GPT
├── copilot.ts         # GitHub Copilot (existing)
├── ollama.ts          # Local Ollama
└── registry.ts        # Provider registry with failover

python/openrappter/providers/
├── __init__.py
├── base.py
├── anthropic.py
├── openai.py
├── copilot.py
├── ollama.py
└── registry.py
```

**Provider interface:**
```typescript
// typescript/src/providers/types.ts
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderResponse {
  content: string | null;
  tool_calls: ToolCall[] | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface LLMProvider {
  id: string;
  name: string;

  chat(
    messages: Message[],
    options?: {
      model?: string;
      tools?: Tool[];
      temperature?: number;
      max_tokens?: number;
    }
  ): Promise<ProviderResponse>;

  embed?(texts: string[]): Promise<number[][]>;

  isAvailable(): Promise<boolean>;
}
```

**Provider registry:**
```typescript
// typescript/src/providers/registry.ts
export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();

  register(provider: LLMProvider): void;
  get(id: string): LLMProvider | undefined;

  async chatWithFailover(
    providerChain: string[],
    messages: Message[],
    options?: ChatOptions
  ): Promise<ProviderResponse>;
}
```

**Dependencies to add:**
```json
{
  "@anthropic-ai/sdk": "^0.39.0",
  "openai": "^4.77.0",
  "ollama": "^0.6.0"
}
```

---

### Feature 1.3: Enhanced Memory System

**Files to create:**
```
typescript/src/memory/
├── index.ts           # Export barrel
├── types.ts           # Memory types
├── manager.ts         # Main memory manager
├── sqlite.ts          # SQLite operations
├── embeddings.ts      # Embedding providers
├── chunker.ts         # Text chunking
├── hybrid.ts          # Hybrid search (vector + FTS)
└── sync.ts            # File sync service

python/openrappter/memory/
├── __init__.py
├── manager.py
├── sqlite.py
├── embeddings.py
├── chunker.py
├── hybrid.py
└── sync.py
```

**Memory manager interface:**
```typescript
// typescript/src/memory/types.ts
export interface MemoryChunk {
  id: string;
  content: string;
  source: 'session' | 'workspace' | 'memory';
  sourcePath: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface MemorySearchResult {
  chunk: MemoryChunk;
  score: number;
  snippet: string;
}

export interface MemoryManager {
  initialize(): Promise<void>;

  search(query: string, options?: {
    limit?: number;
    threshold?: number;
    sources?: Array<'session' | 'workspace' | 'memory'>;
  }): Promise<MemorySearchResult[]>;

  add(content: string, source: string, metadata?: Record<string, unknown>): Promise<string>;

  remove(id: string): Promise<void>;

  sync(): Promise<void>;

  getStatus(): Promise<{
    totalChunks: number;
    indexedChunks: number;
    pendingSync: number;
  }>;
}
```

**Dependencies to add:**
```json
{
  "better-sqlite3": "^11.8.0",
  "sqlite-vec": "^0.1.7"
}
```

---

## Phase 2: Core Features

### Feature 2.1: Cron Service

**Files to create:**
```
typescript/src/cron/
├── index.ts           # Export barrel
├── types.ts           # Cron types
├── service.ts         # Main cron service
├── storage.ts         # Job persistence
├── executor.ts        # Job execution
└── parser.ts          # Cron expression utilities

python/openrappter/cron/
├── __init__.py
├── service.py
├── storage.py
├── executor.py
└── parser.py
```

**Cron types:**
```typescript
// typescript/src/cron/types.ts
export interface CronJob {
  id: string;
  name: string;
  schedule: string;  // Cron expression
  agentId: string;
  message: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
}

export interface CronJobCreate {
  name: string;
  schedule: string;
  agentId?: string;
  message: string;
  enabled?: boolean;
}

export interface CronJobPatch {
  name?: string;
  schedule?: string;
  message?: string;
  enabled?: boolean;
}
```

**Dependencies to add:**
```json
{
  "croner": "^10.0.0"
}
```

---

### Feature 2.2: Gateway Server

**Files to create:**
```
typescript/src/gateway/
├── index.ts           # Export barrel
├── server.ts          # WebSocket server
├── methods.ts         # RPC method registry
├── auth.ts            # Authentication
├── subscriptions.ts   # Event subscriptions
└── protocol.ts        # Protocol types

python/openrappter/gateway/
├── __init__.py
├── server.py
├── methods.py
├── auth.py
├── subscriptions.py
└── protocol.py
```

**Gateway protocol:**
```typescript
// typescript/src/gateway/protocol.ts
export interface RpcRequest {
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface RpcEvent {
  event: string;
  data: unknown;
}

// Core methods
export type GatewayMethods = {
  // Agent methods
  'agent.list': () => AgentInfo[];
  'agent.execute': (params: { agentId: string; query: string }) => string;

  // Cron methods
  'cron.list': () => CronJob[];
  'cron.add': (params: CronJobCreate) => CronJob;
  'cron.run': (params: { id: string }) => void;

  // Memory methods
  'memory.search': (params: { query: string; limit?: number }) => MemorySearchResult[];
  'memory.add': (params: { content: string }) => string;

  // Channel methods
  'channels.list': () => ChannelInfo[];
  'channels.send': (params: { channel: string; to: string; message: string }) => void;

  // Status
  'status': () => GatewayStatus;
};
```

**Dependencies to add:**
```json
{
  "ws": "^8.18.0",
  "hono": "^4.6.0",
  "@hono/node-server": "^1.13.0"
}
```

---

### Feature 2.3: Channel Abstraction

**Files to create:**
```
typescript/src/channels/
├── index.ts           # Export barrel
├── types.ts           # Channel interfaces
├── registry.ts        # Channel registry
├── router.ts          # Message routing
├── base.ts            # Base channel class
└── cli.ts             # CLI channel (existing behavior)

python/openrappter/channels/
├── __init__.py
├── base.py
├── registry.py
├── router.py
└── cli.py
```

**Channel interface:**
```typescript
// typescript/src/channels/types.ts
export interface IncomingMessage {
  id: string;
  channel: string;
  conversationId: string;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: string;
  replyTo?: string;
  attachments?: Attachment[];
}

export interface OutgoingMessage {
  content: string;
  replyTo?: string;
  attachments?: Attachment[];
}

export interface Channel {
  id: string;
  name: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  send(conversationId: string, message: OutgoingMessage): Promise<void>;

  onMessage(handler: (message: IncomingMessage) => Promise<void>): void;

  getConversations?(): Promise<Conversation[]>;
}

export interface ChannelRegistry {
  register(channel: Channel): void;
  get(id: string): Channel | undefined;
  list(): Channel[];

  broadcast(message: OutgoingMessage, filter?: (channel: Channel) => boolean): Promise<void>;
}
```

---

## Phase 3: Communication Channels

### Feature 3.1: Telegram Channel

**Files to create:**
```
typescript/src/channels/telegram/
├── index.ts           # Export
├── channel.ts         # Telegram channel implementation
├── handlers.ts        # Message handlers
└── commands.ts        # Custom commands

python/openrappter/channels/telegram/
├── __init__.py
├── channel.py
├── handlers.py
└── commands.py
```

**Dependencies to add:**
```json
{
  "grammy": "^1.30.0"
}
```

---

### Feature 3.2: Discord Channel

**Files to create:**
```
typescript/src/channels/discord/
├── index.ts
├── channel.ts
├── handlers.ts
└── commands.ts
```

**Dependencies to add:**
```json
{
  "discord.js": "^14.16.0"
}
```

---

### Feature 3.3: Slack Channel

**Files to create:**
```
typescript/src/channels/slack/
├── index.ts
├── channel.ts
├── handlers.ts
└── commands.ts
```

**Dependencies to add:**
```json
{
  "@slack/bolt": "^4.1.0"
}
```

---

## Phase 4: Advanced Features

### Feature 4.1: Browser Automation

**Files to create:**
```
typescript/src/browser/
├── index.ts
├── service.ts         # Browser service
├── cdp.ts             # CDP wrapper
├── actions.ts         # Browser actions
└── screenshots.ts     # Screenshot handling
```

**Dependencies to add:**
```json
{
  "playwright-core": "^1.49.0"
}
```

---

### Feature 4.2: Multi-Agent Support

**Files to create:**
```
typescript/src/agents/
├── scope.ts           # Agent scope resolution
├── workspace.ts       # Workspace isolation
├── subagent.ts        # Subagent spawning
└── sessions.ts        # Session management
```

---

### Feature 4.3: Skill Registry

**Files to create:**
```
typescript/src/skills/
├── index.ts
├── registry.ts        # Skill registry
├── installer.ts       # Remote skill installation
├── versioning.ts      # Version management
└── status.ts          # Skill health monitoring
```

---

## Test Cases Overview

### Unit Tests (per feature)

```
typescript/src/**/*.test.ts    # Colocated tests
python/openrappter/**/*_test.py
```

### Integration Tests

```
typescript/test/integration/
├── config.test.ts
├── providers.test.ts
├── memory.test.ts
├── cron.test.ts
├── gateway.test.ts
└── channels.test.ts
```

### E2E Tests

```
typescript/test/e2e/
├── full-workflow.test.ts
├── channel-routing.test.ts
└── multi-agent.test.ts
```

---

## Implementation Order

1. **Config System** - Foundation for everything else
2. **Provider Registry** - Enable multi-LLM support
3. **Memory Manager** - Core intelligence feature
4. **Cron Service** - Automation capability
5. **Gateway Server** - Remote control
6. **Channel Base** - Abstraction layer
7. **Telegram Channel** - First messaging platform
8. **Discord Channel** - Second platform
9. **Browser Service** - Web automation
10. **Multi-Agent** - Advanced orchestration

Each feature will be implemented with:
1. Types/interfaces first
2. Core implementation
3. Unit tests
4. Integration tests
5. Documentation update
