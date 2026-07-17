import fs from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  IMessageStateStore,
  type StoredIMessageInbound,
} from './imessage-state-store.js';
import type { IncomingMessage } from './types.js';

const roots: string[] = [];
const NOW = Date.parse('2026-07-16T22:00:00.000Z');

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.imessage-sqlite-test-'));
  roots.push(root);
  return root;
}

function incoming(
  id: string,
  rowId: number,
  options: {
    chatGuid?: string;
    target?: string;
    timestamp?: string;
    content?: string;
  } = {},
): IncomingMessage {
  const chatGuid = options.chatGuid ?? 'iMessage;-;chat-a';
  const target = options.target ?? '+15551234567';
  return {
    id,
    channel: 'imessage',
    conversationId: chatGuid,
    sender: target,
    content: options.content ?? `message-${rowId}`,
    timestamp: options.timestamp ?? new Date(NOW - 1_000).toISOString(),
    metadata: {
      canonicalChatGuid: chatGuid,
      replyTarget: target,
      rowId,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('IMessageStateStore durable ingest', () => {
  it('advances ignored rows and atomically queues eligible rows', async () => {
    const root = await temporaryRoot();
    const store = new IMessageStateStore({
      homeDirectory: root,
      staleAfterMs: 30 * 60 * 1000,
      now: () => NOW,
    });
    await store.initialize();

    await expect(store.prepareAppleCursor(10)).resolves.toBe(10);
    await expect(store.ingestAppleRow(11, null)).resolves.toEqual({
      cursor: 11,
      inserted: false,
      status: 'ignored',
    });
    await expect(store.ingestAppleRow(12, incoming('fresh', 12))).resolves.toEqual({
      cursor: 12,
      inserted: true,
      status: 'queued',
    });
    await expect(store.ingestAppleRow(12, incoming('fresh', 12))).resolves.toEqual({
      cursor: 12,
      inserted: false,
      status: 'queued',
    });

    expect(await store.getAppleCursor()).toBe(12);
    expect(await store.getInbound('fresh')).toMatchObject({
      rowId: 12,
      status: 'queued',
      conversationKey: 'imessage:iMessage;-;chat-a',
    });
    await store.close();
  });

  it('does not move the cursor when accepted metadata is invalid', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      now: () => NOW,
    });
    await store.initialize();
    await store.prepareAppleCursor(20);
    const invalid = incoming('invalid', 21);
    delete invalid.metadata?.replyTarget;

    await expect(store.ingestAppleRow(21, invalid)).rejects.toThrow(/reply target/);
    expect(await store.getAppleCursor()).toBe(20);
    expect(await store.getInbound('invalid')).toBeNull();
    await store.close();
  });

  it('re-baselines when the Messages database identity changes', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      now: () => NOW,
    });
    await store.initialize();
    await store.prepareAppleCursor(0, 'database-a');
    await store.ingestAppleRow(21, incoming('old-reused-row', 21));
    await store.ingestAppleRow(100, incoming('old-generation', 100));

    await expect(store.prepareAppleCursor(150, 'database-b')).resolves.toBe(150);
    expect(await store.getAppleCursor()).toBe(150);
    expect(await store.getInbound('old-generation')).toMatchObject({
      rowId: null,
    });
    expect(await store.getInbound('old-reused-row')).toMatchObject({
      rowId: null,
    });
    await expect(
      store.ingestAppleRow(151, incoming('new-generation', 151)),
    ).resolves.toMatchObject({
      cursor: 151,
      inserted: true,
    });
    expect(
      (await store.claimReadyInbound(new Date(NOW).toISOString()))
        .map(job => job.messageId),
    ).toEqual(['old-reused-row']);
    await store.close();
  });

  it('quarantines stale messages without blocking fresh work', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      staleAfterMs: 30 * 60 * 1000,
      now: () => NOW,
    });
    await store.initialize();
    await store.prepareAppleCursor(0);
    await store.ingestAppleRow(1, incoming('stale', 1, {
      timestamp: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(),
    }));
    await store.ingestAppleRow(2, incoming('fresh', 2));

    expect(await store.getInbound('stale')).toMatchObject({
      status: 'stale_pending',
    });
    expect(await store.getStaleCount('imessage:iMessage;-;chat-a')).toBe(1);
    const claimed = await store.claimReadyInbound(new Date(NOW).toISOString());
    expect(claimed.map(job => job.messageId)).toEqual(['fresh']);

    expect(await store.resumeStale('imessage:iMessage;-;chat-a')).toBe(1);
    expect(await store.getInbound('stale')).toMatchObject({ status: 'queued' });
    await store.close();
  });
});

