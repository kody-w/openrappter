/**
 * DM Policy Engine
 * Controls who can send direct messages to the bot.
 *
 * Modes:
 *   'open'    — accept all DMs (optional allowlist restricts further)
 *   'pairing' — unknown senders must pair with a one-time code first
 *   'closed'  — reject all DMs except explicitly allowlisted senders
 */

import { randomBytes } from 'crypto';

export type DMMode = 'open' | 'pairing' | 'closed';

export interface DMPolicyOptions {
  mode: DMMode;
  /** Allowlist applies to all modes for explicit permission */
  allowlist?: string[];
  /** Blocklist applies to all modes; overrides allowlist */
  blocklist?: string[];
  /** Per-channel policy overrides */
  channelPolicies?: Record<string, DMChannelPolicy>;
  /** Pairing code TTL in milliseconds (default 10 min) */
  pairingCodeTtlMs?: number;
}

export interface DMChannelPolicy {
  mode: DMMode;
  allowlist?: string[];
  blocklist?: string[];
}

export interface AccessResult {
  allowed: boolean;
  reason?: string;
  /** Provided when mode is 'pairing' and sender is unknown */
  pairingCode?: string;
}

interface PairingEntry {
  code: string;
  senderId: string;
  channelId?: string;
  expiresAt: number;
}

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class DMPolicyEngine {
  private mode: DMMode;
  private allowlist = new Set<string>();
  private blocklist = new Set<string>();
  private pairedSenders = new Set<string>(); // globally paired
  private pairedByChannel = new Map<string, Set<string>>(); // channelId → senderIds
  private pendingCodes = new Map<string, PairingEntry>(); // code → entry
  private channelPolicies = new Map<string, DMChannelPolicy>();
  private pairingCodeTtlMs: number;

  constructor(options: DMPolicyOptions) {
    this.mode = options.mode;
    this.pairingCodeTtlMs = options.pairingCodeTtlMs ?? DEFAULT_PAIRING_TTL_MS;

    if (options.allowlist) {
      for (const id of options.allowlist) this.allowlist.add(id);
    }
    if (options.blocklist) {
      for (const id of options.blocklist) this.blocklist.add(id);
    }
    if (options.channelPolicies) {
      for (const [channelId, policy] of Object.entries(options.channelPolicies)) {
        this.channelPolicies.set(channelId, policy);
      }
    }
  }

  /**
   * Check whether `senderId` can send a DM (optionally scoped to `channelId`).
   */
  checkAccess(senderId: string, channelId?: string): AccessResult {
    // Resolve effective mode and lists (channel overrides base)
    const { mode, allowlist, blocklist } = this.resolvePolicy(channelId);

    // Blocklist always wins
    if (blocklist.has(senderId)) {
      return { allowed: false, reason: 'Sender is blocklisted' };
    }

    // Allowlist grants access in all modes
    if (allowlist.has(senderId)) {
      return { allowed: true };
    }

    switch (mode) {
      case 'open':
        return { allowed: true };

      case 'closed':
        return { allowed: false, reason: 'DMs are closed; sender not in allowlist' };

      case 'pairing': {
        if (this.isPaired(senderId, channelId)) {
          return { allowed: true };
        }
        // Issue pairing code for unknown sender
        const code = this.generatePairingCode(senderId, channelId);
        return {
          allowed: false,
          reason: 'Sender must complete pairing',
          pairingCode: code,
        };
      }

      default:
        return { allowed: false, reason: 'Unknown DM policy mode' };
    }
  }

  /**
   * Add a sender to the global (or channel-scoped) allowlist.
   */
  addToAllowlist(senderId: string, channelId?: string): void {
    if (channelId) {
      const policy = this.channelPolicies.get(channelId);
      if (policy) {
        policy.allowlist = policy.allowlist ?? [];
        if (!policy.allowlist.includes(senderId)) {
          policy.allowlist.push(senderId);
        }
      }
      // Also store in paired-by-channel for pairing mode
      this.setPaired(senderId, channelId);
    } else {
      this.allowlist.add(senderId);
    }
  }

  /**
   * Remove a sender from the global allowlist and all paired state.
   */
  removeFromAllowlist(senderId: string): void {
    this.allowlist.delete(senderId);
    this.pairedSenders.delete(senderId);
    for (const set of this.pairedByChannel.values()) {
      set.delete(senderId);
    }
  }

  /**
   * Add a sender to the blocklist.
   */
  addToBlocklist(senderId: string): void {
    this.blocklist.add(senderId);
  }

  /**
   * Remove a sender from the blocklist.
   */
  removeFromBlocklist(senderId: string): void {
    this.blocklist.delete(senderId);
  }

  /**
   * Generate a one-time pairing code for a sender.
   * Replaces any existing pending code for the same sender+channel.
   */
  generatePairingCode(senderId: string, channelId?: string): string {
    // Clean up existing code for this sender+channel
    for (const [code, entry] of this.pendingCodes) {
      if (entry.senderId === senderId && entry.channelId === channelId) {
        this.pendingCodes.delete(code);
      }
    }

    const code = randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars
    this.pendingCodes.set(code, {
      code,
      senderId,
      channelId,
      expiresAt: Date.now() + this.pairingCodeTtlMs,
    });
    return code;
  }

  /**
   * Validate a pairing code and, if valid, grant access.
   * Returns whether the code was valid.
   */
  validatePairingCode(senderId: string, code: string): boolean {
    const entry = this.pendingCodes.get(code);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this.pendingCodes.delete(code);
      return false;
    }

    if (entry.senderId !== senderId) return false;

    // Grant access
    this.setPaired(senderId, entry.channelId);
    this.pendingCodes.delete(code);
    return true;
  }

  /**
   * Check if a sender is currently paired.
   */
  isPaired(senderId: string, channelId?: string): boolean {
    if (this.pairedSenders.has(senderId)) return true;
    if (channelId) {
      return this.pairedByChannel.get(channelId)?.has(senderId) ?? false;
    }
    return false;
  }

  /**
   * Get all paired sender IDs (global + optionally channel-specific).
   */
  getPairedSenders(channelId?: string): string[] {
    if (channelId) {
      const channelSet = this.pairedByChannel.get(channelId) ?? new Set<string>();
      const merged = new Set([...this.pairedSenders, ...channelSet]);
      return Array.from(merged);
    }
    return Array.from(this.pairedSenders);
  }

  /**
   * Revoke pairing for a sender.
   */
  revokePairing(senderId: string, channelId?: string): void {
    if (channelId) {
      this.pairedByChannel.get(channelId)?.delete(senderId);
    } else {
      this.pairedSenders.delete(senderId);
      for (const set of this.pairedByChannel.values()) {
        set.delete(senderId);
      }
    }
  }

  /**
   * Update the global DM mode at runtime.
   */
  setMode(mode: DMMode): void {
    this.mode = mode;
  }

  /**
   * Set or update a channel-level policy.
   */
  setChannelPolicy(channelId: string, policy: DMChannelPolicy): void {
    this.channelPolicies.set(channelId, policy);
  }

  /**
   * Remove a channel-level policy (falls back to global).
   */
  removeChannelPolicy(channelId: string): void {
    this.channelPolicies.delete(channelId);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private resolvePolicy(channelId?: string): {
    mode: DMMode;
    allowlist: Set<string>;
    blocklist: Set<string>;
  } {
    if (channelId) {
      const channelPolicy = this.channelPolicies.get(channelId);
      if (channelPolicy) {
        const allowlist = new Set([
          ...this.allowlist,
          ...(channelPolicy.allowlist ?? []),
        ]);
        const blocklist = new Set([
          ...this.blocklist,
          ...(channelPolicy.blocklist ?? []),
        ]);
        return { mode: channelPolicy.mode, allowlist, blocklist };
      }
    }
    return { mode: this.mode, allowlist: this.allowlist, blocklist: this.blocklist };
  }

  private setPaired(senderId: string, channelId?: string): void {
    if (channelId) {
      let set = this.pairedByChannel.get(channelId);
      if (!set) {
        set = new Set();
        this.pairedByChannel.set(channelId, set);
      }
      set.add(senderId);
    } else {
      this.pairedSenders.add(senderId);
    }
  }
}

export function createDMPolicyEngine(options: DMPolicyOptions): DMPolicyEngine {
  return new DMPolicyEngine(options);
}
