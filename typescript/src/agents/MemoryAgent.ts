import { openrappterHome, openrappterPath } from '../infra/openrappter-home.js';
/**
 * MemoryAgent - Memory storage and recall agent.
 *
 * Stores and retrieves facts in persistent memory.
 * Combines ManageMemory and ContextMemory functionality.
 *
 * Mirrors Python agents/manage_memory_agent.py and context_memory_agent.py
 */

import { randomUUID } from 'crypto';
import path from 'path';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata, MemoryEcho } from './types.js';
import { MemoryStoreError, readMemoryFile, withMemoryTransaction, writeMemoryFile } from '../memory/json-store.js';


export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/memory',
  version: '1.0.0',
  display_name: 'Memory',
  description: 'Stores and recalls facts in persistent memory. Use \'remember\' to store, \'recall\' to retrieve.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: [
    'filesystem-write'
  ],
  tags: [
    'openrappter',
    'memory'
  ],
  category: 'memory',
  quality_tier: 'official',
  requires_env: []
} as const;
interface MemoryEntry {
  id?: string;
  message: string;
  theme: string;
  importance?: number;
  tags?: string[];
  date?: string;
  time?: string;
  timestamp: string;
  accessed?: number;
}

export class MemoryAgent extends BasicAgent {
  private memoryFile: string;

