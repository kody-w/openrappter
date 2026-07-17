import os from 'os';
import path from 'path';
import type {
  AssistantConversationMessage,
  AssistantResponse,
} from '../agents/Assistant.js';
import { PrivateJsonFileStore, type JsonStore } from './private-json-store.js';
import type { IncomingMessage, OutgoingMessage } from './types.js';

const MAX_MESSAGES_PER_CONVERSATION = 40;
const MAX_CONVERSATIONS = 100;
const MAX_DELIVERIES = 500;

export interface IMessageAssistant {
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

export interface IMessageReplyChannel {
  send(conversationId: string, message: OutgoingMessage): Promise<void>;
}

export interface PersistedIMessageConversation {
  updatedAt: string;
  messages: AssistantConversationMessage[];
}

export interface PersistedIMessageDelivery {
  status: 'ready' | 'sending' | 'sent';
  updatedAt: string;
  conversationKey: string;
  reply: {
    target: string;
    content: string;
    replyTo: string;
  };
}

export interface IMessageConversationState {
  version: 1;
  conversations: Record<string, PersistedIMessageConversation>;
  deliveries: Record<string, PersistedIMessageDelivery>;
}

export interface IMessageConversationServiceOptions {
  assistant: IMessageAssistant;
  channel: IMessageReplyChannel;
  store?: JsonStore<IMessageConversationState>;
  homeDirectory?: string;
  now?: () => number;
}

export class ConversationTurnQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }

  async drain(): Promise<void> {
    await Promise.all(Array.from(this.tails.values()));
  }
}

function sanitizeMessages(value: unknown): AssistantConversationMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (message): message is AssistantConversationMessage =>
        Boolean(message)
        && typeof message === 'object'
        && (
          (message as { role?: unknown }).role === 'user'
          || (message as { role?: unknown }).role === 'assistant'
        )
        && typeof (message as { content?: unknown }).content === 'string',
    )
    .slice(-MAX_MESSAGES_PER_CONVERSATION)
    .map(message => ({ role: message.role, content: message.content }));
}

function sanitizeDelivery(value: unknown): PersistedIMessageDelivery | null {
  if (!value || typeof value !== 'object') return null;

  const candidate = value as {
    status?: unknown;
    updatedAt?: unknown;
    conversationKey?: unknown;
    reply?: unknown;
  };
  if (
    !['ready', 'sending', 'sent'].includes(String(candidate.status))
    || typeof candidate.updatedAt !== 'string'
    || typeof candidate.conversationKey !== 'string'
    || !candidate.conversationKey
    || !candidate.reply
    || typeof candidate.reply !== 'object'
  ) {
    return null;
  }

  const reply = candidate.reply as {
    target?: unknown;
    content?: unknown;
    replyTo?: unknown;
  };
  if (
    typeof reply.target !== 'string'
    || !reply.target
    || typeof reply.content !== 'string'
    || typeof reply.replyTo !== 'string'
    || !reply.replyTo
  ) {
    return null;
  }

  return {
    status: candidate.status as PersistedIMessageDelivery['status'],
    updatedAt: candidate.updatedAt,
    conversationKey: candidate.conversationKey,
    reply: {
      target: reply.target,
      content: reply.content,
      replyTo: reply.replyTo,
    },
  };
}

function parseConversationState(value: IMessageConversationState): IMessageConversationState {
  if (
    !value
    || typeof value !== 'object'
    || value.version !== 1
    || !value.conversations
    || typeof value.conversations !== 'object'
    || Array.isArray(value.conversations)
  ) {
    throw new Error('Invalid iMessage conversation state');
  }

  const conversations: Record<string, PersistedIMessageConversation> = {};
  for (const [key, entry] of Object.entries(value.conversations)) {
    if (
      !key
      || !entry
      || typeof entry !== 'object'
      || typeof entry.updatedAt !== 'string'
    ) {
      continue;
    }
    conversations[key] = {
      updatedAt: entry.updatedAt,
      messages: sanitizeMessages(entry.messages),
    };
  }

  const rawDeliveries = (value as { deliveries?: unknown }).deliveries;
  const deliveries: Record<string, PersistedIMessageDelivery> = {};
  if (
    rawDeliveries !== undefined
    && (
      !rawDeliveries
      || typeof rawDeliveries !== 'object'
      || Array.isArray(rawDeliveries)
    )
  ) {
    throw new Error('Invalid iMessage delivery state');
  }
  for (const [messageId, entry] of Object.entries(rawDeliveries ?? {})) {
    const delivery = sanitizeDelivery(entry);
    if (messageId && delivery) {
      deliveries[messageId] = delivery;
    }
  }

  return {
    version: 1,
    conversations: Object.fromEntries(
      Object.entries(conversations)
        .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt))
        .slice(0, MAX_CONVERSATIONS),
    ),
    deliveries: Object.fromEntries(
      Object.entries(deliveries)
        .sort((left, right) => {
          const pendingDifference =
            Number(right[1].status !== 'sent') - Number(left[1].status !== 'sent');
          return pendingDifference
            || right[1].updatedAt.localeCompare(left[1].updatedAt);
        })
        .slice(0, MAX_DELIVERIES),
    ),
  };
}

