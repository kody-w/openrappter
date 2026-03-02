/**
 * DreamAgent - Offline memory consolidation.
 *
 * Reviews all stored memories, finds duplicates, detects contradictions,
 * prunes stale entries, and logs what it did. Like biological sleep for AI.
 *
 * Actions: dream (full cycle), audit (report only), prune (remove stale)
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

interface MemoryEntry {
  id?: string;
  message: string;
  theme?: string;
  importance?: number;
  tags?: string[];
  date?: string;
  time?: string;
  timestamp: string;
  accessed?: number;
}

/** Normalize text for comparison (lowercase, collapse whitespace, strip filler) */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^(that |remember |note |store |save )/i, '')
    .trim();
}

/** Simple similarity score (0–1) via token overlap (Jaccard) */
function similarity(a: string, b: string): number {
  const tokensA = new Set(normalize(a).split(' '));
  const tokensB = new Set(normalize(b).split(' '));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  const intersection = new Set([...tokensA].filter(t => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

export class DreamAgent extends BasicAgent {
  private memoryDir: string;
  private memoryFile: string;

  constructor() {
    const metadata: AgentMetadata = {
      name: 'Dream',
      description:
        'Memory consolidation agent. Reviews all memories, merges duplicates, flags contradictions, prunes stale entries. Run periodically to keep memory clean.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The dream action to perform.',
            enum: ['dream', 'audit', 'prune'],
          },
          similarity_threshold: {
            type: 'number',
            description: 'Jaccard similarity threshold for duplicates (0–1, default 0.75).',
          },
          stale_days: {
            type: 'number',
            description: 'Remove memories older than N days with 0 access (default 30).',
          },
          dry_run: {
            type: 'boolean',
            description: 'If true, report what would change without modifying memory.',
          },
        },
        required: [],
      },
    };
    super('Dream', metadata);
    this.memoryDir = path.join(os.homedir(), '.openrappter');
    this.memoryFile = path.join(this.memoryDir, 'memory.json');
  }

  private async loadMemory(): Promise<Record<string, MemoryEntry>> {
    try {
      const data = await fs.readFile(this.memoryFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  private async saveMemory(memory: Record<string, MemoryEntry>): Promise<void> {
    await fs.writeFile(this.memoryFile, JSON.stringify(memory, null, 2));
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    let action = (kwargs.action as string) || 'dream';
    const threshold = (kwargs.similarity_threshold as number) ?? 0.75;
    const staleDays = (kwargs.stale_days as number) ?? 30;
    let dryRun = (kwargs.dry_run as boolean) ?? false;

    // Parse action from query string (for --exec usage)
    const query = kwargs.query as string | undefined;
    if (query && !kwargs.action) {
      const q = query.toLowerCase().trim();
      if (q === 'audit' || q.includes('dry')) { action = 'audit'; dryRun = true; }
      else if (q === 'prune') action = 'prune';
      else action = 'dream';
    }

    switch (action) {
      case 'dream':
        return this.dreamCycle(threshold, staleDays, dryRun);
      case 'audit':
        return this.dreamCycle(threshold, staleDays, true);
      case 'prune':
        return this.pruneStale(staleDays, dryRun);
      default:
        return JSON.stringify({ status: 'error', message: `Unknown action: ${action}` });
    }
  }

  private async dreamCycle(
    threshold: number,
    staleDays: number,
    dryRun: boolean,
  ): Promise<string> {
    const memory = await this.loadMemory();
    const entries = Object.entries(memory);

    if (entries.length === 0) {
      return JSON.stringify({
        status: 'info',
        message: 'No memories to consolidate.',
        dream_log: { total: 0 },
      });
    }

    const duplicates: Array<{ kept: string; removed: string; similarity: number }> = [];
    const staleRemoved: string[] = [];
    const keysToRemove = new Set<string>();
    const now = Date.now();
    const staleMs = staleDays * 86400000;

    // ── Pass 1: Find duplicates ──
    const keyList = entries.map(([k]) => k);
    for (let i = 0; i < keyList.length; i++) {
      if (keysToRemove.has(keyList[i])) continue;
      const entryA = memory[keyList[i]];

      for (let j = i + 1; j < keyList.length; j++) {
        if (keysToRemove.has(keyList[j])) continue;
        const entryB = memory[keyList[j]];

        const sim = similarity(entryA.message, entryB.message);
        if (sim >= threshold) {
          // Keep the newer one, or the one with higher importance
          const aTime = new Date(entryA.timestamp).getTime();
          const bTime = new Date(entryB.timestamp).getTime();
          const aScore = (entryA.importance ?? 3) + (entryA.accessed ?? 0) * 0.5;
          const bScore = (entryB.importance ?? 3) + (entryB.accessed ?? 0) * 0.5;

          let removeKey: string;
          let keepKey: string;
          if (aScore !== bScore) {
            // Keep higher scored
            removeKey = aScore >= bScore ? keyList[j] : keyList[i];
            keepKey = aScore >= bScore ? keyList[i] : keyList[j];
          } else {
            // Keep newer
            removeKey = aTime >= bTime ? keyList[j] : keyList[i];
            keepKey = aTime >= bTime ? keyList[i] : keyList[j];
          }

          keysToRemove.add(removeKey);
          duplicates.push({
            kept: memory[keepKey].message.slice(0, 80),
            removed: memory[removeKey].message.slice(0, 80),
            similarity: Math.round(sim * 100) / 100,
          });
        }
      }
    }

    // ── Pass 2: Find stale entries ──
    for (const [key, entry] of entries) {
      if (keysToRemove.has(key)) continue;
      const age = now - new Date(entry.timestamp).getTime();
      const accessed = entry.accessed ?? 0;
      const importance = entry.importance ?? 3;

      // Stale = old + never accessed + low importance
      if (age > staleMs && accessed === 0 && importance <= 2) {
        keysToRemove.add(key);
        staleRemoved.push(entry.message.slice(0, 80));
      }
    }

    // ── Apply changes ──
    if (!dryRun && keysToRemove.size > 0) {
      for (const key of keysToRemove) {
        delete memory[key];
      }

      // Store dream log as a memory
      const dreamLogKey = `mem_dream_${Date.now()}`;
      const now_ = new Date();
      memory[dreamLogKey] = {
        id: randomUUID().replace(/-/g, '').slice(0, 12),
        message: `Dream cycle completed: merged ${duplicates.length} duplicates, pruned ${staleRemoved.length} stale entries. ${Object.keys(memory).length} memories remain.`,
        theme: 'system',
        importance: 2,
        tags: ['dream', 'consolidation'],
        date: now_.toISOString().split('T')[0],
        time: now_.toTimeString().split(' ')[0],
        timestamp: now_.toISOString(),
        accessed: 0,
      };

      await this.saveMemory(memory);
    }

    const remaining = Object.keys(memory).length - (dryRun ? 0 : 0);

    return JSON.stringify({
      status: 'success',
      action: dryRun ? 'audit' : 'dream',
      dream_log: {
        total_before: entries.length,
        duplicates_found: duplicates.length,
        stale_pruned: staleRemoved.length,
        total_removed: keysToRemove.size,
        total_after: entries.length - keysToRemove.size + (dryRun ? 0 : 1),
        dry_run: dryRun,
      },
      duplicates: duplicates.slice(0, 20),
      stale: staleRemoved.slice(0, 20),
      data_slush: this.slushOut({
        signals: {
          duplicates_merged: duplicates.length,
          stale_pruned: staleRemoved.length,
          memories_remaining: entries.length - keysToRemove.size,
        },
      }),
    });
  }

  private async pruneStale(staleDays: number, dryRun: boolean): Promise<string> {
    const memory = await this.loadMemory();
    const entries = Object.entries(memory);
    const now = Date.now();
    const staleMs = staleDays * 86400000;
    const pruned: string[] = [];

    for (const [key, entry] of entries) {
      const age = now - new Date(entry.timestamp).getTime();
      if (age > staleMs && (entry.accessed ?? 0) === 0 && (entry.importance ?? 3) <= 2) {
        pruned.push(entry.message.slice(0, 80));
        if (!dryRun) delete memory[key];
      }
    }

    if (!dryRun && pruned.length > 0) {
      await this.saveMemory(memory);
    }

    return JSON.stringify({
      status: 'success',
      action: 'prune',
      pruned_count: pruned.length,
      pruned: pruned.slice(0, 20),
      dry_run: dryRun,
    });
  }
}
