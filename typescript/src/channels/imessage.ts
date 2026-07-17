/**
 * Safe, allowlisted iMessage channel for macOS.
 *
 * Apple mode reads chat.db by monotonically increasing message ROWID and uses
 * Messages only for argv-based sends.
 */

import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { BaseChannel } from './base.js';
import { PrivateJsonFileStore, type JsonStore } from './private-json-store.js';
import type { IMessageDurableIngestStore } from './imessage-state-store.js';
import type {
  ChannelConfig,
  Conversation,
  IncomingMessage,
  OutgoingMessage,
} from './types.js';

export const IMESSAGE_MAX_CHUNK_LENGTH = 3000;
export const IMESSAGE_BLUEBUBBLES_UNSUPPORTED =
  'BlueBubbles mode is not supported by the live iMessage MVP; use applescript mode';
const DEFAULT_POLL_INTERVAL = 5000;
const DEFAULT_COMMAND_TIMEOUT = 10_000;
const MAX_SEEN_MESSAGE_IDS = 500;
const IMESSAGE_DATABASE_ACCESS_ERROR =
  'Cannot read the Messages database; grant Full Disk Access to the OpenRappter process';
const IMESSAGE_DATABASE_QUERY_ERROR =
  'Cannot query the Messages database; verify Full Disk Access and Messages availability';
const IMESSAGE_AUTOMATION_ERROR =
  'Cannot automate Messages; grant Automation access and confirm an iMessage account is signed in';

const APPLE_EPOCH_SECONDS = 978_307_200;

const APPLESCRIPT_AUTOMATION_PROBE = `
tell application "Messages"
  set imessageServices to every service whose service type is iMessage
  if (count of imessageServices) is 0 then error "No iMessage service is available"
  return count of imessageServices
end tell
`;

const APPLESCRIPT_SEND = `
on run argv
  if (count of argv) is not 2 then error "Expected private payload paths"
  set recipientAddress to read POSIX file (item 1 of argv) as «class utf8»
  set messageBody to read POSIX file (item 2 of argv) as «class utf8»
  tell application "Messages"
    set targetService to first account whose service type is iMessage
    set targetBuddy to participant recipientAddress of targetService
    send messageBody to targetBuddy
  end tell
end run
`;

export interface IMessageConfig extends ChannelConfig {
  mode?: 'applescript' | 'bluebubbles';
  pollInterval?: number;
  staleAfterMs?: number;
}

interface ResolvedIMessageConfig {
  enabled: boolean;
  mode: 'applescript' | 'bluebubbles';
  allowFrom: string[];
  pollInterval: number;
}

export interface IMessageCursorState {
  version: 1;
  appleRowId?: number;
}

export interface IMessageCommandResult {
  stdout: string;
  stderr: string;
}