export class IMessageConversationService {
  private readonly assistant: IMessageAssistant;
  private readonly channel: IMessageReplyChannel;
  private readonly store: JsonStore<IMessageConversationState>;
  private readonly now: () => number;
  private readonly queue = new ConversationTurnQueue();
  private state: IMessageConversationState = {
    version: 1,
    conversations: {},
    deliveries: {},
  };
  private initialization: Promise<void> | null = null;
  private persistTail: Promise<void> = Promise.resolve();
  private lastTimestamp = 0;

  constructor(options: IMessageConversationServiceOptions) {
    const homeDirectory = options.homeDirectory ?? os.homedir();
    this.assistant = options.assistant;
    this.channel = options.channel;
    this.store =
      options.store
      ?? new PrivateJsonFileStore<IMessageConversationState>(
        path.join(homeDirectory, '.openrappter', 'imessage-conversations.json'),
      );
    this.now = options.now ?? Date.now;
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.load();
    }
    return this.initialization;
  }

  async handleMessage(message: IncomingMessage): Promise<void> {
    await this.initialize();

    const canonicalChatGuid = message.metadata?.canonicalChatGuid;
    const replyTarget = message.metadata?.replyTarget;
    if (
      typeof canonicalChatGuid !== 'string'
      || !canonicalChatGuid
      || typeof replyTarget !== 'string'
      || !replyTarget
    ) {
      throw new Error('iMessage metadata is missing a safe reply target');
    }

    const conversationKey = `imessage:${canonicalChatGuid}`;
    await this.queue.run(conversationKey, async () => {
      if (this.state.deliveries[message.id]) {
        await this.deliver(message.id);
        return;
      }

      const command = message.content.trim().split(/\s+/, 1)[0]?.toLowerCase();
      if (command === '/status') {
        const count = this.state.conversations[conversationKey]?.messages.length ?? 0;
        await this.saveReadyDelivery(
          message.id,
          conversationKey,
          replyTarget,
          `OpenRappter iMessage is online. This chat has ${count} saved conversation messages.`,
        );
        await this.deliver(message.id);
        return;
      }
      if (command === '/help') {
        await this.saveReadyDelivery(
          message.id,
          conversationKey,
          replyTarget,
          'Commands: /status, /reset (or /new), /help. Other messages continue this private chat.',
        );
        await this.deliver(message.id);
        return;
      }
      if (command === '/reset' || command === '/new') {
        await this.resetConversation(
          conversationKey,
          replyTarget,
          message.id,
        );
        return;
      }

      await this.runAssistantTurn(
        conversationKey,
        replyTarget,
        message.id,
        message.content,
      );
    });
  }

  async stop(): Promise<void> {
    await this.queue.drain();
    await this.persistTail;
  }

  private async load(): Promise<void> {
    const loaded = await this.store.load();
    if (loaded === null) return;

    this.state = parseConversationState(loaded);
    this.lastTimestamp = Math.max(
      0,
      ...Object.values(this.state.conversations)
        .map(conversation => Date.parse(conversation.updatedAt))
        .filter(Number.isFinite),
      ...Object.values(this.state.deliveries)
        .map(delivery => Date.parse(delivery.updatedAt))
        .filter(Number.isFinite),
    );
    for (const [key, conversation] of Object.entries(this.state.conversations)) {
      this.assistant.importConversation(key, conversation.messages);
    }
  }

  private async runAssistantTurn(
    conversationKey: string,
    replyTarget: string,
    messageId: string,
    content: string,
  ): Promise<void> {
    const previousMessages = this.assistant.exportConversation(conversationKey);
    let response: AssistantResponse;
    try {
      response = await this.assistant.getResponse(
        content,
        undefined,
        undefined,
        conversationKey,
      );
      const conversation: PersistedIMessageConversation = {
        updatedAt: this.nextTimestamp(),
        messages: this.assistant
          .exportConversation(conversationKey)
          .slice(-MAX_MESSAGES_PER_CONVERSATION),
      };
      const reply = response.content.trim()
        ? response.content
        : 'I could not produce a response. Please try again.';
      await this.commitState(nextState => {
        nextState.conversations[conversationKey] = conversation;
        nextState.deliveries[messageId] = this.createReadyDelivery(
          conversationKey,
          replyTarget,
          reply,
          messageId,
        );
      });
    } catch (error) {
      if (previousMessages.length > 0) {
        this.assistant.importConversation(conversationKey, previousMessages);
      } else {
        this.assistant.clearConversation(conversationKey);
      }
      throw error;
    }

    await this.deliver(messageId);
  }

  private async resetConversation(
    conversationKey: string,
    replyTarget: string,
    messageId: string,
  ): Promise<void> {
    const previousMessages = this.assistant.exportConversation(conversationKey);
    this.assistant.clearConversation(conversationKey);

    try {
      await this.commitState(nextState => {
        delete nextState.conversations[conversationKey];
        nextState.deliveries[messageId] = this.createReadyDelivery(
          conversationKey,
          replyTarget,
          'Started a new conversation.',
          messageId,
        );
      });
    } catch (error) {
      if (previousMessages.length > 0) {
        this.assistant.importConversation(conversationKey, previousMessages);
      }
      throw error;
    }

    await this.deliver(messageId);
  }

  private createReadyDelivery(
    conversationKey: string,
    target: string,
    content: string,
    replyTo: string,
  ): PersistedIMessageDelivery {
    return {
      status: 'ready',
      updatedAt: this.nextTimestamp(),
      conversationKey,
      reply: { target, content, replyTo },
    };
  }

  private async saveReadyDelivery(
    messageId: string,
    conversationKey: string,
    target: string,
    content: string,
  ): Promise<void> {
    await this.commitState(nextState => {
      nextState.deliveries[messageId] = this.createReadyDelivery(
        conversationKey,
        target,
        content,
        messageId,
      );
    });
  }

  private async deliver(messageId: string): Promise<void> {
    const delivery = this.state.deliveries[messageId];
    if (!delivery) {
      throw new Error('iMessage delivery state is missing');
    }
    if (delivery.status === 'sent' || delivery.status === 'sending') {
      return;
    }

    await this.commitState(nextState => {
      const current = nextState.deliveries[messageId];
      if (current?.status === 'ready') {
        current.status = 'sending';
        current.updatedAt = this.nextTimestamp();
      }
    });

    const sending = this.state.deliveries[messageId];
    if (!sending || sending.status !== 'sending') return;

    try {
      await this.reply(
        sending.reply.target,
        sending.reply.content,
        sending.reply.replyTo,
      );
    } catch (error) {
      await this.commitState(nextState => {
        const current = nextState.deliveries[messageId];
        if (current?.status === 'sending') {
          current.status = 'ready';
          current.updatedAt = this.nextTimestamp();
        }
      });
      throw error;
    }

    await this.commitState(nextState => {
      const current = nextState.deliveries[messageId];
      if (current?.status === 'sending') {
        current.status = 'sent';
        current.updatedAt = this.nextTimestamp();
      }
    });
  }

  private nextTimestamp(): string {
    const current = this.now();
    const timestamp = Number.isFinite(current) ? Math.floor(current) : Date.now();
    this.lastTimestamp = Math.max(timestamp, this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  }

  private pruneState(state: IMessageConversationState): string[] {
    const conversationEntries = Object.entries(state.conversations)
      .sort((left, right) => right[1].updatedAt.localeCompare(left[1].updatedAt));
    const evictedConversationKeys = conversationEntries
      .slice(MAX_CONVERSATIONS)
      .map(([key]) => key);
    state.conversations = Object.fromEntries(
      conversationEntries.slice(0, MAX_CONVERSATIONS),
    );

    state.deliveries = Object.fromEntries(
      Object.entries(state.deliveries)
        .sort((left, right) => {
          const pendingDifference =
            Number(right[1].status !== 'sent') - Number(left[1].status !== 'sent');
          return pendingDifference
            || right[1].updatedAt.localeCompare(left[1].updatedAt);
        })
        .slice(0, MAX_DELIVERIES),
    );
    return evictedConversationKeys;
  }

  private commitState(
    update: (state: IMessageConversationState) => void,
  ): Promise<void> {
    const operation = this.persistTail
      .catch(() => undefined)
      .then(async () => {
        const nextState = structuredClone(this.state);
        update(nextState);
        const evictedConversationKeys = this.pruneState(nextState);
        await this.store.save(nextState);
        this.state = nextState;
        for (const key of evictedConversationKeys) {
          this.assistant.clearConversation(key);
        }
      });
    this.persistTail = operation.catch(() => undefined);
    return operation;
  }

  private reply(target: string, content: string, replyTo: string): Promise<void> {
    return this.channel.send(target, {
      channel: 'imessage',
      content,
      replyTo,
      metadata: { replyTarget: target },
    });
  }
}
