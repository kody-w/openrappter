/**
 * Allowlist Manager
 * Manages allowlists for tools, commands, domains, and senders
 */

export interface AllowlistEntry {
  pattern: string;
  type: 'tool' | 'command' | 'domain' | 'sender';
  addedAt: string;
}

export class Allowlist {
  private entries: AllowlistEntry[] = [];

  /**
   * Add a pattern to the allowlist
   */
  add(pattern: string, type: AllowlistEntry['type']): void {
    // Check if already exists
    const exists = this.entries.some(
      (e) => e.pattern === pattern && e.type === type
    );

    if (!exists) {
      this.entries.push({
        pattern,
        type,
        addedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Remove a pattern from the allowlist
   */
  remove(pattern: string): boolean {
    const initialLength = this.entries.length;
    this.entries = this.entries.filter((e) => e.pattern !== pattern);
    return this.entries.length < initialLength;
  }

  /**
   * Check if a value matches any pattern in the allowlist
   * Supports glob-like matching (startsWith for prefix*, exact match otherwise)
   */
  check(value: string, type: AllowlistEntry['type']): boolean {
    const matchingEntries = this.entries.filter((e) => e.type === type);

    for (const entry of matchingEntries) {
      // Glob-like matching: pattern* matches prefix
      if (entry.pattern.endsWith('*')) {
        const prefix = entry.pattern.slice(0, -1);
        if (value.startsWith(prefix)) {
          return true;
        }
      } else {
        // Exact match
        if (value === entry.pattern) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * List entries, optionally filtered by type
   */
  list(type?: AllowlistEntry['type']): AllowlistEntry[] {
    if (type) {
      return this.entries.filter((e) => e.type === type);
    }
    return [...this.entries];
  }

  /**
   * Clear entries, optionally filtered by type
   */
  clear(type?: AllowlistEntry['type']): void {
    if (type) {
      this.entries = this.entries.filter((e) => e.type !== type);
    } else {
      this.entries = [];
    }
  }
}
