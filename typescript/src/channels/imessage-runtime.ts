import type {
  AssistantConversationMessage,
  AssistantResponse,
} from '../agents/Assistant.js';
import { logger } from '../logging/logger.js';
import {
  classifyIMessageConnectionFailure,
  chunkIMessageText,
  type IMessageChannel,
  type IMessagePreparedSend,
  type IMessageTransportHealth,
} from './imessage.js';
import {
  IMessageStateStore,
  type IMessagePersistentHealth,
  type IMessageQueueMetrics,
  type StoredIMessageInbound,
  type StoredIMessageOutboxChunk,
} from './imessage-state-store.js';
import type { OutgoingMessage } from './types.js';

const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;
const DEFAULT_CONFIRMATION_GRACE_MS = 30_000;
const DEFAULT_MAX_MODEL_ATTEMPTS = 3;

const runtimeLog = logger.child('channel:imessage');

export interface DurableIMessageAssistant {
  getResponse(
    message: string,
    onDelta?: (text: string) => void,
    memoryContext?: string,
    conversationKey?: string,
    signal?: AbortSignal,
  ): Promise<AssistantResponse>;
  clearConversation(key: string): void;
  exportConversation(key: string): AssistantConversationMessage[];
  importConversation(
    key: string,
    messages: readonly AssistantConversationMessage[],
  ): void;
}

export interface DurableIMessageChannel {
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: () => Promise<void>): () => void;
  send(conversationId: string, message: OutgoingMessage): Promise<void>;
  prepareSend(
    conversationId: string,
    message: OutgoingMessage,
  ): Promise<IMessagePreparedSend>;
  authorizePersistedReplyTarget(target: string): void;
  getCurrentMaxRowId(): Promise<number>;
  findSentMessage(options: {
    afterRowId: number;
    chatGuid: string;
    target: string;
    content: string;
  }): Promise<number | null>;
  getTransportHealth(): IMessageTransportHealth;
}

export interface IMessageRuntimeStatus {
  state: 'online' | 'degraded' | 'offline';
  reason?: string;
  transport: IMessageTransportHealth;
  queue: IMessageQueueMetrics;
  health: IMessagePersistentHealth;
  modelReadiness: 'ready' | 'pending' | 'failed';
}

export interface IMessageRuntimeOptions {
  assistant: DurableIMessageAssistant;
  channel: DurableIMessageChannel | IMessageChannel;
  store: IMessageStateStore;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  random?: () => number;
  workerIntervalMs?: number;
  reconnectBaseMs?: number;
  maxBackoffMs?: number;
  confirmationGraceMs?: number;
  maxModelAttempts?: number;
}

interface ModelFailure {
  code: string;
  permanent: boolean;
}

export class IMessageRuntime {
  private readonly assistant: DurableIMessageAssistant;
  private readonly channel: DurableIMessageChannel;
  private readonly store: IMessageStateStore;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private readonly random: () => number;
  private readonly workerIntervalMs: number;
  private readonly reconnectBaseMs: number;
  private readonly maxBackoffMs: number;
  private readonly confirmationGraceMs: number;
  private readonly maxModelAttempts: number;
  private initialized = false;
  private running = false;
  private workerTimer: unknown;
  private reconnectTimer: unknown;
  private workerPromise: Promise<void> | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private removeMessageHandler?: () => void;
  private readonly activeInferenceControllers = new Map<string, AbortController>();
  private stopping = false;
  private modelReadiness: 'ready' | 'pending' | 'failed' = 'ready';
  private modelReadinessReason?: string;

