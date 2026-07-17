import { describe, expect, it } from 'vitest';
import type {
  AssistantConversationMessage,
  AssistantResponse,
} from '../agents/Assistant.js';
import type {
  DurableIMessageAssistant,
  DurableIMessageChannel,
} from './imessage-runtime.js';
import { IMessageRuntime } from './imessage-runtime.js';
import {
  IMessageStateStore,
  type IMessagePersistentHealth,
} from './imessage-state-store.js';
import type {
  IMessagePreparedSend,
  IMessageTransportHealth,
} from './imessage.js';
import type { IncomingMessage, OutgoingMessage } from './types.js';

const START = Date.parse('2026-07-16T22:00:00.000Z');

class FakeAssistant implements DurableIMessageAssistant {
  readonly histories = new Map<string, AssistantConversationMessage[]>();
  readonly calls: string[] = [];
  failures: Error[] = [];
  readonly responseGates = new Map<string, Promise<void>>();

  async getResponse(
    message: string,
    _onDelta?: (text: string) => void,
    _memoryContext?: string,
    conversationKey = 'default',
    signal?: AbortSignal,
  ): Promise<AssistantResponse> {
    this.calls.push(message);
    const history = this.histories.get(conversationKey) ?? [];
    history.push({ role: 'user', content: message });
    this.histories.set(conversationKey, history);
    const failure = this.failures.shift();
    if (failure) throw failure;
    const gate = this.responseGates.get(message);
    if (gate) {
      await Promise.race([
        gate,
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new Error('Copilot CLI request aborted'));
          }, { once: true });
        }),
      ]);
    }
    const content = `reply:${message}`;
    history.push({ role: 'assistant', content });
    return { content, agentLogs: [] };
  }

  clearConversation(key: string): void {
    this.histories.delete(key);
  }

  exportConversation(key: string): AssistantConversationMessage[] {
    return structuredClone(this.histories.get(key) ?? []);
  }

  importConversation(
    key: string,
    messages: readonly AssistantConversationMessage[],
  ): void {
    this.histories.set(
      key,
      messages.map(message => ({ ...message })),
    );
  }
}

class FakeChannel implements DurableIMessageChannel {
  connected = true;
  connectFailures = 0;
  confirmSends = true;
  throwAfterPersist = false;
  confirmationFailures = 0;
  rejectPersistedTargets = false;
  prepareFailures = 0;
  maxRowId = 100;
  readonly sent: Array<{
    target: string;
    message: OutgoingMessage;
    rowId?: number;
  }> = [];
  private handlers: Array<() => Promise<void>> = [];

