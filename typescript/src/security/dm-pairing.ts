/**
 * DM Pairing Manager
 * Manages pairing codes for direct message authentication
 */

import { randomInt } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

export interface PairingCode {
  code: string;
  channel: string;
  senderId: string;
  createdAt: number;
  expiresAt: number;
}

interface PairedData {
  [channel: string]: string[]; // channel -> array of sender IDs
}

export class DMPairingManager {
  private codes = new Map<string, PairingCode>();
  private paired: PairedData = {};
  private pairingPath: string;

  constructor() {
    this.pairingPath = join(homedir(), '.openrappter', 'pairing.json');
    this.loadPaired();
  }

  /**
   * Generate a 6-digit pairing code
   * Expires in 10 minutes
   */
  generateCode(channel: string, senderId: string): string {
    const code = randomInt(100000, 999999).toString();
    const now = Date.now();

    this.codes.set(code, {
      code,
      channel,
      senderId,
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000, // 10 minutes
    });

    return code;
  }

  /**
   * Verify a pairing code and pair the sender if valid
   */
  verifyCode(code: string): { valid: boolean; channel?: string; senderId?: string } {
    const pairingCode = this.codes.get(code);

    if (!pairingCode) {
      return { valid: false };
    }

    // Check expiration
    if (Date.now() > pairingCode.expiresAt) {
      this.codes.delete(code);
      return { valid: false };
    }

    // Valid - add to paired list
    if (!this.paired[pairingCode.channel]) {
      this.paired[pairingCode.channel] = [];
    }

    if (!this.paired[pairingCode.channel].includes(pairingCode.senderId)) {
      this.paired[pairingCode.channel].push(pairingCode.senderId);
      this.savePaired();
    }

    // Remove the used code
    this.codes.delete(code);

    return {
      valid: true,
      channel: pairingCode.channel,
      senderId: pairingCode.senderId,
    };
  }

  /**
   * Get all paired senders for a channel
   */
  getPairedSenders(channel: string): string[] {
    return this.paired[channel] ?? [];
  }

  /**
   * Revoke pairing for a sender on a channel
   */
  revoke(channel: string, senderId: string): boolean {
    const senders = this.paired[channel];
    if (!senders) {
      return false;
    }

    const index = senders.indexOf(senderId);
    if (index === -1) {
      return false;
    }

    senders.splice(index, 1);

    if (senders.length === 0) {
      delete this.paired[channel];
    }

    this.savePaired();
    return true;
  }

  /**
   * Load paired data from disk
   */
  loadPaired(): void {
    try {
      if (existsSync(this.pairingPath)) {
        const data = readFileSync(this.pairingPath, 'utf8');
        this.paired = JSON.parse(data);
      }
    } catch (error) {
      console.error('Failed to load pairing data:', error);
      this.paired = {};
    }
  }

  /**
   * Save paired data to disk
   */
  savePaired(): void {
    try {
      const dir = dirname(this.pairingPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.pairingPath, JSON.stringify(this.paired, null, 2));
    } catch (error) {
      console.error('Failed to save pairing data:', error);
    }
  }
}
