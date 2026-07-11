/**
 * Thin consumer-plane proxy for the canonical Python iMessage sidecar.
 *
 * The sidecar owns imsg, delivery, identity, history, and privacy. This class
 * only exposes lifecycle/status through the existing OpenRappter channel UI.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BaseChannel } from './base.js';
import type { OutgoingMessage } from './types.js';

const execFileAsync = promisify(execFile);
const LABEL = 'com.openrappter.imessage';

export class IMessageProxyChannel extends BaseChannel {
  private readonly home: string;

  constructor(home = process.env.OPENRAPPTER_HOME ?? path.join(os.homedir(), '.openrappter')) {
    super('imessage', 'imessage');
    this.home = home;
    this.refreshStatus();
  }

  async connect(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('iMessage requires macOS');
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid === undefined) throw new Error('Unable to resolve the macOS user id');
    await execFileAsync('/bin/launchctl', [
      'kickstart',
      '-k',
      `gui/${uid}/${LABEL}`,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 750));
    this.refreshStatus();
    if (!this.connected) {
      throw new Error('iMessage sidecar did not become ready');
    }
  }

  async disconnect(): Promise<void> {
    if (process.platform === 'darwin' && typeof process.getuid === 'function') {
      await execFileAsync('/bin/launchctl', [
        'kill',
        'SIGTERM',
        `gui/${process.getuid()}/${LABEL}`,
      ]).catch(() => undefined);
    }
    this.connected = false;
  }

  async send(_conversationId: string, _message: OutgoingMessage): Promise<void> {
    throw new Error(
      'Direct iMessage sends are disabled; replies must use the trust-scoped conversation sidecar',
    );
  }

  refreshStatus(): void {
    const statusPath = path.join(this.home, 'imessage', 'state', 'status.json');
    try {
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as {
        lifecycle?: string;
        ready?: boolean;
        updated_at?: number;
        processed?: number;
      };
      const fresh =
        typeof status.updated_at === 'number'
        && Date.now() / 1000 - status.updated_at < 20;
      this.connected =
        fresh
        && status.lifecycle === 'running'
        && status.ready === true;
      if (typeof status.processed === 'number') {
        this.messageCount = status.processed;
      }
    } catch {
      this.connected = false;
    }
  }

  getConfig(): Record<string, unknown> {
    return {
      configured: fs.existsSync(path.join(this.home, 'imessage', 'config.json')),
      backend: 'imsg-rpc',
    };
  }
}