  async connect(): Promise<void> {
    if (this.connectFailures > 0) {
      this.connectFailures--;
      throw new Error('connect failed');
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  onMessage(handler: () => Promise<void>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter(candidate => candidate !== handler);
    };
  }

  async send(target: string, message: OutgoingMessage): Promise<void> {
    if (!this.connected) throw new Error('disconnected');
    const entry = {
      target,
      message: structuredClone(message),
      rowId: this.confirmSends ? ++this.maxRowId : undefined,
    };
    this.sent.push(entry);
    if (this.throwAfterPersist) throw new Error('ambiguous send result');
  }

  async prepareSend(
    target: string,
    message: OutgoingMessage,
  ): Promise<IMessagePreparedSend> {
    if (this.prepareFailures > 0) {
      this.prepareFailures--;
      throw new Error('private payload unavailable');
    }
    return {
      send: () => this.send(target, message),
      cancel: async () => undefined,
    };
  }

  authorizePersistedReplyTarget(_target: string): void {
    if (this.rejectPersistedTargets) {
      throw new Error('target no longer allowed');
    }
  }

  async getCurrentMaxRowId(): Promise<number> {
    return this.maxRowId;
  }

  async findSentMessage(options: {
    afterRowId: number;
    chatGuid: string;
    target: string;
    content: string;
  }): Promise<number | null> {
    if (this.confirmationFailures > 0) {
      this.confirmationFailures--;
      throw new Error('confirmation unavailable');
    }
    const match = this.sent.find(entry =>
      entry.rowId !== undefined
      && entry.rowId > options.afterRowId
      && entry.target === options.target
      && entry.message.content === options.content
      && entry.message.metadata?.canonicalChatGuid === options.chatGuid
    );
    return match?.rowId ?? null;
  }

  getTransportHealth(): IMessageTransportHealth {
    return {
      connected: this.connected,
      consecutivePollFailures: 0,
      cursor: 0,
      databaseMaxRowId: this.maxRowId,
      cursorLag: 0,
      lastPollSuccessAt: new Date(START).toISOString(),
    };
  }
}

function message(
  id: string,
  rowId: number,
  content: string,
  timestamp = new Date(START - 1_000).toISOString(),
): IncomingMessage {
  return {
    id,
    channel: 'imessage',
    conversationId: 'iMessage;-;chat-a',
    sender: '+15551234567',
    content,
    timestamp,
    metadata: {
      canonicalChatGuid: 'iMessage;-;chat-a',
      replyTarget: '+15551234567',
      rowId,
    },
  };
}

async function harness(options: {
  now?: () => number;
  channel?: FakeChannel;
  assistant?: FakeAssistant;
  confirmationGraceMs?: number;
} = {}) {
  const store = new IMessageStateStore({
    databasePath: ':memory:',
    now: options.now ?? (() => START),
    staleAfterMs: 30 * 60 * 1000,
  });
  const assistant = options.assistant ?? new FakeAssistant();
  const channel = options.channel ?? new FakeChannel();
  const runtime = new IMessageRuntime({
    assistant,
    channel,
    store,
    now: options.now ?? (() => START),
    random: () => 0,
    workerIntervalMs: 1_000,
    confirmationGraceMs: options.confirmationGraceMs ?? 30_000,
  });
  await runtime.initialize();
  await store.prepareAppleCursor(0);
  return { store, assistant, channel, runtime };
}

describe('IMessageRuntime durable processing', () => {
  it('runs inference once and confirms a durable reply', async () => {
    const { store, assistant, channel, runtime } = await harness();
    await store.ingestAppleRow(1, message('one', 1, 'hello'));

    await runtime.processNow();

    expect(assistant.calls).toEqual(['hello']);
    expect(channel.sent.map(entry => entry.message.content)).toEqual([
      'reply:hello',
    ]);
    expect(await store.getInbound('one')).toMatchObject({
      status: 'completed',
      attempts: 1,
    });
    expect(await store.getOutbox('one:0')).toMatchObject({
      status: 'confirmed',
      confirmedRowId: 101,
    });
    await runtime.stop();
  });

  it('retries a transient model failure without poisoning conversation history', async () => {
    let now = START;
    const assistant = new FakeAssistant();
    assistant.failures.push(new Error('Copilot CLI request timed out'));
    const { store, runtime } = await harness({
      assistant,
      now: () => now,
    });
    await store.ingestAppleRow(1, message('retry', 1, 'hello'));

    await runtime.processNow();
    expect(await store.getInbound('retry')).toMatchObject({
      status: 'retry_wait',
      attempts: 1,
      errorCode: 'model_timeout',
    });
    expect(assistant.exportConversation('imessage:iMessage;-;chat-a')).toEqual([]);

    now += 1_000;
    await runtime.processNow();
    expect(assistant.calls).toEqual(['hello', 'hello']);
    expect(await store.getInbound('retry')).toMatchObject({
      status: 'completed',
      attempts: 2,
    });
    await runtime.stop();
  });

  it('turns a permanent model failure into a visible terminal response', async () => {
    const assistant = new FakeAssistant();
    assistant.failures.push(new Error('Copilot CLI token is not configured'));
    const { store, channel, runtime } = await harness({ assistant });
    await store.ingestAppleRow(1, message('auth', 1, 'hello'));

    await runtime.processNow();

    expect(assistant.calls).toEqual(['hello']);
    expect(channel.sent[0].message.content).toContain(
      'assistant is temporarily unavailable',
    );
    expect(await store.getInbound('auth')).toMatchObject({
      status: 'completed',
      errorCode: 'model_auth_missing',
    });
    const health: IMessagePersistentHealth = await store.getHealth();
    expect(health).toMatchObject({
      lastModelErrorCode: 'model_auth_missing',
      consecutiveModelFailures: 1,
    });
    await runtime.start();
    expect(await runtime.getStatus()).toMatchObject({
      state: 'degraded',
      reason: 'model_auth_missing',
    });
    await runtime.stop();
  });

  it('holds stale work until /resume and then processes it in order', async () => {
    const { store, assistant, channel, runtime } = await harness();
    await store.ingestAppleRow(1, message(
      'stale',
      1,
      'old question',
      new Date(START - 3 * 24 * 60 * 60 * 1000).toISOString(),
    ));
    await store.ingestAppleRow(2, message('resume', 2, '/resume'));

    await runtime.processNow();

    expect(assistant.calls).toEqual(['old question']);
    expect(channel.sent.map(entry => entry.message.content)).toEqual([
      'reply:old question',
      'Resumed 1 held message.',
    ]);
    expect(await store.getInbound('stale')).toMatchObject({ status: 'completed' });
    expect(await store.getInbound('resume')).toMatchObject({ status: 'completed' });
    await runtime.stop();
  });

  it('delivers a fast chat while another chat is still waiting on inference', async () => {
    let releaseSlow!: () => void;
    const assistant = new FakeAssistant();
    assistant.responseGates.set(
      'slow',
      new Promise<void>(resolve => {
        releaseSlow = resolve;
      }),
    );
    const { store, channel, runtime } = await harness({ assistant });
    await store.ingestAppleRow(1, message('slow-id', 1, 'slow'));
    const fast = message('fast-id', 2, 'fast');
    fast.conversationId = 'iMessage;-;chat-b';
    fast.sender = '+15557654321';
    fast.metadata = {
      canonicalChatGuid: 'iMessage;-;chat-b',
      replyTarget: '+15557654321',
      rowId: 2,
    };
    await store.ingestAppleRow(2, fast);

    const processing = runtime.processNow();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(channel.sent.map(entry => entry.message.content)).toEqual([
      'reply:fast',
    ]);

    releaseSlow();
    await processing;
    expect(channel.sent.map(entry => entry.message.content).sort()).toEqual([
      'reply:fast',
      'reply:slow',
    ]);
    await runtime.stop();
  });
});

describe('IMessageRuntime delivery ambiguity', () => {
  it('retries a definitive private-payload failure before entering sending', async () => {
    let now = START;
    const channel = new FakeChannel();
    channel.prepareFailures = 1;
    const { store, runtime } = await harness({
      channel,
      now: () => now,
    });
    await store.ingestAppleRow(1, message('prepare-retry', 1, 'hello'));

    await runtime.processNow();
    expect(channel.sent).toHaveLength(0);
    expect(await store.getOutbox('prepare-retry:0')).toMatchObject({
      status: 'retry_wait',
      errorCode: 'private_payload_unavailable',
    });

    now += 1_000;
    await runtime.processNow();
    expect(channel.sent).toHaveLength(1);
    expect(await store.getInbound('prepare-retry')).toMatchObject({
      status: 'completed',
    });
    await runtime.stop();
  });

  it('does not resend an unconfirmed send and marks it ambiguous after grace', async () => {
    let now = START;
    const channel = new FakeChannel();
    channel.confirmSends = false;
    const { store, runtime } = await harness({
      channel,
      now: () => now,
      confirmationGraceMs: 1_000,
    });
    await store.ingestAppleRow(1, message('ambiguous', 1, 'hello'));

    await runtime.processNow();
    expect(channel.sent).toHaveLength(1);
    expect(await store.getOutbox('ambiguous:0')).toMatchObject({
      status: 'sending',
    });

    now += 1_001;
    await runtime.processNow();
    expect(channel.sent).toHaveLength(1);
    expect(await store.getOutbox('ambiguous:0')).toMatchObject({
      status: 'ambiguous',
      errorCode: 'send_unconfirmed',
    });
    expect(await store.getInbound('ambiguous')).toMatchObject({
      status: 'ambiguous',
    });
    await runtime.stop();
  });

  it('reconciles a send that persisted even when invocation reported failure', async () => {
    const channel = new FakeChannel();
    channel.throwAfterPersist = true;
    const { store, runtime } = await harness({ channel });
    await store.ingestAppleRow(1, message('reconciled', 1, 'hello'));

    await runtime.processNow();

    expect(channel.sent).toHaveLength(1);
    expect(await store.getOutbox('reconciled:0')).toMatchObject({
      status: 'confirmed',
    });
    expect(await store.getInbound('reconciled')).toMatchObject({
      status: 'completed',
    });
    await runtime.stop();
  });

  it('expires a sending chunk when confirmation stays unavailable', async () => {
    let now = START;
    const channel = new FakeChannel();
    channel.confirmSends = false;
    channel.confirmationFailures = 100;
    const { store, runtime } = await harness({
      channel,
      now: () => now,
      confirmationGraceMs: 1_000,
    });
    await store.ingestAppleRow(1, message('query-failure', 1, 'hello'));

    await runtime.processNow();
    expect(await store.getOutbox('query-failure:0')).toMatchObject({
      status: 'sending',
    });

    now += 1_001;
    await runtime.processNow();
    expect(await store.getOutbox('query-failure:0')).toMatchObject({
      status: 'ambiguous',
      errorCode: 'send_confirmation_unavailable',
    });
    await runtime.stop();
  });

  it('quarantines persisted work for a removed allowlist target', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      now: () => START,
    });
    await store.initialize();
    await store.prepareAppleCursor(0);
    await store.ingestAppleRow(1, message('removed-target', 1, 'hello'));
    await store.claimReadyInbound(new Date(START).toISOString());
    await store.completeInboundWithReply('removed-target', ['saved reply']);
    const channel = new FakeChannel();
    channel.rejectPersistedTargets = true;
    const runtime = new IMessageRuntime({
      assistant: new FakeAssistant(),
      channel,
      store,
      now: () => START,
    });

    await expect(runtime.initialize()).resolves.toBeUndefined();
    expect(await store.getOutbox('removed-target:0')).toMatchObject({
      status: 'dead_letter',
      errorCode: 'target_no_longer_allowed',
    });
    expect(await store.getInbound('removed-target')).toMatchObject({
      status: 'dead_letter',
    });
    await runtime.stop();
  });
});

