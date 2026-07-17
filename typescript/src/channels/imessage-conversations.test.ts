import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type {
  AssistantConversationMessage,
  AssistantResponse,
} from '../agents/Assistant.js';
import {
  ConversationTurnQueue,
  IMessageConversationService,
  type IMessageAssistant,
  type IMessageConversationState,
  type IMessageReplyChannel,
} from './imessage-conversations.js';
import { PrivateJsonFileStore, type JsonStore } from './private-json-store.js';
import type { IncomingMessage, OutgoingMessage } from './types.js';

class MemoryStore<T> implements JsonStore<T> {
  value: T | null;
  readonly saves: T[] = [];

  constructor(value: T | null = null) {
    this.value = value;
  }

  async load(): Promise<T | null> {
    return this.value === null ? null : structuredClone(this.value);
  }

  async save(value: T): Promise<void> {
    this.value = structuredClone(value);
    this.saves.push(structuredClone(value));
  }
}

class FakeAssistant implements IMessageAssistant {
  readonly histories = new Map<string, AssistantConversationMessage[]>();
  readonly calls: Array<{
    key: string;
    message: string;
    prior: AssistantConversationMessage[];
  }> = [];
  readonly imports: string[] = [];
  readonly clears: string[] = [];

  constructor(
    private readonly respond: (
      message: string,
      key: string,
      callIndex: number,
    ) => Promise<string> = async message => `reply:${message}`,
  ) {}

  async getResponse(
    message: string,
    _onDelta?: (text: string) => void,
    _memoryContext?: string,
    conversationKey = 'default',
  ): Promise<AssistantResponse> {
    const history = this.histories.get(conversationKey) ?? [];
    this.calls.push({
      key: conversationKey,
      message,
      prior: structuredClone(history),
    });
    history.push({ role: 'user', content: message });
    this.histories.set(conversationKey, history);
    const content = await this.respond(message, conversationKey, this.calls.length - 1);
    history.push({ role: 'assistant', content });
    return { content, agentLogs: [] };
  }

  clearConversation(key: string): void {
    this.clears.push(key);
    this.histories.delete(key);
  }

  exportConversation(key: string): AssistantConversationMessage[] {
    return structuredClone(this.histories.get(key) ?? []).slice(-40);
  }

  importConversation(
    key: string,
    messages: readonly AssistantConversationMessage[],
  ): void {
    this.imports.push(key);
    this.histories.set(key, structuredClone(messages).slice(-40));
  }
}

class FakeChannel implements IMessageReplyChannel {
  readonly sent: Array<{ target: string; message: OutgoingMessage }> = [];

  constructor(private failuresRemaining = 0) {}

  async send(target: string, message: OutgoingMessage): Promise<void> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining--;
      throw new Error('send failed');
    }
    this.sent.push({ target, message: structuredClone(message) });
  }
}

function incoming(
  content: string,
  chatGuid = 'iMessage;-;chat-a',
  replyTarget = '+15551234567',
): IncomingMessage {
  return {
    id: `message-${content}`,
    channel: 'imessage',
    sender: '+15551234567',
    conversationId: chatGuid,
    content,
    timestamp: '2026-01-01T00:00:00.000Z',
    metadata: {
      canonicalChatGuid: chatGuid,
      replyTarget,
    },
  };
}

describe('ConversationTurnQueue', () => {
  it('serializes one chat, allows other chats to run, and recovers after failure', async () => {
    const queue = new ConversationTurnQueue();
    const events: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>(resolve => {
      releaseA = resolve;
    });

    const firstA = queue.run('a', async () => {
      events.push('a1:start');
      await gateA;
      events.push('a1:fail');
      throw new Error('expected failure');
    });
    const secondA = queue.run('a', async () => {
      events.push('a2');
      return 'recovered';
    });
    const firstB = queue.run('b', async () => {
      events.push('b1');
      return 'parallel';
    });

    await new Promise<void>(resolve => setImmediate(resolve));
    expect(events).toEqual(['a1:start', 'b1']);
    releaseA();

    await expect(firstA).rejects.toThrow('expected failure');
    await expect(secondA).resolves.toBe('recovered');
    await expect(firstB).resolves.toBe('parallel');
    expect(events).toEqual(['a1:start', 'b1', 'a1:fail', 'a2']);
  });
});

