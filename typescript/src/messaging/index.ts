/**
 * OpenRappter Messaging — Encrypted, PII-stripped, Edge-synced
 *
 * Three-layer privacy:
 *   1. AES-256-GCM encryption (per-conversation keys)
 *   2. PII stripped before encryption (never in public blobs)
 *   3. HMAC-SHA256 signing (tamper detection)
 *
 * Architecture:
 *   Message → PIIStripper → Encrypt → HMAC Sign → Publish to static host
 *   Static host → Fetch → Verify HMAC → Decrypt → PIIVault reattach (local only)
 */

export { EncryptedMessageStore } from './store.js';
export type { TwinMessage, EncryptedBlob, Conversation, ConversationExport, StoreOptions } from './store.js';

export { PIIStripper, PIIVault } from './pii.js';
export type { PIIMap, StrippedResult, PIIVaultEntry } from './pii.js';

export { EdgePublisher, EdgePuller, signBlob, verifyBlob, signChannel, verifyChannel } from './edge-sync.js';
export type { EdgeManifest, EdgeChannelMeta, EdgeChannelFile, SignedBlob, EdgeSyncConfig } from './edge-sync.js';