describe('IMessageRuntime connection recovery', () => {
  it('aborts active inference during shutdown', async () => {
    const assistant = new FakeAssistant();
    assistant.responseGates.set('never-finishes', new Promise<void>(() => {}));
    const { store, runtime } = await harness({ assistant });
    await store.ingestAppleRow(
      1,
      message('shutdown-abort', 1, 'never-finishes'),
    );

    const processing = runtime.processNow();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    const startedAt = Date.now();
    await runtime.stop();
    await processing;

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(assistant.calls).toEqual(['never-finishes']);
  });

  it('keeps readiness degraded until the isolated model probe succeeds', async () => {
    const { runtime } = await harness();
    runtime.setModelReadiness('pending', 'model_preflight_pending');
    await runtime.start();

    expect(await runtime.getStatus()).toMatchObject({
      state: 'degraded',
      reason: 'model_preflight_pending',
      modelReadiness: 'pending',
    });
    runtime.setModelReadiness('ready');
    expect(await runtime.getStatus()).toMatchObject({
      state: 'online',
      modelReadiness: 'ready',
    });
    await runtime.stop();
  });

  it('backs off a failed startup connection and reconnects', async () => {
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const channel = new FakeChannel();
    channel.connected = false;
    channel.connectFailures = 1;
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      now: () => START,
    });
    const runtime = new IMessageRuntime({
      assistant: new FakeAssistant(),
      channel,
      store,
      now: () => START,
      random: () => 0,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      cancelSchedule: () => undefined,
      reconnectBaseMs: 1_000,
    });

    await runtime.start();
    expect(channel.connected).toBe(false);
    expect((await runtime.getStatus()).state).toBe('offline');
    const reconnect = scheduled.find(entry => entry.delay === 1_000);
    expect(reconnect).toBeDefined();

    reconnect!.callback();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(channel.connected).toBe(true);
    await runtime.stop();
  });
});