describe('IMessageStateStore queue state machine', () => {
  it('persists conversations and confirms chunks in order', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      now: () => NOW,
    });
    await store.initialize();
    await store.prepareAppleCursor(0);
    await store.ingestAppleRow(1, incoming('turn', 1));

    const [job] = await store.claimReadyInbound(new Date(NOW).toISOString());
    expect(job).toMatchObject({ messageId: 'turn', status: 'processing' });
    await store.completeInboundWithReply('turn', ['first', 'second'], {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'firstsecond' },
      ],
    });

    const [first] = await store.claimReadyOutbox(new Date(NOW).toISOString());
    expect(first).toMatchObject({
      id: 'turn:0',
      chunkIndex: 0,
      status: 'preparing',
    });
    await store.markOutboxSending(first.id, 100);
    await store.confirmOutbox(first.id, 101);
    expect(await store.getInbound('turn')).toMatchObject({ status: 'delivering' });

    const [second] = await store.claimReadyOutbox(new Date(NOW).toISOString());
    expect(second).toMatchObject({ id: 'turn:1', chunkIndex: 1 });
    await store.markOutboxSending(second.id, 101);
    await store.confirmOutbox(second.id, 102);

    expect(await store.getInbound('turn')).toMatchObject({ status: 'completed' });
    expect(await store.listConversations()).toEqual([
      {
        conversationKey: 'imessage:iMessage;-;chat-a',
        updatedAt: new Date(NOW).toISOString(),
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'firstsecond' },
        ],
      },
    ]);
    await store.close();
  });

  it('cancels later chunks when an earlier delivery is ambiguous', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      now: () => NOW,
    });
    await store.initialize();
    await store.prepareAppleCursor(0);
    await store.ingestAppleRow(1, incoming('partial', 1));
    await store.claimReadyInbound(new Date(NOW).toISOString());
    await store.completeInboundWithReply('partial', ['first', 'second']);

    const [first] = await store.claimReadyOutbox(new Date(NOW).toISOString());
    await store.markOutboxSending(first.id, 100);
    await expect(
      store.retryOutbox(
        first.id,
        'unsafe_retry',
        new Date(NOW + 1_000).toISOString(),
      ),
    ).rejects.toThrow(/scheduled for retry/);
    await store.markOutboxAmbiguous(first.id, 'send_unconfirmed');

    expect(await store.getOutbox('partial:0')).toMatchObject({
      status: 'ambiguous',
    });
    expect(await store.getOutbox('partial:1')).toMatchObject({
      status: 'dead_letter',
      errorCode: 'preceding_chunk_ambiguous',
    });
    expect(await store.claimReadyOutbox(new Date(NOW).toISOString())).toEqual([]);
    expect(await store.getInbound('partial')).toMatchObject({
      status: 'ambiguous',
    });

    await expect(
      store.retryLatestAmbiguous('imessage:iMessage;-;chat-a'),
    ).resolves.toBe('partial:0');
    expect(await store.getOutbox('partial:0')).toMatchObject({ status: 'ready' });
    expect(await store.getOutbox('partial:1')).toMatchObject({ status: 'ready' });
    await store.close();
  });

  it('claims one ordered turn per chat while allowing other chats', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      now: () => NOW,
    });
    await store.initialize();
    await store.prepareAppleCursor(0);
    await store.ingestAppleRow(1, incoming('a-1', 1));
    await store.ingestAppleRow(2, incoming('a-2', 2));
    await store.ingestAppleRow(3, incoming('b-1', 3, {
      chatGuid: 'iMessage;-;chat-b',
      target: '+15557654321',
    }));

    const claimed = await store.claimReadyInbound(new Date(NOW).toISOString());
    expect(claimed.map(job => job.messageId)).toEqual(['a-1', 'b-1']);
    expect(await store.getInbound('a-2')).toMatchObject({ status: 'queued' });
    await store.close();
  });

  it('recovers pre-send work but preserves the ambiguous sending boundary', async () => {
    const root = await temporaryRoot();
    const databasePath = path.join(root, '.openrappter', 'state.sqlite');
    const first = new IMessageStateStore({
      homeDirectory: root,
      databasePath,
      now: () => NOW,
    });
    await first.initialize();
    await first.prepareAppleCursor(0);
    await first.ingestAppleRow(1, incoming('processing', 1));
    await first.ingestAppleRow(2, incoming('sending', 2, {
      chatGuid: 'iMessage;-;chat-b',
      target: '+15557654321',
    }));

    await first.claimReadyInbound(new Date(NOW).toISOString());
    const processing = await first.getInbound('processing') as StoredIMessageInbound;
    const sending = await first.getInbound('sending') as StoredIMessageInbound;
    expect([processing.status, sending.status].sort()).toEqual([
      'processing',
      'processing',
    ]);
    await first.completeInboundWithReply('sending', ['reply']);
    const [chunk] = await first.claimReadyOutbox(new Date(NOW).toISOString());
    await first.markOutboxSending(chunk.id, 40);
    await first.close();

    const restarted = new IMessageStateStore({
      homeDirectory: root,
      databasePath,
      now: () => NOW + 1_000,
    });
    await restarted.initialize();
    expect(await restarted.getInbound('processing')).toMatchObject({
      status: 'retry_wait',
      errorCode: 'process_interrupted',
    });
    expect(await restarted.getOutbox(chunk.id)).toMatchObject({
      status: 'sending',
      preSendRowId: 40,
    });
    await restarted.close();
  });

  it('quarantines pending work when its target leaves the allowlist', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      now: () => NOW,
    });
    await store.initialize();
    await store.prepareAppleCursor(0);
    await store.ingestAppleRow(1, incoming('removed', 1));
    await store.claimReadyInbound(new Date(NOW).toISOString());
    await store.completeInboundWithReply('removed', ['reply']);

    await expect(
      store.quarantineUnauthorizedTarget('+15551234567'),
    ).resolves.toBe(1);
    expect(await store.getOutbox('removed:0')).toMatchObject({
      status: 'dead_letter',
      errorCode: 'target_no_longer_allowed',
    });
    expect(await store.getInbound('removed')).toMatchObject({
      status: 'dead_letter',
      errorCode: 'target_no_longer_allowed',
    });
    await store.close();
  });
});