export type IMessageCommandRunner = (
  executable: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<IMessageCommandResult>;

export interface IMessageDependencies {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  chatDatabasePath?: string;
  commandRunner?: IMessageCommandRunner;
  accessFile?: (filePath: string) => Promise<void>;
  cursorStore?: JsonStore<IMessageCursorState>;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  commandTimeout?: number;
  durableStore?: IMessageDurableIngestStore;
  random?: () => number;
  privatePayloadWriter?: IMessagePrivatePayloadWriter;
  readDatabaseIdentity?: () => Promise<string>;
}

export interface IMessagePrivatePayload {
  targetPath: string;
  contentPath: string;
  cleanup(): Promise<void>;
}

export type IMessagePrivatePayloadWriter = (
  target: string,
  content: string,
) => Promise<IMessagePrivatePayload>;

export interface IMessagePreparedSend {
  send(): Promise<void>;
  cancel(): Promise<void>;
}

interface AppleMessageRow {
  rowid?: unknown;
  message_guid?: unknown;
  text?: unknown;
  attributed_body_hex?: unknown;
  apple_date?: unknown;
  is_from_me?: unknown;
  sender?: unknown;
  chat_guid?: unknown;
  participant_count?: unknown;
  attachment_count?: unknown;
}

interface AppleSentMessageRow {
  rowid?: unknown;
  text?: unknown;
  attributed_body_hex?: unknown;
  chat_guid?: unknown;
}

export interface IMessageTransportHealth {
  connected: boolean;
  lastPollAttemptAt?: string;
  lastPollSuccessAt?: string;
  lastPollErrorCode?: string;
  consecutivePollFailures: number;
  cursor: number | null;
  databaseMaxRowId: number | null;
  cursorLag: number | null;
}

export interface IMessageSentConfirmation {
  afterRowId: number;
  chatGuid: string;
  target: string;
  content: string;
}

function defaultCommandRunner(
  executable: string,
  args: readonly string[],
  options: { timeout: number },
): Promise<IMessageCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        timeout: options.timeout,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

async function writePrivatePayload(
  directory: string,
  target: string,
  content: string,
): Promise<IMessagePrivatePayload> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await prunePrivatePayloads(directory);
  const identifier = `${process.pid}.${randomUUID()}`;
  const targetPath = path.join(directory, `.${identifier}.target`);
  const contentPath = path.join(directory, `.${identifier}.content`);
  const cleanup = async (): Promise<void> => {
    await Promise.all([
      removePrivateFile(targetPath),
      removePrivateFile(contentPath),
    ]);
  };
  try {
    await Promise.all([
      fs.writeFile(targetPath, target, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
      fs.writeFile(contentPath, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }),
    ]);
    await Promise.all([
      fs.chmod(targetPath, 0o600),
      fs.chmod(contentPath, 0o600),
    ]);
    return { targetPath, contentPath, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function removePrivateFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function prunePrivatePayloads(directory: string): Promise<void> {
  const cutoff = Date.now() - 10 * 60 * 1000;
  const names = await fs.readdir(directory);
  await Promise.all(names
    .filter(name =>
      name.startsWith('.')
      && (name.endsWith('.target') || name.endsWith('.content')),
    )
    .map(async name => {
      const filePath = path.join(directory, name);
      try {
        const ownerPid = Number(name.split('.')[1]);
        const abandoned =
          Number.isSafeInteger(ownerPid)
          && ownerPid !== process.pid
          && !processExists(ownerPid);
        if (abandoned || (await fs.stat(filePath)).mtimeMs < cutoff) {
          await removePrivateFile(filePath);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function normalizeIMessageAddress(value: string): string | null {
  const address = value.trim();
  if (!address) return null;

  if (address.includes('@')) {
    const normalizedEmail = address.toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
      ? normalizedEmail
      : null;
  }

  if (address.startsWith('+')) {
    return /^\+[1-9]\d{7,14}$/.test(address) ? address : null;
  }

  if (!/^[\d\s().-]+$/.test(address)) return null;
  const digits = address.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export function decodeAttributedBodyHex(value: unknown): string | null {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 2 !== 0
    || !/^[0-9a-f]+$/i.test(value)
  ) {
    return null;
  }

  const body = Buffer.from(value, 'hex');
  const marker = Buffer.from('NSString');
  let offset = body.indexOf(marker);
  if (offset < 0) return null;
  offset += marker.length;

  while (offset < body.length && body[offset] !== 0x2b) offset++;
  if (offset >= body.length) return null;
  offset++;

  const prefix = body[offset++];
  let length: number;
  if (prefix === 0x81) {
    if (offset >= body.length) return null;
    length = body[offset];
    offset += 1;
  } else if (prefix === 0x82) {
    if (offset + 2 > body.length) return null;
    length = body.readUInt16LE(offset);
    offset += 2;
  } else if (prefix === 0x83) {
    if (offset + 3 > body.length) return null;
    length = body.readUIntLE(offset, 3);
    offset += 3;
  } else {
    length = prefix;
  }

  if (!Number.isSafeInteger(length) || length < 0 || offset + length > body.length) {
    return null;
  }
  return body.toString('utf8', offset, offset + length);
}

export function chunkIMessageText(
  content: string,
  maxLength = IMESSAGE_MAX_CHUNK_LENGTH,
): string[] {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1) {
    throw new Error('iMessage chunk length must be a positive integer');
  }

  const codePoints = Array.from(content);
  if (codePoints.length === 0) return [''];

  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += maxLength) {
    chunks.push(codePoints.slice(index, index + maxLength).join(''));
  }
  return chunks;
}

function parseCursorState(value: IMessageCursorState): IMessageCursorState {
  if (!value || typeof value !== 'object' || value.version !== 1) {
    throw new Error('Invalid iMessage cursor state');
  }
  if (
    value.appleRowId !== undefined
    && (!Number.isSafeInteger(value.appleRowId) || value.appleRowId < 0)
  ) {
    throw new Error('Invalid iMessage Apple cursor');
  }
  return {
    version: 1,
    appleRowId: value.appleRowId,
  };
}

function appleTimestamp(value: unknown, fallback: number): string {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) {
    return new Date(fallback).toISOString();
  }
  const appleSeconds = raw > 1_000_000_000_000 ? raw / 1_000_000_000 : raw;
  const timestamp = (appleSeconds + APPLE_EPOCH_SECONDS) * 1000;
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toISOString()
    : new Date(fallback).toISOString();
}

function classifyPollFailure(error: unknown): string {
  if (error instanceof SyntaxError) return 'database_response_invalid';
  if (!(error instanceof Error)) return 'poll_failed';
  if (error.message === 'iMessage channel is not connected') {
    return 'transport_disconnected';
  }
  if (error.message === 'iMessage Apple cursor is not initialized') {
    return 'cursor_uninitialized';
  }
  if (error.message === 'Unexpected iMessage database response') {
    return 'database_response_invalid';
  }
  return 'poll_failed';
}

export function describeIMessageConnectionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const safeReasons = [
    'iMessage channel is disabled',
    'iMessage requires at least one valid allowFrom entry',
    'iMessage channel is only supported on macOS',
    IMESSAGE_BLUEBUBBLES_UNSUPPORTED,
    IMESSAGE_DATABASE_ACCESS_ERROR,
    IMESSAGE_DATABASE_QUERY_ERROR,
    IMESSAGE_AUTOMATION_ERROR,
  ];
  return safeReasons.includes(message)
    ? message
    : 'Unable to initialize iMessage; verify its config, Full Disk Access, and Messages Automation';
}

export function classifyIMessageConnectionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  switch (message) {
    case 'iMessage channel is disabled':
      return 'channel_disabled';
    case 'iMessage requires at least one valid allowFrom entry':
      return 'allowlist_empty';
    case 'iMessage channel is only supported on macOS':
      return 'unsupported_platform';
    case IMESSAGE_BLUEBUBBLES_UNSUPPORTED:
      return 'transport_unsupported';
    case IMESSAGE_DATABASE_ACCESS_ERROR:
      return 'database_access_denied';
    case IMESSAGE_DATABASE_QUERY_ERROR:
      return 'database_query_failed';
    case IMESSAGE_AUTOMATION_ERROR:
      return 'messages_automation_denied';
    default:
      return 'connection_failed';
  }
}

export class IMessageChannel extends BaseChannel {
  readonly id = 'imessage';
  private config: ResolvedIMessageConfig;
  private allowedSenders = new Set<string>();
  private readonly commandRunner: IMessageCommandRunner;
  private readonly accessFile: (filePath: string) => Promise<void>;
  private readonly cursorStore: JsonStore<IMessageCursorState>;
  private readonly platform: NodeJS.Platform;
  private readonly chatDatabasePath: string;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelSchedule: (handle: unknown) => void;
  private readonly commandTimeout: number;
  private readonly durableStore?: IMessageDurableIngestStore;
  private readonly random: () => number;
  private readonly privatePayloadWriter: IMessagePrivatePayloadWriter;
  private readonly readDatabaseIdentity: () => Promise<string>;
  private readonly seenMessageIds = new Set<string>();
  private readonly allowedReplyTargets = new Set<string>();
  private cursorState: IMessageCursorState | null = null;
  private scheduledPoll: unknown;
  private currentPoll: Promise<void> | null = null;
  private stopped = true;
  private lastPollAttemptAt?: string;
  private lastPollSuccessAt?: string;
  private lastPollErrorCode?: string;
  private consecutivePollFailures = 0;
  private databaseMaxRowId: number | null = null;
  private databaseIdentity?: string;

  constructor(config: IMessageConfig, dependencies: IMessageDependencies = {}) {
    super('imessage', 'imessage');

    const homeDirectory = dependencies.homeDirectory ?? os.homedir();
    const cursorFilePath = path.join(
      homeDirectory,
      '.openrappter',
      'imessage-state.json',
    );

    this.config = {
      enabled: config.enabled ?? false,
      mode: config.mode ?? 'applescript',
      allowFrom: Array.isArray(config.allowFrom) ? [...config.allowFrom] : [],
      pollInterval:
        Number.isFinite(config.pollInterval) && (config.pollInterval ?? 0) >= 250
          ? Math.floor(config.pollInterval!)
          : DEFAULT_POLL_INTERVAL,
    };

    this.rebuildAllowlist();
    this.platform = dependencies.platform ?? process.platform;
    this.commandRunner = dependencies.commandRunner ?? defaultCommandRunner;
    this.accessFile =
      dependencies.accessFile
      ?? (async filePath => fs.access(filePath, fs.constants.R_OK));
    this.cursorStore =
      dependencies.cursorStore
      ?? new PrivateJsonFileStore<IMessageCursorState>(cursorFilePath);
    this.chatDatabasePath =
      dependencies.chatDatabasePath
      ?? path.join(homeDirectory, 'Library', 'Messages', 'chat.db');
    this.now = dependencies.now ?? Date.now;
    this.schedule =
      dependencies.schedule
      ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelSchedule =
      dependencies.cancelSchedule
      ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.commandTimeout = dependencies.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT;
    this.durableStore = dependencies.durableStore;
    this.random = dependencies.random ?? Math.random;
    const payloadDirectory = path.join(
      homeDirectory,
      '.openrappter',
      'tmp',
      'imessage',
    );
    this.privatePayloadWriter =
      dependencies.privatePayloadWriter
      ?? ((target, content) =>
        writePrivatePayload(payloadDirectory, target, content));
    this.readDatabaseIdentity =
      dependencies.readDatabaseIdentity
      ?? (async () => {
        const stats = await fs.stat(this.chatDatabasePath);
        return [
          String(stats.dev),
          String(stats.ino),
          String(Math.floor(stats.birthtimeMs)),
        ].join(':');
      });
  }

  override isConfigured(): boolean {
    return this.config.enabled
      && this.config.mode === 'applescript'
      && this.allowedSenders.size > 0;
  }

  override getConfig(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      mode: this.config.mode,
      allowFrom: this.config.allowFrom.map(() => '[configured]'),
      pollInterval: this.config.pollInterval,
    };
  }

  override setConfig(_config: Record<string, unknown>): void {
    throw new Error('iMessage configuration changes require a process restart');
  }

  override getConfigFields() {
    return [
      { key: 'mode', label: 'Mode', type: 'text' as const, required: true },
      { key: 'allowFrom', label: 'Allowed senders', type: 'text' as const, required: true },
    ];
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.status = 'connecting';

    try {
      if (!this.config.enabled) {
        throw new Error('iMessage channel is disabled');
      }
      if (this.allowedSenders.size === 0) {
        throw new Error('iMessage requires at least one valid allowFrom entry');
      }
      if (this.config.mode === 'bluebubbles') {
        throw new Error(IMESSAGE_BLUEBUBBLES_UNSUPPORTED);
      }
      if (this.platform !== 'darwin') {
        throw new Error('iMessage channel is only supported on macOS');
      }

      await this.connectAppleScript();

      this.stopped = false;
      this.status = 'connected';
      this.connectedAt = new Date(this.now()).toISOString();
      this.scheduleNextPoll();
    } catch (error) {
      this.stopped = true;
      this.status = 'error';
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.scheduledPoll !== undefined) {
      this.cancelSchedule(this.scheduledPoll);
      this.scheduledPoll = undefined;
    }

    const activePoll = this.currentPoll;
    if (activePoll) {
      await activePoll.catch(() => undefined);
    }
    this.status = 'disconnected';
  }

  async pollNow(): Promise<void> {
    if (!this.connected) {
      throw new Error('iMessage channel is not connected');
    }
    if (this.currentPoll) return this.currentPoll;
    if (this.config.mode !== 'applescript') {
      throw new Error(IMESSAGE_BLUEBUBBLES_UNSUPPORTED);
    }

    this.lastPollAttemptAt = new Date(this.now()).toISOString();
    const operation = this.pollAppleScriptMessagesWithRebaseline();
    this.currentPoll = operation;

    try {
      await operation;
      this.databaseMaxRowId = await this.readCurrentMaxRowId();
      this.lastPollSuccessAt = new Date(this.now()).toISOString();
      this.lastPollErrorCode = undefined;
      this.consecutivePollFailures = 0;
      await this.durableStore?.recordPollSuccess(this.databaseMaxRowId);
    } catch (error) {
      const errorCode = classifyPollFailure(error);
      this.lastPollErrorCode = errorCode;
      this.consecutivePollFailures++;
      await this.durableStore?.recordPollFailure(errorCode).catch(() => undefined);
      throw error;
    } finally {
      if (this.currentPoll === operation) {
        this.currentPoll = null;
      }
    }
  }

  private async pollAppleScriptMessagesWithRebaseline(): Promise<void> {
    const maximumRowId = await this.readCurrentMaxRowId();
    const databaseIdentity = await this.readDatabaseIdentity();
    const cursor = this.requireCursorState().appleRowId;
    if (this.durableStore) {
      const prepared = await this.durableStore.prepareAppleCursor(
        maximumRowId,
        databaseIdentity,
      );
      if (prepared !== cursor) {
        this.cursorState = { version: 1, appleRowId: prepared };
      }
    } else if (
      cursor !== undefined
      && (
        cursor > maximumRowId
        || (
          this.databaseIdentity !== undefined
          && this.databaseIdentity !== databaseIdentity
        )
      )
    ) {
        await this.saveCursorState({
          ...this.requireCursorState(),
          appleRowId: maximumRowId,
        });
    }
    this.databaseIdentity = databaseIdentity;
    await this.pollAppleScriptMessages();
  }

  async send(conversationId: string, message: OutgoingMessage): Promise<void> {
    const prepared = await this.prepareSend(conversationId, message);
    await prepared.send();
  }

  async prepareSend(
    conversationId: string,
    message: OutgoingMessage,
  ): Promise<IMessagePreparedSend> {
    if (!this.connected) {
      throw new Error('iMessage channel is not connected');
    }
    if (this.config.mode !== 'applescript') {
      throw new Error(IMESSAGE_BLUEBUBBLES_UNSUPPORTED);
    }

    const chunks = chunkIMessageText(message.content);
    return this.prepareAppleScriptSend(conversationId, chunks);
  }

  authorizePersistedReplyTarget(target: string): void {
    const normalized = normalizeIMessageAddress(target);
    if (!normalized || !this.allowedSenders.has(normalized)) {
      throw new Error('iMessage persisted reply target is not authorized');
    }
    this.allowedReplyTargets.add(normalized);
  }

  async getCurrentMaxRowId(): Promise<number> {
    return this.readCurrentMaxRowId();
  }

  async findSentMessage(
    confirmation: IMessageSentConfirmation,
  ): Promise<number | null> {
    if (
      !Number.isSafeInteger(confirmation.afterRowId)
      || confirmation.afterRowId < 0
    ) {
      throw new Error('Invalid iMessage confirmation cursor');
    }
    const normalizedTarget = normalizeIMessageAddress(confirmation.target);
    if (!normalizedTarget || !this.allowedSenders.has(normalizedTarget)) {
      throw new Error('iMessage confirmation target is not authorized');
    }

    const query = `
SELECT
  m.ROWID AS rowid,
  COALESCE(m.text, '') AS text,
  hex(m.attributedBody) AS attributed_body_hex,
  c.guid AS chat_guid
FROM message m
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.ROWID > ${confirmation.afterRowId}
  AND m.is_from_me = 1
ORDER BY m.ROWID ASC
LIMIT 200;
`;
    const result = await this.commandRunner(
      'sqlite3',
      ['-json', this.chatDatabasePath, query],
      { timeout: this.commandTimeout },
    );
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) as unknown : [];
    if (!Array.isArray(parsed)) {
      throw new Error('Unexpected iMessage confirmation response');
    }

    const matches: number[] = [];
    for (const row of parsed as AppleSentMessageRow[]) {
      const rowId = Number(row.rowid);
      if (!Number.isSafeInteger(rowId) || rowId <= confirmation.afterRowId) {
        continue;
      }
      const plainText = typeof row.text === 'string' ? row.text : '';
      const content = plainText || decodeAttributedBodyHex(row.attributed_body_hex) || '';
      if (content !== confirmation.content) continue;

      const chatGuid = typeof row.chat_guid === 'string' ? row.chat_guid : '';
      if (chatGuid === confirmation.chatGuid) matches.push(rowId);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  getTransportHealth(): IMessageTransportHealth {
    const cursor = this.cursorState?.appleRowId ?? null;
    return {
      connected: this.connected,
      lastPollAttemptAt: this.lastPollAttemptAt,
      lastPollSuccessAt: this.lastPollSuccessAt,
      lastPollErrorCode: this.lastPollErrorCode,
      consecutivePollFailures: this.consecutivePollFailures,
      cursor,
      databaseMaxRowId: this.databaseMaxRowId,
      cursorLag:
        cursor !== null && this.databaseMaxRowId !== null
          ? Math.max(0, this.databaseMaxRowId - cursor)
          : null,
    };
  }

  async getConversation(conversationId: string): Promise<Conversation | null> {
    return {
      id: conversationId,
      name: 'iMessage conversation',
      type: conversationId.includes(';+;') ? 'group' : 'dm',
      participants: [],
    };
  }

  private rebuildAllowlist(): void {
    this.allowedSenders = new Set(
      this.config.allowFrom
        .map(normalizeIMessageAddress)
        .filter((address): address is string => address !== null),
    );
  }

  private async connectAppleScript(): Promise<void> {
    try {
      await this.accessFile(this.chatDatabasePath);
    } catch {
      throw new Error(IMESSAGE_DATABASE_ACCESS_ERROR);
    }

    let maxRowId: number;
    try {
      maxRowId = await this.readCurrentMaxRowId();
    } catch {
      throw new Error(IMESSAGE_DATABASE_QUERY_ERROR);
    }

    try {
      await this.commandRunner(
        'osascript',
        ['-e', APPLESCRIPT_AUTOMATION_PROBE],
        { timeout: this.commandTimeout },
      );
    } catch {
      throw new Error(IMESSAGE_AUTOMATION_ERROR);
    }

    if (this.durableStore) {
      const databaseIdentity = await this.readDatabaseIdentity();
      const cursor = await this.durableStore.prepareAppleCursor(
        maxRowId,
        databaseIdentity,
      );
      this.cursorState = { version: 1, appleRowId: cursor };
      this.databaseIdentity = databaseIdentity;
    } else {
      const loaded = await this.cursorStore.load();
      const state = loaded === null ? { version: 1 as const } : parseCursorState(loaded);
      if (state.appleRowId === undefined) {
        state.appleRowId = maxRowId;
        await this.cursorStore.save(state);
      }
      this.cursorState = state;
      this.databaseIdentity = await this.readDatabaseIdentity();
    }
    this.databaseMaxRowId = maxRowId;
  }

  private scheduleNextPoll(): void {
    if (this.stopped || this.scheduledPoll !== undefined) return;
    this.scheduledPoll = this.schedule(() => {
      this.scheduledPoll = undefined;
      void this.pollNow()
        .catch(() => {
          console.warn('iMessage polling failed');
        })
        .finally(() => {
          this.scheduleNextPoll();
        });
    }, this.nextPollDelay());
  }

  private nextPollDelay(): number {
    if (this.consecutivePollFailures === 0) return this.config.pollInterval;
    const exponent = Math.min(this.consecutivePollFailures, 8);
    const base = Math.min(
      60_000,
      this.config.pollInterval * (2 ** exponent),
    );
    const jitter = Math.floor(base * 0.2 * this.random());
    return Math.min(60_000, base + jitter);
  }

  private async readCurrentMaxRowId(): Promise<number> {
    const result = await this.commandRunner(
      'sqlite3',
      [this.chatDatabasePath, 'SELECT COALESCE(MAX(ROWID), 0) FROM message;'],
      { timeout: this.commandTimeout },
    );
    const rowId = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isSafeInteger(rowId) || rowId < 0) {
      throw new Error('Unable to read the iMessage database cursor');
    }
    return rowId;
  }

  private async pollAppleScriptMessages(): Promise<void> {
    const state = this.requireCursorState();
    const cursor = state.appleRowId;
    if (cursor === undefined) {
      throw new Error('iMessage Apple cursor is not initialized');
    }

    const query = `
SELECT
  m.ROWID AS rowid,
  m.guid AS message_guid,
  COALESCE(m.text, '') AS text,
  hex(m.attributedBody) AS attributed_body_hex,
  m.date AS apple_date,
  m.is_from_me AS is_from_me,
  h.id AS sender,
  c.guid AS chat_guid,
  (
    SELECT COUNT(DISTINCT chj.handle_id)
    FROM chat_handle_join chj
    WHERE chj.chat_id = c.ROWID
  ) AS participant_count,
  (
    SELECT COUNT(*)
    FROM message_attachment_join maj
    WHERE maj.message_id = m.ROWID
  ) AS attachment_count
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.ROWID > ${cursor}
ORDER BY m.ROWID ASC
LIMIT 100;
`;

    const result = await this.commandRunner(
      'sqlite3',
      ['-json', this.chatDatabasePath, query],
      { timeout: this.commandTimeout },
    );
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) as unknown : [];
    if (!Array.isArray(parsed)) {
      throw new Error('Unexpected iMessage database response');
    }

    const rows = (parsed as AppleMessageRow[])
      .map(row => ({ row, rowId: Number(row.rowid) }))
      .filter(item => Number.isSafeInteger(item.rowId) && item.rowId > cursor)
      .sort((left, right) => left.rowId - right.rowId);

    for (const { row, rowId } of rows) {
      if (rowId <= (this.requireCursorState().appleRowId ?? 0)) continue;
      if (this.durableStore) {
        const incoming = this.prepareAppleRow(row, rowId);
        const ingested = await this.durableStore.ingestAppleRow(rowId, incoming);
        this.cursorState = { version: 1, appleRowId: ingested.cursor };
        if (incoming && ingested.inserted) {
          try {
            await this.emitMessage(incoming);
          } finally {
            this.rememberSeenMessage(incoming.id);
          }
        }
      } else {
        await this.handleAppleRow(row, rowId);
        await this.saveCursorState({
          ...this.requireCursorState(),
          appleRowId: rowId,
        });
      }
    }
  }

  private async handleAppleRow(row: AppleMessageRow, rowId: number): Promise<void> {
    const incoming = this.prepareAppleRow(row, rowId);
    if (!incoming) return;
    await this.emitMessage(incoming);
    this.rememberSeenMessage(incoming.id);
  }

  private prepareAppleRow(
    row: AppleMessageRow,
    rowId: number,
  ): IncomingMessage | null {
    const messageGuid = typeof row.message_guid === 'string' ? row.message_guid : '';
    if (!messageGuid || this.seenMessageIds.has(messageGuid)) return null;
    if (Number(row.is_from_me) !== 0) {
      this.rememberSeenMessage(messageGuid);
      return null;
    }

    const chatGuid = typeof row.chat_guid === 'string' ? row.chat_guid : '';
    const sender = typeof row.sender === 'string' ? row.sender : '';
    const plainText = typeof row.text === 'string' ? row.text : '';
    const content = plainText || decodeAttributedBodyHex(row.attributed_body_hex) || '';
    const participantCount = Number(row.participant_count);
    const attachmentCount = Number(row.attachment_count);
    const authorizedSender = this.authorizeSender(sender, participantCount);
    if (
      !chatGuid
      || !authorizedSender
      || !content.trim()
      || (Number.isFinite(attachmentCount) && attachmentCount > 0)
    ) {
      this.rememberSeenMessage(messageGuid);
      return null;
    }

    this.allowedReplyTargets.add(authorizedSender);
    return {
      id: messageGuid,
      channel: 'imessage',
      conversationId: chatGuid,
      sender: authorizedSender,
      content,
      timestamp: appleTimestamp(row.apple_date, this.now()),
      attachments: [],
      metadata: {
        transport: 'applescript',
        canonicalChatGuid: chatGuid,
        replyTarget: authorizedSender,
        participantCount,
        isGroup: participantCount > 1,
        rowId,
      },
    };
  }

  private authorizeSender(sender: string, participantCount: number): string | null {
    const normalized = normalizeIMessageAddress(sender);
    if (
      !normalized
      || !this.allowedSenders.has(normalized)
      || participantCount !== 1
    ) {
      return null;
    }
    return normalized;
  }

  private rememberSeenMessage(messageId: string): void {
    this.seenMessageIds.add(messageId);
    if (this.seenMessageIds.size <= MAX_SEEN_MESSAGE_IDS) return;
    const oldest = this.seenMessageIds.values().next().value as string | undefined;
    if (oldest) this.seenMessageIds.delete(oldest);
  }

  private async prepareAppleScriptSend(
    recipient: string,
    chunks: readonly string[],
  ): Promise<IMessagePreparedSend> {
    const normalizedRecipient = normalizeIMessageAddress(recipient);
    if (
      !normalizedRecipient
      || !this.allowedSenders.has(normalizedRecipient)
      || !this.allowedReplyTargets.has(normalizedRecipient)
    ) {
      throw new Error('iMessage reply target is not authorized');
    }

    const payloads: IMessagePrivatePayload[] = [];
    try {
      for (const content of chunks) {
        payloads.push(
          await this.privatePayloadWriter(normalizedRecipient, content),
        );
      }
    } catch {
      await Promise.all(
        payloads.map(payload => payload.cleanup().catch(() => undefined)),
      );
      throw new Error('Failed to prepare a private iMessage payload');
    }

    const cleanup = async (): Promise<void> => {
      await Promise.all(payloads.map(payload =>
        payload.cleanup().catch(() => {
          console.warn('iMessage private payload cleanup failed');
        }),
      ));
    };
    return {
      send: async () => {
        try {
          for (const payload of payloads) {
            await this.commandRunner(
              'osascript',
              [
                '-e',
                APPLESCRIPT_SEND,
                payload.targetPath,
                payload.contentPath,
              ],
              { timeout: this.commandTimeout },
            );
          }
        } catch {
          throw new Error('Failed to send iMessage through Messages');
        } finally {
          await cleanup();
        }
      },
      cancel: cleanup,
    };
  }

  private requireCursorState(): IMessageCursorState {
    if (!this.cursorState) {
      throw new Error('iMessage cursor state is not initialized');
    }
    return this.cursorState;
  }

  private async saveCursorState(state: IMessageCursorState): Promise<void> {
    const validated = parseCursorState(state);
    await this.cursorStore.save(validated);
    this.cursorState = validated;
  }
}

export function createIMessageChannel(
  config: IMessageConfig,
  dependencies?: IMessageDependencies,
): IMessageChannel {
  return new IMessageChannel(config, dependencies);
}
