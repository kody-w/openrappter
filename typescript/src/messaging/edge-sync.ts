/**
 * EdgeSync — Public/Private Edge Synchronization
 *
 * Publishes encrypted (PII-stripped) conversation state as static JSON.
 * Any edge client can pull via HTTP, decrypt with key, reattach PII locally.
 *
 * Architecture:
 *   Twin UI → PIIStripper → EncryptedMessageStore → EdgeSync → Static Host
 *                                                                  ↓
 *   Edge Client ← HTTP GET ← Static JSON ← Decrypt ← PIIVault reattach
 *
 * The static host (GitHub Pages, S3, etc.) only ever sees:
 *   - Encrypted blobs (AES-256-GCM)
 *   - With PII already stripped before encryption
 *   - HMAC-signed so recipients can verify authenticity
 *
 * Triple layer: encryption + PII stripping + HMAC signing
 */

import { createHmac } from 'crypto';
import type { EncryptedBlob, ConversationExport } from './store.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EdgeManifest {
  _type: 'openrappter-edge-manifest';
  version: number;
  /** ISO timestamp of last publish */
  publishedAt: string;
  /** Available channels (public metadata only — no content, no keys) */
  channels: EdgeChannelMeta[];
}

export interface EdgeChannelMeta {
  id: string;
  name: string;
  participants: string[];
  messageCount: number;
  /** Hash of the latest message — for incremental sync */
  headHash: string;
  /** URL path relative to the manifest */
  path: string;
}

export interface EdgeChannelFile {
  _type: 'openrappter-edge-channel';
  version: number;
  channel: EdgeChannelMeta;
  /** HMAC-SHA256 of the entire messages array (signed with conversation key) */
  signature: string;
  /** Encrypted, PII-stripped message blobs */
  messages: SignedBlob[];
}

export interface SignedBlob extends EncryptedBlob {
  /** HMAC-SHA256 of (encrypted + iv + authTag + senderHint + timestamp) */
  hmac: string;
}

export interface EdgeSyncConfig {
  /** Where to write static files (local dir that maps to the static host) */
  outputDir: string;
  /** Base URL of the static host (for generating manifest URLs) */
  baseUrl?: string;
  /** Auto-publish on new messages */
  autoPublish?: boolean;
}

// ── HMAC Signing ─────────────────────────────────────────────────────────────

/**
 * Sign a message blob with HMAC-SHA256 using the conversation key.
 * Proves the message came from someone who holds the key.
 */
