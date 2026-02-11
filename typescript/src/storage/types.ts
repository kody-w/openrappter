/**
 * Storage types for persistence layer
 */

export interface StorageAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Sessions
  getSession(id: string): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  deleteSession(id: string): Promise<void>;
  listSessions(filter?: SessionFilter): Promise<Session[]>;

  // Memory chunks
  getMemoryChunk(id: string): Promise<MemoryChunkRecord | null>;
  saveMemoryChunk(chunk: MemoryChunkRecord): Promise<void>;
  deleteMemoryChunk(id: string): Promise<void>;
  searchMemoryChunks(query: MemorySearchQuery): Promise<MemoryChunkRecord[]>;

  // Cron jobs
  getCronJob(id: string): Promise<CronJobRecord | null>;
  saveCronJob(job: CronJobRecord): Promise<void>;
  deleteCronJob(id: string): Promise<void>;
  listCronJobs(): Promise<CronJobRecord[]>;
  saveCronLog(log: CronLogRecord): Promise<void>;
  getCronLogs(jobId: string, limit?: number): Promise<CronLogRecord[]>;

  // Devices
  getDevice(id: string): Promise<Device | null>;
  saveDevice(device: Device): Promise<void>;
  deleteDevice(id: string): Promise<void>;
  listDevices(): Promise<Device[]>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
  deleteConfig(key: string): Promise<void>;
  getAllConfig(): Promise<Record<string, string>>;

  // Transactions
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface Session {
  id: string;
  channelId: string;
  conversationId: string;
  agentId: string;
  userId?: string;
  metadata: Record<string, unknown>;
  messages: SessionMessage[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface SessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCallRecord[];
  toolCallId?: string;
  timestamp: string;
}

export interface ToolCallRecord {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface SessionFilter {
  channelId?: string;
  conversationId?: string;
  agentId?: string;
  userId?: string;
  createdAfter?: string;
  createdBefore?: string;
  limit?: number;
  offset?: number;
}

export interface MemoryChunkRecord {
  id: string;
  content: string;
  source: 'session' | 'workspace' | 'memory' | 'document';
  sourcePath?: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MemorySearchQuery {
  embedding?: number[];
  keywords?: string[];
  sources?: string[];
  limit?: number;
  threshold?: number;
  useHybrid?: boolean;
}

export interface CronJobRecord {
  id: string;
  name: string;
  schedule: string;
  agentId: string;
  message: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CronLogRecord {
  id: string;
  jobId: string;
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'success' | 'error';
  result?: string;
  error?: string;
}

export interface Device {
  id: string;
  name: string;
  type: 'cli' | 'web' | 'mobile' | 'gateway';
  publicKey?: string;
  lastSeen: string;
  trusted: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface StorageConfig {
  type: 'sqlite' | 'memory';
  path?: string;
  inMemory?: boolean;
}

export interface MigrationRecord {
  id: number;
  name: string;
  appliedAt: string;
}
