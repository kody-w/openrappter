import fs from 'fs/promises';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  chunkIMessageText,
  classifyIMessageConnectionFailure,
  decodeAttributedBodyHex,
  describeIMessageConnectionFailure,
  IMESSAGE_BLUEBUBBLES_UNSUPPORTED,
  IMessageChannel,
  normalizeIMessageAddress,
  type IMessageCommandRunner,
  type IMessageCursorState,
} from './imessage.js';
import type { JsonStore } from './private-json-store.js';
import { IMessageStateStore } from './imessage-state-store.js';

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

interface CommandCall {
  executable: string;
  args: readonly string[];
  timeout: number;
  privateTarget?: string;
  privateContent?: string;
}

function appleHarness(options?: {
  state?: IMessageCursorState | null;
  maxRowId?: number;
  rows?: Array<Record<string, unknown>>;
  allowFrom?: string[];
  pollGate?: Promise<void>;
}) {
  const calls: CommandCall[] = [];
  const stateStore = new MemoryStore<IMessageCursorState>(
    options?.state === undefined
      ? { version: 1, appleRowId: 10 }
      : options.state,
  );
  let pollCalls = 0;
  let payloadCounter = 0;
  const privateTargets = new Map<string, string>();
  const privateContents = new Map<string, string>();

  const runner: IMessageCommandRunner = async (executable, args, commandOptions) => {
    calls.push({
      executable,
      args: [...args],
      timeout: commandOptions.timeout,
      privateTarget:
        executable === 'osascript' && args.length === 4
          ? privateTargets.get(args[2])
          : undefined,
      privateContent:
        executable === 'osascript' && args.length === 4
          ? privateContents.get(args[3])
          : undefined,
    });
    if (executable === 'sqlite3' && args[0] === '-json') {
      pollCalls++;
      await options?.pollGate;
      return { stdout: JSON.stringify(options?.rows ?? []), stderr: '' };
    }
    if (executable === 'sqlite3') {
      return { stdout: String(options?.maxRowId ?? 10), stderr: '' };
    }
    return { stdout: 'Messages', stderr: '' };
  };

  const channel = new IMessageChannel(
    {
      enabled: true,
      mode: 'applescript',
      allowFrom: options?.allowFrom ?? ['(555) 123-4567'],
      pollInterval: 250,
    },
    {
      platform: 'darwin',
      chatDatabasePath: '/test/Library/Messages/chat.db',
      readDatabaseIdentity: async () => 'test-database',
      accessFile: async () => undefined,
      commandRunner: runner,
      cursorStore: stateStore,
      schedule: () => 1,
      cancelSchedule: () => undefined,
      now: () => 1_700_000_000_000,
      commandTimeout: 1234,
      privatePayloadWriter: async (target, content) => {
        const identifier = ++payloadCounter;
        const targetPath = `/private/payload-${identifier}.target`;
        const contentPath = `/private/payload-${identifier}.content`;
        privateTargets.set(targetPath, target);
        privateContents.set(contentPath, content);
        return {
          targetPath,
          contentPath,
          cleanup: async () => {
            privateTargets.delete(targetPath);
            privateContents.delete(contentPath);
          },
        };
      },
    },
  );

  return {
    channel,
    calls,
    stateStore,
    getPollCalls: () => pollCalls,
  };
}

function appleRow(
  rowid: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    rowid,
    message_guid: `message-${rowid}`,
    text: `body-${rowid}`,
    apple_date: 700_000_000_000_000_000,
    is_from_me: 0,
    sender: '+15551234567',
    chat_guid: 'iMessage;-;chat-guid',
    participant_count: 1,
    attachment_count: 0,
    ...overrides,
  };
}

function attributedBodyHex(content: string): string {
  const text = Buffer.from(content, 'utf8');
  if (text.length > 0x7f) {
    throw new Error('Test helper only supports short attributed bodies');
  }
  return Buffer.concat([
    Buffer.from('typedstream NSString metadata', 'utf8'),
    Buffer.from([0x2b, text.length]),
    text,
  ]).toString('hex');
}