export function signBlob(blob: EncryptedBlob, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const payload = `${blob.encrypted}:${blob.iv}:${blob.authTag}:${blob.senderHint}:${blob.timestamp}`;
  return createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * Verify a signed blob's HMAC. Returns true if valid.
 */
export function verifyBlob(blob: SignedBlob, keyBase64: string): boolean {
  const expected = signBlob(blob, keyBase64);
  return expected === blob.hmac;
}

/**
 * Sign the entire message array for channel-level integrity.
 */
export function signChannel(messages: SignedBlob[], keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const payload = messages.map(m => m.hmac).join(':');
  return createHmac('sha256', key).update(payload).digest('hex');
}

/**
 * Verify channel-level signature.
 */
export function verifyChannel(messages: SignedBlob[], signature: string, keyBase64: string): boolean {
  const expected = signChannel(messages, keyBase64);
  return expected === signature;
}

// ── Edge Publisher ────────────────────────────────────────────────────────────

export class EdgePublisher {
  private config: EdgeSyncConfig;

  constructor(config: EdgeSyncConfig) {
    this.config = config;
  }

  /**
   * Publish a conversation export as a signed, static edge file.
   * The export should already be encrypted + PII-stripped.
   */
  publish(exported: ConversationExport, keyBase64: string): EdgeChannelFile {
    // Sign each message blob
    const signedMessages: SignedBlob[] = exported.messages.map(blob => ({
      ...blob,
      hmac: signBlob(blob, keyBase64),
    }));

    // Compute head hash (hash of last message's HMAC)
    const headHash = signedMessages.length > 0
      ? signedMessages[signedMessages.length - 1].hmac.slice(0, 16)
      : '0000000000000000';

    // Sign the channel
    const signature = signChannel(signedMessages, keyBase64);

    const channelFile: EdgeChannelFile = {
      _type: 'openrappter-edge-channel',
      version: 1,
      channel: {
        id: exported.conversation.id,
        name: exported.conversation.name,
        participants: exported.conversation.participants,
        messageCount: exported.conversation.messageCount,
        headHash,
        path: `channels/${exported.conversation.id}.json`,
      },
      signature,
      messages: signedMessages,
    };

    return channelFile;
  }

  /**
   * Generate a manifest listing all published channels.
   */
  generateManifest(channels: EdgeChannelFile[]): EdgeManifest {
    return {
      _type: 'openrappter-edge-manifest',
      version: 1,
      publishedAt: new Date().toISOString(),
      channels: channels.map(c => c.channel),
    };
  }

  /**
   * Write channel file + manifest to the output directory.
   * Returns the file paths written.
   */
  async writeFiles(channelFile: EdgeChannelFile, manifest: EdgeManifest): Promise<string[]> {
    const { mkdir, writeFile } = await import('fs/promises');
    const { join } = await import('path');

    const channelDir = join(this.config.outputDir, 'channels');
    await mkdir(channelDir, { recursive: true });

    const channelPath = join(channelDir, `${channelFile.channel.id}.json`);
    const manifestPath = join(this.config.outputDir, 'manifest.json');

    await writeFile(channelPath, JSON.stringify(channelFile, null, 2));
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    return [channelPath, manifestPath];
  }
}

// ── Edge Puller (client-side) ────────────────────────────────────────────────

export class EdgePuller {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Fetch the manifest from the static host.
   */
  async fetchManifest(): Promise<EdgeManifest> {
    const res = await fetch(`${this.baseUrl}/manifest.json`);
    if (!res.ok) throw new Error(`Failed to fetch manifest: HTTP ${res.status}`);
    return res.json() as Promise<EdgeManifest>;
  }

  /**
   * Fetch a channel file from the static host.
   */
  async fetchChannel(channelMeta: EdgeChannelMeta): Promise<EdgeChannelFile> {
    const res = await fetch(`${this.baseUrl}/${channelMeta.path}`);
    if (!res.ok) throw new Error(`Failed to fetch channel: HTTP ${res.status}`);
    return res.json() as Promise<EdgeChannelFile>;
  }

  /**
   * Fetch and verify a channel. Throws if signature is invalid.
   */
  async fetchAndVerify(channelMeta: EdgeChannelMeta, keyBase64: string): Promise<EdgeChannelFile> {
    const channel = await this.fetchChannel(channelMeta);

    // Verify channel-level signature
    if (!verifyChannel(channel.messages, channel.signature, keyBase64)) {
      throw new Error('Channel signature verification failed — data may be tampered');
    }

    // Verify individual message HMACs
    for (const msg of channel.messages) {
      if (!verifyBlob(msg, keyBase64)) {
        throw new Error(`Message ${msg.id} HMAC verification failed — message may be tampered`);
      }
    }

    return channel;
  }

  /**
   * Incremental sync — only fetch if head hash changed.
   */
  async syncIfChanged(
    channelMeta: EdgeChannelMeta,
    lastKnownHeadHash: string,
    keyBase64: string,
  ): Promise<{ changed: boolean; channel?: EdgeChannelFile }> {
    // Fetch fresh manifest to check head hash
    const manifest = await this.fetchManifest();
    const freshMeta = manifest.channels.find(c => c.id === channelMeta.id);
    if (!freshMeta) return { changed: false };

    if (freshMeta.headHash === lastKnownHeadHash) {
      return { changed: false };
    }

    const channel = await this.fetchAndVerify(freshMeta, keyBase64);
    return { changed: true, channel };
  }
}