  constructor(options: IMessageRuntimeOptions) {
    this.assistant = options.assistant;
    this.channel = options.channel;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule =
      options.cancelSchedule
      ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;
    this.workerIntervalMs = boundedPositive(
      options.workerIntervalMs,
      DEFAULT_WORKER_INTERVAL_MS,
    );
    this.reconnectBaseMs = boundedPositive(
      options.reconnectBaseMs,
      DEFAULT_RECONNECT_BASE_MS,
    );
    this.maxBackoffMs = boundedPositive(
      options.maxBackoffMs,
      DEFAULT_MAX_BACKOFF_MS,
    );
    this.confirmationGraceMs = boundedPositive(
      options.confirmationGraceMs,
      DEFAULT_CONFIRMATION_GRACE_MS,
    );
    this.maxModelAttempts = boundedPositive(
      options.maxModelAttempts,
      DEFAULT_MAX_MODEL_ATTEMPTS,
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.store.initialize();
    for (const conversation of await this.store.listConversations()) {
      this.assistant.importConversation(
        conversation.conversationKey,
        conversation.messages,
      );
    }
    let quarantinedTargets = 0;
    for (const target of await this.store.listPersistedReplyTargets()) {
      try {
        this.channel.authorizePersistedReplyTarget(target);
      } catch {
        quarantinedTargets += await this.store.quarantineUnauthorizedTarget(target);
      }
    }
    if (quarantinedTargets > 0) {
      runtimeLog.warn('Quarantined iMessage work for removed allowlist targets', {
        count: quarantinedTargets,
      });
    }
    this.removeMessageHandler = this.channel.onMessage(async () => {
      this.wake();
    });
    this.initialized = true;
  }

  async start(): Promise<void> {
    await this.initialize();
    if (this.running) return;
    this.stopping = false;
    this.running = true;
    await this.ensureConnected();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.running = false;
    if (this.workerTimer !== undefined) {
      this.cancelSchedule(this.workerTimer);
      this.workerTimer = undefined;
    }
    if (this.reconnectTimer !== undefined) {
      this.cancelSchedule(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.removeMessageHandler?.();
    this.removeMessageHandler = undefined;
    for (const controller of this.activeInferenceControllers.values()) {
      controller.abort();
    }
    await this.connecting?.catch(() => undefined);
    await this.channel.disconnect().catch(() => undefined);
    await this.workerPromise?.catch(() => undefined);
    await this.store.close();
  }

  wake(delayMs = 0): void {
    if (!this.running || this.workerTimer !== undefined) return;
    this.workerTimer = this.schedule(() => {
      this.workerTimer = undefined;
      void this.processNow()
        .catch(() => {
          runtimeLog.warn('iMessage worker cycle failed');
        })
        .finally(() => {
          if (this.running) this.wake(this.workerIntervalMs);
        });
    }, Math.max(0, delayMs));
  }

  async processNow(): Promise<void> {
    if (this.workerPromise) return this.workerPromise;
    const operation = this.runUntilIdle();
    this.workerPromise = operation;
    try {
      await operation;
    } finally {
      if (this.workerPromise === operation) {
        this.workerPromise = null;
      }
    }
  }

  async getStatus(): Promise<IMessageRuntimeStatus> {
    const [queue, health] = await Promise.all([
      this.store.getMetrics(),
      this.store.getHealth(),
    ]);
    const transport = this.channel.getTransportHealth();
    const now = this.now();
    const pollAge = transport.lastPollSuccessAt
      ? now - Date.parse(transport.lastPollSuccessAt)
      : Number.POSITIVE_INFINITY;

    let state: IMessageRuntimeStatus['state'] = 'online';
    let reason: string | undefined;
    if (!this.running || !transport.connected) {
      state = 'offline';
      reason = health.lastConnectionErrorCode ?? 'transport_disconnected';
    } else if (
      transport.consecutivePollFailures > 0
      || pollAge > this.maxBackoffMs + this.workerIntervalMs
      || queue.inbound.ambiguous > 0
      || queue.inbound.dead_letter > 0
      || queue.outbox.ambiguous > 0
      || queue.outbox.dead_letter > 0
      || health.consecutiveModelFailures > 0
      || health.consecutiveSendFailures > 0
      || this.modelReadiness !== 'ready'
    ) {
      state = 'degraded';
      reason =
        transport.lastPollErrorCode
        ?? this.modelReadinessReason
        ?? health.lastModelErrorCode
        ?? health.lastSendErrorCode
        ?? (queue.outbox.ambiguous > 0 ? 'ambiguous_delivery' : undefined)
        ?? (queue.inbound.dead_letter + queue.outbox.dead_letter > 0
          ? 'dead_letter'
          : 'poll_stale');
    }
    return {
      state,
      reason,
      transport,
      queue,
      health,
      modelReadiness: this.modelReadiness,
    };
  }

  setModelReadiness(
    readiness: 'ready' | 'pending' | 'failed',
    reason?: string,
  ): void {
    this.modelReadiness = readiness;
    this.modelReadinessReason =
      readiness === 'ready'
        ? undefined
        : reason ?? `model_${readiness}`;
  }

  private async runUntilIdle(): Promise<void> {
    for (let cycle = 0; cycle < 100; cycle++) {
      if (this.stopping) return;
      await this.reconcileSending();

      const jobs = await this.store.claimReadyInbound(this.timestamp());
      let delivered = 0;
      if (jobs.length > 0) {
        const counts = await Promise.all(jobs.map(async job => {
          await this.processInbound(job);
          return this.deliverReadyOutbox();
        }));
        delivered += counts.reduce((total, count) => total + count, 0);
      }

      delivered += await this.deliverReadyOutbox();

      if (this.stopping) return;
      if (jobs.length === 0 && delivered === 0) return;
    }
    throw new Error('iMessage worker exceeded its bounded drain cycle');
  }

  private async deliverReadyOutbox(): Promise<number> {
    const chunks = await this.store.claimReadyOutbox(this.timestamp());
    if (chunks.length > 0) {
      await Promise.all(chunks.map(chunk => this.deliverChunk(chunk)));
    }
    return chunks.length;
  }

  private async processInbound(job: StoredIMessageInbound): Promise<void> {
    const previousMessages = this.assistant.exportConversation(job.conversationKey);
    const controller = new AbortController();
    this.activeInferenceControllers.set(job.messageId, controller);
    try {
      if (await this.processCommand(job)) {
        return;
      }

      const response = await this.assistant.getResponse(
        job.content,
        undefined,
        undefined,
        job.conversationKey,
        controller.signal,
      );
      const reply = response.content.trim()
        ? response.content
        : 'I could not produce a response. Please try again.';
      await this.store.completeInboundWithReply(
        job.messageId,
        chunkIMessageText(reply),
        {
          messages: this.assistant.exportConversation(job.conversationKey),
        },
      );
      this.setModelReadiness('ready');
      const health = await this.store.getHealth();
      await this.store.patchHealth({
        lastModelSuccessAt: this.timestamp(),
        lastModelErrorCode: undefined,
        consecutiveModelFailures: 0,
        consecutiveSendFailures: health.consecutiveSendFailures,
      });
    } catch (error) {
      this.restoreConversation(job.conversationKey, previousMessages);
      await this.handleModelFailure(job, error);
    } finally {
      this.activeInferenceControllers.delete(job.messageId);
    }
  }

  private async processCommand(job: StoredIMessageInbound): Promise<boolean> {
    const command = job.content.trim().split(/\s+/, 1)[0]?.toLowerCase();
    if (!command?.startsWith('/')) return false;

    if (command === '/help') {
      await this.completeCommand(
        job,
        'Commands: /status, /diagnose, /reset (or /new), /resume, /retry, /help.',
      );
      return true;
    }

    if (command === '/status') {
      const status = await this.getStatus();
      const pending =
        status.queue.inbound.queued
        + status.queue.inbound.processing
        + status.queue.inbound.retry_wait
        + status.queue.inbound.response_ready
        + status.queue.inbound.delivering;
      const stale = status.queue.inbound.stale_pending;
      await this.completeCommand(
        job,
        `OpenRappter iMessage is ${status.state}. Pending: ${pending}. Held stale: ${stale}. Ambiguous deliveries: ${status.queue.outbox.ambiguous}.`,
      );
      return true;
    }

    if (command === '/diagnose') {
      const status = await this.getStatus();
      await this.completeCommand(
        job,
        [
          `State: ${status.state}${status.reason ? ` (${status.reason})` : ''}.`,
          `Connected: ${status.transport.connected}.`,
          `Cursor lag: ${status.transport.cursorLag ?? 'unknown'}.`,
          `Poll failures: ${status.transport.consecutivePollFailures}.`,
          `Model failures: ${status.health.consecutiveModelFailures}.`,
          `Send failures: ${status.health.consecutiveSendFailures}.`,
        ].join(' '),
      );
      return true;
    }

    if (command === '/reset' || command === '/new') {
      this.assistant.clearConversation(job.conversationKey);
      await this.store.completeInboundWithReply(
        job.messageId,
        ['Started a new conversation.'],
        { clearConversation: true },
      );
      return true;
    }

    if (command === '/resume') {
      const resumed = await this.store.resumeStale(job.conversationKey);
      await this.completeCommand(
        job,
        resumed === 0
          ? 'No held messages were waiting.'
          : `Resumed ${resumed} held message${resumed === 1 ? '' : 's'}.`,
      );
      return true;
    }

    if (command === '/retry') {
      const retried = await this.store.retryLatestAmbiguous(job.conversationKey);
      await this.completeCommand(
        job,
        retried
          ? 'Retrying the latest ambiguous delivery. A duplicate is possible.'
          : 'No ambiguous delivery is waiting.',
      );
      return true;
    }

    return false;
  }

  private completeCommand(
    job: StoredIMessageInbound,
    reply: string,
  ): Promise<void> {
    return this.store.completeInboundWithReply(
      job.messageId,
      chunkIMessageText(reply),
    );
  }

  private async handleModelFailure(
    job: StoredIMessageInbound,
    error: unknown,
  ): Promise<void> {
    const failure = classifyModelFailure(error);
    this.setModelReadiness('failed', failure.code);
    const health = await this.store.getHealth();
    await this.store.patchHealth({
      lastModelErrorCode: failure.code,
      consecutiveModelFailures: health.consecutiveModelFailures + 1,
    });

    if (this.stopping) {
      await this.store.retryInbound(
        job.messageId,
        'runtime_stopping',
        this.timestamp(),
      );
      return;
    }

    if (!failure.permanent && job.attempts < this.maxModelAttempts) {
      await this.store.retryInbound(
        job.messageId,
        failure.code,
        new Date(
          this.now() + this.backoff(job.attempts, this.workerIntervalMs),
        ).toISOString(),
      );
      return;
    }

    await this.store.completeInboundWithReply(
      job.messageId,
      [
        'The assistant is temporarily unavailable. Your message was recorded; send /status for details.',
      ],
      { errorCode: failure.code },
    );
  }

  private async deliverChunk(chunk: StoredIMessageOutboxChunk): Promise<void> {
    if (!this.channel.connected) {
      await this.retryPreSend(chunk, 'transport_disconnected');
      void this.ensureConnected();
      return;
    }

    let prepared: IMessagePreparedSend;
    try {
      prepared = await this.channel.prepareSend(chunk.target, {
        channel: 'imessage',
        content: chunk.content,
        replyTo: chunk.inboundId,
        metadata: {
          canonicalChatGuid: chunk.chatGuid,
          replyTarget: chunk.target,
        },
      });
    } catch {
      await this.retryPreSend(chunk, 'private_payload_unavailable');
      return;
    }

    let preSendRowId: number;
    try {
      preSendRowId = await this.channel.getCurrentMaxRowId();
    } catch {
      await prepared.cancel();
      await this.retryPreSend(chunk, 'database_cursor_unavailable');
      return;
    }

    try {
      await this.store.markOutboxSending(chunk.id, preSendRowId);
    } catch (error) {
      await prepared.cancel();
      throw error;
    }
    try {
      await prepared.send();
    } catch {
      const health = await this.store.getHealth();
      await this.store.patchHealth({
        lastSendErrorCode: 'send_invocation_failed',
        consecutiveSendFailures: health.consecutiveSendFailures + 1,
      });
    }

    await this.reconcileChunk({
      ...chunk,
      status: 'sending',
      preSendRowId,
      updatedAt: this.timestamp(),
    });
  }

  private async reconcileSending(): Promise<void> {
    const sending = await this.store.listSendingOutbox();
    await Promise.all(sending.map(chunk => this.reconcileChunk(chunk)));
  }

  private async reconcileChunk(
    chunk: StoredIMessageOutboxChunk,
  ): Promise<void> {
    if (chunk.preSendRowId === null) {
      await this.store.markOutboxAmbiguous(
        chunk.id,
        'send_boundary_missing',
      );
      return;
    }

    try {
      const confirmedRowId = await this.channel.findSentMessage({
        afterRowId: chunk.preSendRowId,
        chatGuid: chunk.chatGuid,
        target: chunk.target,
        content: chunk.content,
      });
      if (confirmedRowId !== null) {
        await this.store.confirmOutbox(chunk.id, confirmedRowId);
        await this.store.patchHealth({
          lastSendSuccessAt: this.timestamp(),
          lastSendErrorCode: undefined,
          consecutiveSendFailures: 0,
        });
        return;
      }
    } catch {
      const health = await this.store.getHealth();
      await this.store.patchHealth({
        lastSendErrorCode: 'send_confirmation_failed',
        consecutiveSendFailures: health.consecutiveSendFailures + 1,
      });
      const sendingAge = this.now() - Date.parse(chunk.updatedAt);
      if (
        Number.isFinite(sendingAge)
        && sendingAge >= this.confirmationGraceMs
      ) {
        await this.store.markOutboxAmbiguous(
          chunk.id,
          'send_confirmation_unavailable',
        );
      }
      return;
    }

    const sendingAge = this.now() - Date.parse(chunk.updatedAt);
    if (
      Number.isFinite(sendingAge)
      && sendingAge >= this.confirmationGraceMs
    ) {
      await this.store.markOutboxAmbiguous(chunk.id, 'send_unconfirmed');
    }
  }

  private async retryPreSend(
    chunk: StoredIMessageOutboxChunk,
    errorCode: string,
  ): Promise<void> {
    const health = await this.store.getHealth();
    await this.store.patchHealth({
      lastSendErrorCode: errorCode,
      consecutiveSendFailures: health.consecutiveSendFailures + 1,
    });
    await this.store.retryOutbox(
      chunk.id,
      errorCode,
      new Date(
        this.now() + this.backoff(chunk.attempts, this.workerIntervalMs),
      ).toISOString(),
    );
  }

  private async ensureConnected(): Promise<void> {
    if (!this.running || this.channel.connected) return;
    if (this.connecting) return this.connecting;

    const operation = (async () => {
      try {
        await this.channel.connect();
        this.reconnectAttempts = 0;
        await this.store.patchHealth({
          lastConnectedAt: this.timestamp(),
          lastConnectionErrorCode: undefined,
          consecutiveConnectionFailures: 0,
        });
        runtimeLog.info('iMessage transport connected');
      } catch (error) {
        const errorCode = classifyIMessageConnectionFailure(error);
        this.reconnectAttempts++;
        const health = await this.store.getHealth();
        await this.store.patchHealth({
          lastConnectionErrorCode: errorCode,
          consecutiveConnectionFailures:
            health.consecutiveConnectionFailures + 1,
        });
        runtimeLog.warn('iMessage transport connection failed', {
          code: errorCode,
        });
        this.scheduleReconnect();
      }
    })();
    this.connecting = operation;
    try {
      await operation;
    } finally {
      if (this.connecting === operation) this.connecting = null;
    }
  }

  private scheduleReconnect(): void {
    if (
      !this.running
      || this.channel.connected
      || this.reconnectTimer !== undefined
    ) {
      return;
    }
    const delay = this.backoff(
      this.reconnectAttempts,
      this.reconnectBaseMs,
    );
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = undefined;
      void this.ensureConnected();
    }, delay);
  }

  private restoreConversation(
    key: string,
    messages: readonly AssistantConversationMessage[],
  ): void {
    if (messages.length > 0) {
      this.assistant.importConversation(key, messages);
    } else {
      this.assistant.clearConversation(key);
    }
  }

  private backoff(attempt: number, base: number): number {
    const exponent = Math.max(0, Math.min(8, attempt - 1));
    const bounded = Math.min(this.maxBackoffMs, base * (2 ** exponent));
    const jitter = Math.floor(bounded * 0.2 * this.random());
    return Math.min(this.maxBackoffMs, bounded + jitter);
  }

  private timestamp(): string {
    const value = this.now();
    return new Date(Number.isFinite(value) ? value : Date.now()).toISOString();
  }
}

function boundedPositive(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) return fallback;
  return Math.floor(value!);
}

function classifyModelFailure(error: unknown): ModelFailure {
  if (!(error instanceof Error)) {
    return { code: 'model_failed', permanent: false };
  }
  switch (error.message) {
    case 'Copilot CLI token is not configured':
      return { code: 'model_auth_missing', permanent: true };
    case 'Copilot CLI home is unavailable':
      return { code: 'model_home_unavailable', permanent: true };
    case 'Copilot CLI request timed out':
      return { code: 'model_timeout', permanent: false };
    case 'Copilot CLI returned an empty response':
      return { code: 'model_empty_response', permanent: false };
    default:
      return { code: 'model_failed', permanent: false };
  }
}
