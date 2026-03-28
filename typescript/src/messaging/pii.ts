/**
 * PII Stripping & Reattachment — Lispy VM Privacy Boundary
 *
 * Strips PII from messages BEFORE encryption, stores the PII map
 * locally in the VM. Published blobs never contain PII even if
 * decrypted. Reattachment happens client-side only.
 *
 * Pattern:
 *   "Hey Kody, email me at kody@test.com"
 *   → stripped: "Hey [P:1], email me at [P:2]"
 *   → piiMap: { "P:1": "Kody", "P:2": "kody@test.com" }
 *   → only stripped text gets encrypted and published
 *   → piiMap stays in local VM, never leaves the device
 */

// ── PII Detection Patterns ──────────────────────────────────────────────────

const PII_PATTERNS: Array<{ type: string; regex: RegExp }> = [
  // Email addresses
  { type: 'email', regex: /\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b/g },
  // Phone numbers (various formats)
  { type: 'phone', regex: /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  // SSN
  { type: 'ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card numbers (basic)
  { type: 'cc', regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g },
  // IP addresses
  { type: 'ip', regex: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  // iCloud / Apple IDs (common pattern)
  { type: 'appleid', regex: /\b[a-zA-Z0-9._%+\-]+@(?:icloud|me|mac)\.com\b/g },
];

// Known names — populated per conversation from participants + detected names
const NAME_PATTERN = /\b[A-Z][a-z]{2,15}\b/g;

// ── Types ────────────────────────────────────────────────────────────────────

export interface PIIMap {
  [token: string]: string; // "P:1" → "Kody"
}

export interface StrippedResult {
  stripped: string;
  piiMap: PIIMap;
  piiCount: number;
}

export interface PIIVaultEntry {
  messageId: string;
  conversationId: string;
  piiMap: PIIMap;
  timestamp: string;
}

// ── PIIStripper ──────────────────────────────────────────────────────────────

export class PIIStripper {
  /** Known names to always strip (populated from conversation participants) */
  private knownNames: Set<string> = new Set();
  /** Custom patterns added at runtime */
  private customPatterns: Array<{ type: string; regex: RegExp }> = [];

  addKnownNames(names: string[]): void {
    for (const name of names) {
      if (name.length >= 2) this.knownNames.add(name.toLowerCase());
    }
  }

  addPattern(type: string, regex: RegExp): void {
    this.customPatterns.push({ type, regex: new RegExp(regex.source, regex.flags) });
  }

  /**
   * Strip PII from text. Returns sanitized text + PII map.
   * The PII map MUST be stored locally — never publish it.
   */
  strip(text: string): StrippedResult {
    const piiMap: PIIMap = {};
    let counter = 0;
    let stripped = text;

    // Track what we've already replaced to avoid double-tokenizing
    const replaced = new Map<string, string>(); // original → token

    const replaceMatch = (match: string, type: string): string => {
      if (replaced.has(match)) return replaced.get(match)!;
      counter++;
      const token = `[P:${counter}]`;
      piiMap[`P:${counter}`] = match;
      replaced.set(match, token);
      return token;
    };

    // Run all built-in patterns
    for (const { type, regex } of [...PII_PATTERNS, ...this.customPatterns]) {
      // Reset regex state
      const re = new RegExp(regex.source, regex.flags);
      stripped = stripped.replace(re, (match) => replaceMatch(match, type));
    }

    // Strip known names (case-insensitive word boundary match)
    for (const name of this.knownNames) {
      const re = new RegExp(`\\b${escapeRegex(name)}\\b`, 'gi');
      stripped = stripped.replace(re, (match) => replaceMatch(match, 'name'));
    }

    return { stripped, piiMap, piiCount: counter };
  }

  /**
   * Reattach PII from a local map. Client-side only.
   */
  reattach(stripped: string, piiMap: PIIMap): string {
    let result = stripped;
    for (const [token, value] of Object.entries(piiMap)) {
      result = result.replace(new RegExp(`\\[${escapeRegex(token)}\\]`, 'g'), value);
    }
    return result;
  }
}

// ── PII Vault (local-only storage) ──────────────────────────────────────────

/**
 * Local PII vault — stores PII maps per message.
 * This NEVER leaves the device. It's the client-side half
 * of the privacy boundary.
 */
export class PIIVault {
  private entries = new Map<string, PIIVaultEntry>(); // messageId → entry

  store(messageId: string, conversationId: string, piiMap: PIIMap): void {
    this.entries.set(messageId, {
      messageId,
      conversationId,
      piiMap,
      timestamp: new Date().toISOString(),
    });
  }

  get(messageId: string): PIIMap | undefined {
    return this.entries.get(messageId)?.piiMap;
  }

  getForConversation(conversationId: string): PIIVaultEntry[] {
    return Array.from(this.entries.values())
      .filter(e => e.conversationId === conversationId);
  }

  remove(messageId: string): void {
    this.entries.delete(messageId);
  }

  clear(conversationId?: string): void {
    if (conversationId) {
      for (const [id, entry] of this.entries) {
        if (entry.conversationId === conversationId) this.entries.delete(id);
      }
    } else {
      this.entries.clear();
    }
  }

  size(): number {
    return this.entries.size;
  }

  /**
   * Export vault for local backup (encrypted separately by caller).
   * NEVER publish this — it contains raw PII.
   */
  export(): PIIVaultEntry[] {
    return Array.from(this.entries.values());
  }

  import(entries: PIIVaultEntry[]): void {
    for (const entry of entries) {
      this.entries.set(entry.messageId, entry);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
