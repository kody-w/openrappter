/**
 * macOS on-device fallback — nothing leaves the machine but the message.
 *
 * Two honest modes:
 *
 *   'sms'     Messages.app, which sends SMS when the Mac is paired to an
 *             iPhone with Text Message Forwarding, and iMessage otherwise.
 *             Autonomous, provided a reader is wired up for replies.
 *
 *   'handoff' `open tel:` — Continuity rings the callee from the paired
 *             iPhone. There is no audio path for the agent, so this is
 *             explicitly a handoff to the owner, never an agent conversation.
 *
 * Reading replies is delegated: openrappter already has iMessage plumbing, and
 * a second half-implementation of it here would be a liability.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CallHandle, CallProvider, DialRequest, ProviderCapability } from '../types.js';

const run = promisify(execFile);

export const MAC_SMS: ProviderCapability = {
  modality: 'sms',
  autonomous: true,
  onDevice: true,
  summary: 'negotiates by text through Messages on this Mac — nothing leaves the device but the message',
};

export const MAC_HANDOFF: ProviderCapability = {
  modality: 'handoff',
  autonomous: false,
  onDevice: true,
  summary: 'rings the number from your paired iPhone — the agent cannot speak on it',
};

export interface MacNativeOptions {
  mode?: 'sms' | 'handoff';
  /** Resolves the next inbound message from this number, or null on timeout. */
  awaitReply?: (from: string, timeoutMs: number) => Promise<string | null>;
  replyTimeoutMs?: number;
  /** Injected for tests. */
  exec?: (file: string, args: string[]) => Promise<unknown>;
}

/** AppleScript string literal escaping — a stray quote is a broken script. */
export function osaEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function buildSendScript(to: string, text: string): string {
  return [
    'tell application "Messages"',
    '  set targetService to 1st account whose service type = SMS',
    `  set targetBuddy to participant "${osaEscape(to)}" of targetService`,
    `  send "${osaEscape(text)}" to targetBuddy`,
    'end tell',
  ].join('\n');
}

export class MacNativeProvider implements CallProvider {
  readonly name = 'macos-native';
  readonly capability: ProviderCapability;

  private readonly mode: 'sms' | 'handoff';
  private readonly options: MacNativeOptions;
  private readonly exec: (file: string, args: string[]) => Promise<unknown>;

  constructor(options: MacNativeOptions = {}) {
    this.mode = options.mode ?? 'sms';
    this.options = options;
    this.capability = this.mode === 'sms' ? MAC_SMS : MAC_HANDOFF;
    this.exec = options.exec ?? ((file, args) => run(file, args) as Promise<unknown>);
  }

  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    // SMS mode is only genuinely autonomous if replies can be read.
    return this.mode === 'handoff' || Boolean(this.options.awaitReply);
  }

  async dial(request: DialRequest): Promise<CallHandle> {
    if (this.mode === 'handoff') {
      await this.exec('open', [`tel:${request.to}`]);
    }
    return {
      id: `mac_${Date.now()}_${request.to.replace(/\D/g, '')}`,
      provider: this.name,
      to: request.to,
      direction: 'outbound',
    };
  }

  async say(handle: CallHandle, text: string): Promise<void> {
    if (this.mode === 'handoff') {
      throw new Error('macOS handoff has no audio path — the agent cannot speak. Use mode "sms".');
    }
    await this.exec('osascript', ['-e', buildSendScript(handle.to, text)]);
  }

  async listen(handle: CallHandle, timeoutMs?: number): Promise<string | null> {
    if (this.mode === 'handoff' || !this.options.awaitReply) return null;
    return this.options.awaitReply(handle.to, timeoutMs ?? this.options.replyTimeoutMs ?? 5 * 60_000);
  }

  async hangup(): Promise<void> {
    // Nothing to hang up: a text thread stays open, and a handoff call belongs
    // to the owner's phone, not to us.
  }
}