describe('iMessage address normalization', () => {
  it('normalizes supported phones and emails deterministically', () => {
    expect(normalizeIMessageAddress('(555) 123-4567')).toBe('+15551234567');
    expect(normalizeIMessageAddress('1 555 123 4567')).toBe('+15551234567');
    expect(normalizeIMessageAddress('+442079460123')).toBe('+442079460123');
    expect(normalizeIMessageAddress('Person.Name@Example.COM')).toBe(
      'person.name@example.com',
    );
  });

  it('fails closed for malformed or ambiguous addresses', () => {
    expect(normalizeIMessageAddress('')).toBeNull();
    expect(normalizeIMessageAddress('5551234')).toBeNull();
    expect(normalizeIMessageAddress('+1 (555) 123-4567')).toBeNull();
    expect(normalizeIMessageAddress('not-an-address')).toBeNull();
    expect(normalizeIMessageAddress('person@example')).toBeNull();
  });
});

describe('iMessage attributed body decoding', () => {
  it('extracts modern Messages typedstream text and rejects malformed blobs', () => {
    expect(decodeAttributedBodyHex(attributedBodyHex('BLUE ORBIT 7421')))
      .toBe('BLUE ORBIT 7421');
    expect(decodeAttributedBodyHex('not-hex')).toBeNull();
    expect(decodeAttributedBodyHex('00ff')).toBeNull();
  });
});