describe('IMessageConversationService', () => {
  it('serializes quick messages and does not poison the thread after a failed turn', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const assistant = new FakeAssistant(async message => {
      if (message === 'first') {
        await firstGate;
        throw new Error('model unavailable');
      }
      return `ok:${message}`;
    });
    const channel = new FakeChannel();
    const service = new IMessageConversationService({
      assistant,
      channel,
      store: new MemoryStore<IMessageConversationState>(),
    });

    const first = service.handleMessage(incoming('first'));
    const second = service.handleMessage(incoming('second'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(assistant.calls.map(call => call.message)).toEqual(['first']);

    releaseFirst();
    await expect(first).rejects.toThrow('model unavailable');
    await expect(second).resolves.toBeUndefined();

    expect(assistant.calls.map(call => call.message)).toEqual(['first', 'second']);
    expect(assistant.calls[1].prior).toEqual([]);
    expect(channel.sent.map(entry => entry.message.content)).toEqual(['ok:second']);
  });

  it('keeps chat histories isolated, bounded, and restorable after restart', async () => {
    let now = 1_700_000_000_000;
    const store = new MemoryStore<IMessageConversationState>();
    const firstAssistant = new FakeAssistant();
    const firstService = new IMessageConversationService({
      assistant: firstAssistant,
      channel: new FakeChannel(),
      store,
      now: () => now++,
    });

    for (let index = 0; index < 22; index++) {
      await firstService.handleMessage(incoming(`a-${index}`));
    }
    await firstService.handleMessage(
      incoming('b-0', 'iMessage;-;chat-b', '+15557654321'),
    );

    const persisted = store.value!;
    const chatA = persisted.conversations['imessage:iMessage;-;chat-a'];
    const chatB = persisted.conversations['imessage:iMessage;-;chat-b'];
    expect(chatA.messages).toHaveLength(40);
    expect(chatB.messages).toHaveLength(2);
    expect(chatA.messages.every(message => ['user', 'assistant'].includes(message.role))).toBe(true);
    expect(chatA.messages.some(message => message.content === 'a-0')).toBe(false);
    expect(chatB.messages.map(message => message.content)).toEqual(['b-0', 'reply:b-0']);

    const restartedAssistant = new FakeAssistant();
    const restartedChannel = new FakeChannel();
    const restartedService = new IMessageConversationService({
      assistant: restartedAssistant,
      channel: restartedChannel,
      store,
    });
    await restartedService.initialize();

    expect(restartedAssistant.imports.sort()).toEqual([
      'imessage:iMessage;-;chat-a',
      'imessage:iMessage;-;chat-b',
    ]);
    await restartedService.handleMessage(incoming('after-restart'));
    expect(restartedAssistant.calls[0].key).toBe('imessage:iMessage;-;chat-a');
    expect(restartedAssistant.calls[0].prior).toHaveLength(40);
    expect(
      restartedAssistant.calls[0].prior.some(message => message.content === 'b-0'),
    ).toBe(false);
  });

  it('replays a persisted ready reply after send failure without another model call', async () => {
    const store = new MemoryStore<IMessageConversationState>();
    const firstAssistant = new FakeAssistant();
    const firstService = new IMessageConversationService({
      assistant: firstAssistant,
      channel: new FakeChannel(1),
      store,
    });
    const message = incoming('retry-me');

    await expect(firstService.handleMessage(message)).rejects.toThrow('send failed');
    expect(firstAssistant.calls).toHaveLength(1);
    expect(store.value?.deliveries[message.id]).toMatchObject({
      status: 'ready',
      reply: {
        target: '+15551234567',
        content: 'reply:retry-me',
        replyTo: message.id,
      },
    });
    expect(
      store.saves.map(state => state.deliveries[message.id]?.status),
    ).toEqual(['ready', 'sending', 'ready']);

    const restartedAssistant = new FakeAssistant();
    const restartedChannel = new FakeChannel();
    const restartedService = new IMessageConversationService({
      assistant: restartedAssistant,
      channel: restartedChannel,
      store,
    });
    await restartedService.initialize();
    await restartedService.handleMessage(message);

    expect(restartedAssistant.calls).toHaveLength(0);
    expect(restartedChannel.sent).toEqual([
      expect.objectContaining({
        target: '+15551234567',
        message: expect.objectContaining({
          content: 'reply:retry-me',
          replyTo: message.id,
        }),
      }),
    ]);
    expect(store.value?.deliveries[message.id]?.status).toBe('sent');
  });

  it('treats a sent inbound GUID as a no-op', async () => {
    const assistant = new FakeAssistant();
    const channel = new FakeChannel();
    const service = new IMessageConversationService({
      assistant,
      channel,
      store: new MemoryStore<IMessageConversationState>(),
    });
    const message = incoming('once');

    await service.handleMessage(message);
    await service.handleMessage(message);

    expect(assistant.calls).toHaveLength(1);
    expect(channel.sent).toHaveLength(1);
  });

  it('does not resend a delivery left sending across the AppleScript crash boundary', async () => {
    const message = incoming('ambiguous');
    const store = new MemoryStore<IMessageConversationState>({
      version: 1,
      conversations: {},
      deliveries: {
        [message.id]: {
          status: 'sending',
          updatedAt: '2026-01-01T00:00:00.000Z',
          conversationKey: 'imessage:iMessage;-;chat-a',
          reply: {
            target: '+15551234567',
            content: 'saved reply',
            replyTo: message.id,
          },
        },
      },
    });
    const assistant = new FakeAssistant();
    const channel = new FakeChannel();
    const service = new IMessageConversationService({
      assistant,
      channel,
      store,
    });

    await service.handleMessage(message);

    expect(assistant.calls).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
    expect(store.value?.deliveries[message.id]?.status).toBe('sending');
  });

  it('clears Assistant history after successfully pruning an old conversation', async () => {
    let now = 1_700_000_000_000;
    const assistant = new FakeAssistant();
    const store = new MemoryStore<IMessageConversationState>();
    const service = new IMessageConversationService({
      assistant,
      channel: new FakeChannel(),
      store,
      now: () => now++,
    });

    for (let index = 0; index < 101; index++) {
      await service.handleMessage(
        incoming(
          `conversation-${index}`,
          `iMessage;-;chat-${index}`,
        ),
      );
    }

    const oldestKey = 'imessage:iMessage;-;chat-0';
    expect(Object.keys(store.value?.conversations ?? {})).toHaveLength(100);
    expect(store.value?.conversations[oldestKey]).toBeUndefined();
    expect(assistant.histories.has(oldestKey)).toBe(false);
    expect(assistant.clears).toContain(oldestKey);
  });

  it('handles status, help, and reset commands before model invocation', async () => {
    const assistant = new FakeAssistant();
    const channel = new FakeChannel();
    const store = new MemoryStore<IMessageConversationState>();
    const service = new IMessageConversationService({ assistant, channel, store });

    await service.handleMessage(incoming('hello'));
    await service.handleMessage(incoming('/status'));
    await service.handleMessage(incoming('/help'));
    await service.handleMessage(incoming('/reset'));
    await service.handleMessage(incoming('/new'));

    expect(assistant.calls.map(call => call.message)).toEqual(['hello']);
    expect(channel.sent.map(entry => entry.message.content)).toEqual([
      'reply:hello',
      'OpenRappter iMessage is online. This chat has 2 saved conversation messages.',
      'Commands: /status, /reset (or /new), /help. Other messages continue this private chat.',
      'Started a new conversation.',
      'Started a new conversation.',
    ]);
    expect(assistant.exportConversation('imessage:iMessage;-;chat-a')).toEqual([]);
    expect(store.value?.conversations).toEqual({});
  });

  it('requires an explicit reply target in authorized channel metadata', async () => {
    const assistant = new FakeAssistant();
    const service = new IMessageConversationService({
      assistant,
      channel: new FakeChannel(),
      store: new MemoryStore<IMessageConversationState>(),
    });
    const message = incoming('hello');
    delete message.metadata?.replyTarget;

    await expect(service.handleMessage(message)).rejects.toThrow(/reply target/);
    expect(assistant.calls).toHaveLength(0);
  });
});

describe('PrivateJsonFileStore', () => {
  it('writes atomic private JSON with private directory and file modes', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), '.imessage-store-test-'));
    const directory = path.join(root, 'private');
    const filePath = path.join(directory, 'state.json');

    try {
      const store = new PrivateJsonFileStore<{ value: string }>(filePath);
      await store.save({ value: 'first' });
      await store.save({ value: 'second' });

      expect(await store.load()).toEqual({ value: 'second' });
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await fs.readdir(directory)).sort()).toEqual(['state.json']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