  constructor(memoryDir = openrappterHome()) {
    const metadata: AgentMetadata = {
      name: 'Memory',
      description: 'Stores and recalls facts in persistent memory. Use "remember" to store, "recall" to retrieve.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action to perform.',
            enum: ['remember', 'recall', 'list', 'forget'],
          },
          message: {
            type: 'string',
            description: 'The fact or information to store (for remember action).',
          },
          query: {
            type: 'string',
            description: 'Search query to find relevant memories (for recall action).',
          },
          theme: {
            type: 'string',
            description: 'Category/theme for the memory (e.g., preference, fact, insight, task).',
          },
          importance: {
            type: 'number',
            description: 'Importance rating 1-5 (default 3).',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Categorical tags for the memory.',
          },
        },
        required: [],
      },
    };
    super('Memory', metadata);

    this.memoryFile = path.join(memoryDir, 'memory.json');
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    let action = kwargs.action as string | undefined;
    const message = kwargs.message as string | undefined;
    const query = kwargs.query as string | undefined;
    const theme = (kwargs.theme as string) || 'general';
    const importance = kwargs.importance as number | undefined;
    const tags = kwargs.tags as string[] | undefined;

    // Infer action from query if not specified
    if (!action && query) {
      const qLower = query.toLowerCase();
      if (qLower.startsWith('remember ') || qLower.includes('store ') || qLower.includes('save ')) {
        action = 'remember';
      } else if (qLower.startsWith('forget ') || qLower.includes('delete ')) {
        action = 'forget';
      } else {
        action = 'recall';
      }
    }

    switch (action) {
      case 'remember':
        return withMemoryTransaction(this.memoryFile, () =>
          this.remember(message || query || '', theme, importance, tags));
      case 'recall':
        return this.recall(query || message || '');
      case 'list':
        return this.listMemories();
      case 'forget':
        return withMemoryTransaction(this.memoryFile, () => this.forget(query || message || ''));
      default:
        // Default to recall if query provided, otherwise list
        if (query || message) {
          return this.recall(query || message || '');
        }
        return this.listMemories();
    }
  }

  /**
   * Override sloshMemory to integrate with our storage
   */
  protected sloshMemory(_query: string): MemoryEcho[] {
    // Synchronous version for sloshing - returns empty, actual search in recall()
    return [];
  }

  /** Load all memory entries — used by Assistant for context injection */
  static async loadAllMemories(): Promise<Record<string, MemoryEntry>> {
    return readMemoryFile<MemoryEntry>(openrappterPath('memory.json'));
  }

  private loadMemory(): Record<string, MemoryEntry> {
    return readMemoryFile<MemoryEntry>(this.memoryFile);
  }

  private saveMemory(memory: Record<string, MemoryEntry>): void {
    writeMemoryFile(this.memoryFile, memory);
  }

  private remember(message: string, theme: string, importance?: number, tags?: string[]): string {
    if (!message) {
      return JSON.stringify({ status: 'error', message: 'No message provided to remember' });
    }

    // Clean the message
    let cleanMessage = message;
    for (const prefix of ['remember ', 'store ', 'save ', 'note that ', 'keep in mind ']) {
      if (cleanMessage.toLowerCase().startsWith(prefix)) {
        cleanMessage = cleanMessage.slice(prefix.length).trim();
        break;
      }
    }

    const memory = this.loadMemory();

    // Deduplicate: skip if an identical or very similar message already exists
    const normalised = cleanMessage.toLowerCase().trim();
    for (const entry of Object.values(memory)) {
      if (entry.message.toLowerCase().trim() === normalised) {
        return JSON.stringify({
          status: 'success',
          message: `Already remembered: "${entry.message}"`,
          theme: entry.theme,
          duplicate: true,
        });
      }
    }

    const ids = new Set(Object.values(memory).map(entry => entry.id));
    let id = '';
    for (let attempt = 0; attempt < 16; attempt++) {
      const candidate = randomUUID().replace(/-/g, '').slice(0, 12);
      if (!ids.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (!id) throw new MemoryStoreError('Could not allocate a unique memory id');
    let sequence = Date.now();
    while (Object.hasOwn(memory, `mem_${sequence}`)) sequence++;
    const key = `mem_${sequence}`;
    const now = new Date();

    memory[key] = {
      id,
      message: cleanMessage,
      theme,
      importance: importance ?? 3,
      tags: tags ?? [],
      date: now.toISOString().split('T')[0],
      time: now.toTimeString().split(' ')[0],
      timestamp: now.toISOString(),
      accessed: 0,
    };

    this.saveMemory(memory);

    return JSON.stringify({
      status: 'success',
      message: `Remembered: "${cleanMessage}"`,
      theme,
      key,
    });
  }

  private async recall(query: string): Promise<string> {
    const memory = await this.loadMemory();
    const entries = Object.entries(memory);

    if (entries.length === 0) {
      return JSON.stringify({
        status: 'info',
        message: 'No memories stored yet.',
        matches: [],
      });
    }

    if (!query) {
      // Return recent memories
      const recent = entries
        .sort((a, b) => (b[1].timestamp || '').localeCompare(a[1].timestamp || ''))
        .slice(0, 5)
        .map(([key, entry]) => ({
          key,
          message: entry.message,
          theme: entry.theme,
        }));

      return JSON.stringify({
        status: 'success',
        message: 'Recent memories:',
        matches: recent,
      });
    }

    // Search memories
    const queryWords = new Set(query.toLowerCase().split(/\s+/));
    const matches: Array<{ key: string; message: string; theme: string; relevance: number }> = [];

    for (const [key, entry] of entries) {
      const messageWords = new Set(entry.message.toLowerCase().split(/\s+/));
      const overlap = [...queryWords].filter(w => messageWords.has(w)).length;
      
      if (overlap > 0) {
        matches.push({
          key,
          message: entry.message,
          theme: entry.theme,
          relevance: overlap / queryWords.size,
        });
      }
    }

    matches.sort((a, b) => b.relevance - a.relevance);

    if (matches.length === 0) {
      return JSON.stringify({
        status: 'info',
        message: `No memories found matching "${query}"`,
        matches: [],
      });
    }

    return JSON.stringify({
      status: 'success',
      message: `Found ${matches.length} matching memories`,
      matches: matches.slice(0, 5),
    });
  }

  private async listMemories(): Promise<string> {
    const memory = await this.loadMemory();
    const entries = Object.entries(memory);

    if (entries.length === 0) {
      return JSON.stringify({
        status: 'info',
        message: 'No memories stored yet.',
        count: 0,
        memories: [],
      });
    }

    const memories = entries
      .sort((a, b) => (b[1].timestamp || '').localeCompare(a[1].timestamp || ''))
      .slice(0, 20)
      .map(([key, entry]) => ({
        key,
        message: entry.message.slice(0, 100) + (entry.message.length > 100 ? '...' : ''),
        theme: entry.theme,
      }));

    return JSON.stringify({
      status: 'success',
      count: entries.length,
      showing: memories.length,
      memories,
    });
  }

  private forget(query: string): string {
    if (!query) {
      return JSON.stringify({ status: 'error', message: 'No query provided to forget' });
    }

    const memory = this.loadMemory();
    
    // Clean the query
    let searchQuery = query;
    for (const prefix of ['forget ', 'delete ', 'remove ']) {
      if (searchQuery.toLowerCase().startsWith(prefix)) {
        searchQuery = searchQuery.slice(prefix.length).trim();
        break;
      }
    }

    // Find matching entries
    const toDelete: string[] = [];
    for (const [key, entry] of Object.entries(memory)) {
      if (entry.message.toLowerCase().includes(searchQuery.toLowerCase()) || key === searchQuery) {
        toDelete.push(key);
      }
    }

    if (toDelete.length === 0) {
      return JSON.stringify({
        status: 'info',
        message: `No memories found matching "${searchQuery}"`,
      });
    }

    for (const key of toDelete) {
      delete memory[key];
    }

    this.saveMemory(memory);

    return JSON.stringify({
      status: 'success',
      message: `Forgot ${toDelete.length} memory/memories`,
      deleted: toDelete,
    });
  }
}