describe('IMessageChannel Apple transport', () => {
  it('commits a durable inbound job and cursor before notifying handlers', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      staleAfterMs: 60 * 60 * 1000,
      now: () => 1_700_000_000_000,
    });
    await store.initialize();
    const channel = new IMessageChannel(
      {
        enabled: true,
        mode: 'applescript',
        allowFrom: ['+15551234567'],
        pollInterval: 250,
      },
      {
        platform: 'darwin',
        chatDatabasePath: '/test/Library/Messages/chat.db',
        readDatabaseIdentity: async () => 'test-database',
        accessFile: async () => undefined,
        durableStore: store,
        commandRunner: async (executable, args) => {
          if (executable === 'sqlite3' && args[0] === '-json') {
            return {
              stdout: JSON.stringify([appleRow(11, {
                apple_date: 721_692_799_000_000_000,
              })]),
              stderr: '',
            };
          }
          if (executable === 'sqlite3') {
            return { stdout: '10', stderr: '' };
          }
          return { stdout: 'Messages', stderr: '' };
        },
        schedule: () => 1,
        cancelSchedule: () => undefined,
        now: () => 1_700_000_000_000,
      },
    );
    channel.onMessage(async () => {
      throw new Error('wake failed');
    });

    await channel.connect();
    await expect(channel.pollNow()).rejects.toThrow('wake failed');

    expect(await store.getAppleCursor()).toBe(11);
    expect(await store.getInbound('message-11')).toMatchObject({
      rowId: 11,
      status: 'queued',
    });
    await channel.disconnect();
    await store.close();
  });

  it('re-baselines a replaced Messages database during live polling', async () => {
    const store = new IMessageStateStore({
      databasePath: ':memory:',
      staleAfterMs: 60 * 60 * 1000,
      now: () => 1_700_000_000_000,
    });
    await store.initialize();
    await store.prepareAppleCursor(100);
    let scalarQueries = 0;
    let identityReads = 0;
    const channel = new IMessageChannel(
      {
        enabled: true,
        mode: 'applescript',
        allowFrom: ['+15551234567'],
        pollInterval: 250,
      },
      {
        platform: 'darwin',
        chatDatabasePath: '/test/Library/Messages/chat.db',
        readDatabaseIdentity: async () =>
          ++identityReads === 1 ? 'database-a' : 'database-b',
        accessFile: async () => undefined,
        durableStore: store,
        commandRunner: async (executable, args) => {
          if (executable === 'sqlite3' && args[0] === '-json') {
            return {
              stdout: JSON.stringify([appleRow(21, {
                apple_date: 721_692_799_000_000_000,
              })]),
              stderr: '',
            };
          }
          if (executable === 'sqlite3') {
            scalarQueries++;
            return {
              stdout: scalarQueries === 1
                ? '100'
                : scalarQueries === 2
                  ? '20'
                  : '21',
              stderr: '',
            };
          }
          return { stdout: 'Messages', stderr: '' };
        },
        schedule: () => 1,
        cancelSchedule: () => undefined,
        now: () => 1_700_000_000_000,
      },
    );

    await channel.connect();
    await channel.pollNow();

    expect(await store.getAppleCursor()).toBe(21);
    expect(await store.getInbound('message-21')).toMatchObject({
      rowId: 21,
      status: 'queued',
    });
    await channel.disconnect();
    await store.close();
  });

  it('requires an explicit non-empty valid allowlist before probing', async () => {
    const harness = appleHarness({ allowFrom: ['not valid'] });
    await expect(harness.channel.connect()).rejects.toThrow(/allowFrom/);
    expect(harness.calls).toHaveLength(0);
  });

  it('initializes a missing cursor at max ROWID without replaying old rows', async () => {
    const harness = appleHarness({ state: null, maxRowId: 42 });
    await harness.channel.connect();
    await harness.channel.pollNow();

    expect(harness.stateStore.saves[0]).toMatchObject({ appleRowId: 42 });
    const pollCall = harness.calls.find(
      call => call.executable === 'sqlite3' && call.args[0] === '-json',
    );
    expect(pollCall?.args[2]).toContain('WHERE m.ROWID > 42');
    expect(pollCall?.args[2]).toContain('c.guid AS chat_guid');
    expect(pollCall?.args[2]).toContain('participant_count');
  });

  it('advances ignored rows and awaits authorized messages in ROWID order', async () => {
    const harness = appleHarness({
      rows: [
        appleRow(16),
        appleRow(11, { sender: '+15550000000' }),
        appleRow(14, { message_guid: 'accepted-1' }),
        appleRow(12, { participant_count: 2 }),
        appleRow(13, { message_guid: 'accepted-1' }),
        appleRow(15, { is_from_me: 1 }),
      ],
    });
    const delivered: string[] = [];
    let activeHandlers = 0;
    let maximumActiveHandlers = 0;
    harness.channel.onMessage(async message => {
      activeHandlers++;
      maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers);
      await Promise.resolve();
      delivered.push(message.id);
      activeHandlers--;
    });

    await harness.channel.connect();
    await harness.channel.pollNow();

    expect(delivered).toEqual(['accepted-1', 'message-16']);
    expect(maximumActiveHandlers).toBe(1);
    expect(harness.stateStore.saves.map(state => state.appleRowId)).toEqual([
      11, 12, 13, 14, 15, 16,
    ]);
    expect(harness.stateStore.value?.appleRowId).toBe(16);
  });

  it('always rejects group chats, including allowlisted senders', async () => {
    const harness = appleHarness({
      rows: [
        appleRow(11, { participant_count: 3 }),
        appleRow(12, { participant_count: 3, sender: '+15550000000' }),
      ],
    });
    const delivered: string[] = [];
    harness.channel.onMessage(async message => {
      delivered.push(message.id);
    });

    await harness.channel.connect();
    await harness.channel.pollNow();

    expect(delivered).toEqual([]);
    expect(harness.stateStore.value?.appleRowId).toBe(12);
  });

  it('does not acknowledge or mark an authorized row seen when its handler fails', async () => {
    const harness = appleHarness({ rows: [appleRow(11)] });
    let attempts = 0;
    harness.channel.onMessage(async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('handler failed');
      }
    });

    await harness.channel.connect();
    await expect(harness.channel.pollNow()).rejects.toThrow('handler failed');
    expect(harness.stateStore.value?.appleRowId).toBe(10);
    expect(harness.stateStore.saves).toHaveLength(0);

    await expect(harness.channel.pollNow()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    expect(harness.stateStore.value?.appleRowId).toBe(11);
  });

  it('acknowledges empty text without invoking handlers', async () => {
    const harness = appleHarness({
      rows: [
        appleRow(11, {
          text: '',
          attributedBody: { unsupported: true },
        }),
        appleRow(12, { text: '   ' }),
      ],
    });
    let handlerCalls = 0;
    harness.channel.onMessage(async () => {
      handlerCalls++;
    });

    await harness.channel.connect();
    await harness.channel.pollNow();

    expect(handlerCalls).toBe(0);
    expect(harness.stateStore.value?.appleRowId).toBe(12);
  });

  it('handles attributedBody-only text on modern macOS', async () => {
    const harness = appleHarness({
      rows: [
        appleRow(11, {
          text: null,
          attributed_body_hex: attributedBodyHex('BLUE ORBIT 7421'),
        }),
      ],
    });
    const delivered: string[] = [];
    harness.channel.onMessage(async message => {
      delivered.push(message.content);
    });

    await harness.channel.connect();
    await harness.channel.pollNow();

    expect(delivered).toEqual(['BLUE ORBIT 7421']);
    expect(harness.stateStore.value?.appleRowId).toBe(11);
  });

  it('acknowledges attachment-bearing rows without invoking the model', async () => {
    const harness = appleHarness({
      rows: [
        appleRow(11, {
          text: 'caption',
          attachment_count: 1,
        }),
      ],
    });
    let handlerCalls = 0;
    harness.channel.onMessage(async () => {
      handlerCalls++;
    });

    await harness.channel.connect();
    await harness.channel.pollNow();

    expect(handlerCalls).toBe(0);
    expect(harness.stateStore.value?.appleRowId).toBe(11);
  });

  it('uses a single in-flight poll for concurrent triggers', async () => {
    let releasePoll!: () => void;
    const pollGate = new Promise<void>(resolve => {
      releasePoll = resolve;
    });
    const harness = appleHarness({ pollGate });
    await harness.channel.connect();

    const first = harness.channel.pollNow();
    const second = harness.channel.pollNow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(harness.getPollCalls()).toBe(1);

    releasePoll();
    await Promise.all([first, second]);
  });

  it('passes recipient and body only as osascript argv and chunks in order', async () => {
    const harness = appleHarness({ rows: [appleRow(11)] });
    harness.channel.onMessage(async () => undefined);
    await harness.channel.connect();

    const probeCall = harness.calls.find(call => call.executable === 'osascript');
    expect(probeCall?.args).toHaveLength(2);
    expect(probeCall?.args[1]).not.toContain('send messageBody');

    await harness.channel.pollNow();
    const content = `${'🙂'.repeat(3001)} "'; do shell script "unsafe"`;
    await harness.channel.send('(555) 123-4567', {
      channel: 'imessage',
      content,
    });

    const sendCalls = harness.calls.filter(
      call => call.executable === 'osascript' && call.args.length === 4,
    );
    expect(sendCalls.length).toBeGreaterThan(1);
    expect(sendCalls.every(call => call.timeout === 1234)).toBe(true);
    expect(sendCalls.every(call => call.args[1] !== content)).toBe(true);
    expect(sendCalls.every(call => call.args[1] !== '+15551234567')).toBe(true);
    expect(sendCalls.every(call => !call.args.includes('+15551234567'))).toBe(true);
    expect(sendCalls.every(call => !call.args.includes(content))).toBe(true);
    expect(sendCalls.map(call => call.privateTarget)).toEqual(
      Array(sendCalls.length).fill('+15551234567'),
    );
    expect(sendCalls.map(call => call.privateContent).join('')).toBe(content);
    expect(sendCalls.every(
      call => Array.from(call.privateContent ?? '').length <= 3000,
    )).toBe(true);
  });

  it('confirms exactly one locally persisted outbound row in the same chat', async () => {
    const sentRows = [
      {
        rowid: 52,
        text: 'confirmed reply',
        chat_guid: 'iMessage;-;chat-guid',
      },
    ];
    const runner: IMessageCommandRunner = async (executable, args) => {
      if (executable === 'sqlite3' && args[0] === '-json') {
        return {
          stdout: JSON.stringify(sentRows),
          stderr: '',
        };
      }
      if (executable === 'sqlite3') return { stdout: '50', stderr: '' };
      return { stdout: 'Messages', stderr: '' };
    };
    const channel = new IMessageChannel(
      {
        enabled: true,
        mode: 'applescript',
        allowFrom: ['+15551234567'],
      },
      {
        platform: 'darwin',
        chatDatabasePath: '/test/Library/Messages/chat.db',
        readDatabaseIdentity: async () => 'test-database',
        accessFile: async () => undefined,
        commandRunner: runner,
        cursorStore: new MemoryStore<IMessageCursorState>({
          version: 1,
          appleRowId: 50,
        }),
        schedule: () => 1,
        cancelSchedule: () => undefined,
      },
    );
    await channel.connect();

    await expect(channel.findSentMessage({
      afterRowId: 50,
      chatGuid: 'iMessage;-;chat-guid',
      target: '+15551234567',
      content: 'confirmed reply',
    })).resolves.toBe(52);

    sentRows.push({
      rowid: 53,
      text: 'confirmed reply',
      chat_guid: 'iMessage;-;chat-guid',
    });
    await expect(channel.findSentMessage({
      afterRowId: 50,
      chatGuid: 'iMessage;-;chat-guid',
      target: '+15551234567',
      content: 'confirmed reply',
    })).resolves.toBeNull();
  });

  it('passes outbound address and content through ephemeral private files', async () => {
    const root = await fs.mkdtemp(path.join(process.cwd(), '.imessage-payload-'));
    const observed: Array<{
      target: string;
      content: string;
      targetMode: number;
      contentMode: number;
      targetPath: string;
      contentPath: string;
    }> = [];
    try {
      const channel = new IMessageChannel(
        {
          enabled: true,
          mode: 'applescript',
          allowFrom: ['+15551234567'],
        },
        {
          platform: 'darwin',
          homeDirectory: root,
          chatDatabasePath: '/test/Library/Messages/chat.db',
          readDatabaseIdentity: async () => 'test-database',
          accessFile: async () => undefined,
          cursorStore: new MemoryStore<IMessageCursorState>({
            version: 1,
            appleRowId: 10,
          }),
          commandRunner: async (executable, args) => {
            if (executable === 'sqlite3') {
              return { stdout: '10', stderr: '' };
            }
            if (executable === 'osascript' && args.length === 4) {
              observed.push({
                target: await fs.readFile(args[2], 'utf8'),
                content: await fs.readFile(args[3], 'utf8'),
                targetMode: (await fs.stat(args[2])).mode & 0o777,
                contentMode: (await fs.stat(args[3])).mode & 0o777,
                targetPath: args[2],
                contentPath: args[3],
              });
            }
            return { stdout: 'Messages', stderr: '' };
          },
          schedule: () => 1,
          cancelSchedule: () => undefined,
        },
      );
      await channel.connect();
      channel.authorizePersistedReplyTarget('+15551234567');
      await channel.send('+15551234567', {
        channel: 'imessage',
        content: 'private reply',
      });

      expect(observed).toEqual([
        expect.objectContaining({
          target: '+15551234567',
          content: 'private reply',
          targetMode: 0o600,
          contentMode: 0o600,
        }),
      ]);
      await expect(fs.access(observed[0].targetPath)).rejects.toThrow();
      await expect(fs.access(observed[0].contentPath)).rejects.toThrow();
      expect(
        (await fs.stat(path.join(root, '.openrappter', 'tmp', 'imessage')))
          .mode & 0o777,
      ).toBe(0o700);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('never splits a Unicode code point while chunking', () => {
    const content = 'a🙂b🙂c';
    const chunks = chunkIMessageText(content, 2);
    expect(chunks).toEqual(['a🙂', 'b🙂', 'c']);
    expect(chunks.join('')).toBe(content);
  });

  it('rejects BlueBubbles mode explicitly before transport access', async () => {
    const channel = new IMessageChannel(
      {
        enabled: true,
        mode: 'bluebubbles',
        allowFrom: ['5551234567'],
      },
      {
        platform: 'linux',
        accessFile: async () => {
          throw new Error('must not probe');
        },
      },
    );

    await expect(channel.connect()).rejects.toThrow(
      IMESSAGE_BLUEBUBBLES_UNSUPPORTED,
    );
  });

  it('rejects runtime configuration mutation with a restart-required error', () => {
    const harness = appleHarness();
    expect(() => harness.channel.setConfig({ enabled: false })).toThrow(
      /restart/,
    );
    expect(harness.channel.getConfig()).toMatchObject({ enabled: true });
  });

  it('sanitizes unexpected startup failures', () => {
    const reason = describeIMessageConnectionFailure(
      new Error('secret=password sender=+15551234567 body=private'),
    );
    expect(reason).toContain('Full Disk Access');
    expect(reason).not.toContain('password');
    expect(reason).not.toContain('+15551234567');
    expect(reason).not.toContain('private');
    expect(classifyIMessageConnectionFailure(
      new Error(
        'Cannot read the Messages database; grant Full Disk Access to the OpenRappter process',
      ),
    )).toBe('database_access_denied');
    expect(classifyIMessageConnectionFailure(
      new Error('private sender and body'),
    )).toBe('connection_failed');
  });
});