describe('IMessageStateStore legacy migration and privacy', () => {
  it('migrates legacy cursor, conversations, and delivery states once', async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, '.openrappter');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'imessage-state.json'),
      JSON.stringify({ version: 1, appleRowId: 42 }),
    );
    await fs.writeFile(
      path.join(directory, 'imessage-conversations.json'),
      JSON.stringify({
        version: 1,
        conversations: {
          'imessage:iMessage;-;chat-a': {
            updatedAt: '2026-07-16T21:00:00.000Z',
            messages: [
              { role: 'user', content: 'hello' },
              { role: 'assistant', content: 'hi' },
            ],
          },
        },
        deliveries: {
          ready: {
            status: 'ready',
            updatedAt: '2026-07-16T21:01:00.000Z',
            conversationKey: 'imessage:iMessage;-;chat-a',
            reply: {
              target: '+15551234567',
              content: 'saved reply',
              replyTo: 'ready',
            },
          },
          longReady: {
            status: 'ready',
            updatedAt: '2026-07-16T21:01:30.000Z',
            conversationKey: 'imessage:iMessage;-;chat-a',
            reply: {
              target: '+15551234567',
              content: 'x'.repeat(3001),
              replyTo: 'longReady',
            },
          },
          sending: {
            status: 'sending',
            updatedAt: '2026-07-16T21:02:00.000Z',
            conversationKey: 'imessage:iMessage;-;chat-a',
            reply: {
              target: '+15551234567',
              content: 'maybe sent',
              replyTo: 'sending',
            },
          },
        },
      }),
    );

    const store = new IMessageStateStore({
      homeDirectory: root,
      now: () => NOW,
    });
    await store.initialize();

    expect(await store.getAppleCursor()).toBe(42);
    expect(await store.listConversations()).toEqual([
      {
        conversationKey: 'imessage:iMessage;-;chat-a',
        updatedAt: '2026-07-16T21:00:00.000Z',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      },
    ]);
    expect(await store.getInbound('ready')).toMatchObject({
      status: 'response_ready',
    });
    expect(await store.getOutbox('ready:0')).toMatchObject({ status: 'ready' });
    expect(await store.getOutbox('longReady:0')).toMatchObject({
      status: 'ready',
      content: 'x'.repeat(3000),
    });
    expect(await store.getOutbox('longReady:1')).toMatchObject({
      status: 'ready',
      content: 'x',
    });
    expect(await store.getInbound('sending')).toMatchObject({
      status: 'ambiguous',
    });
    expect(await store.getOutbox('sending:0')).toMatchObject({
      status: 'ambiguous',
      errorCode: 'legacy_send_ambiguous',
    });

    const stat = await fs.stat(store.databasePath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    await store.close();
  });

  it('fails explicitly without deleting corrupt legacy rollback data', async () => {
    const root = await temporaryRoot();
    const directory = path.join(root, '.openrappter');
    const legacyPath = path.join(directory, 'imessage-state.json');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(legacyPath, '{not-json', { mode: 0o600 });
    const store = new IMessageStateStore({
      homeDirectory: root,
      now: () => NOW,
    });

    await expect(store.initialize()).rejects.toThrow(
      'Invalid legacy iMessage cursor state',
    );
    expect(await fs.readFile(legacyPath, 'utf8')).toBe('{not-json');
  });
});
