/**
 * MemoryAgent - Memory storage and recall agent.
 *
 * Stores and retrieves facts in persistent memory.
 * Combines ManageMemory and ContextMemory functionality.
 *
 * Mirrors Python agents/manage_memory_agent.py and context_memory_agent.py
 */

import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata, MemoryEcho } from './types.js';

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
  private memoryDir: string;
  private memoryFile: string;

  constructor() {
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

    this.memoryDir = path.join(os.homedir(), '.openrappter');
    this.memoryFile = path.join(this.memoryDir, 'memory.json');
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
        return this.remember(message || query || '', theme, importance, tags);
      case 'recall':
        return this.recall(query || message || '');
      case 'list':
        return this.listMemories();
      case 'forget':
        return this.forget(query || message || '');
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
    const memFile = path.join(os.homedir(), '.openrappter', 'memory.json');
    try {
      const data = await fs.readFile(memFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  private async loadMemory(): Promise<Record<string, MemoryEntry>> {
    try {
      await fs.mkdir(this.memoryDir, { recursive: true });
      const data = await fs.readFile(this.memoryFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  private async saveMemory(memory: Record<string, MemoryEntry>): Promise<void> {
    await fs.mkdir(this.memoryDir, { recursive: true });
    await fs.writeFile(this.memoryFile, JSON.stringify(memory, null, 2));
  }

  private async remember(message: string, theme: string, importance?: number, tags?: string[]): Promise<string> {
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

    const memory = await this.loadMemory();
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const key = `mem_${Date.now()}`;
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

    await this.saveMemory(memory);

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

  private async forget(query: string): Promise<string> {
    if (!query) {
      return JSON.stringify({ status: 'error', message: 'No query provided to forget' });
    }

    const memory = await this.loadMemory();
    
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

    await this.saveMemory(memory);

    return JSON.stringify({
      status: 'success',
      message: `Forgot ${toDelete.length} memory/memories`,
      deleted: toDelete,
    });
  }
}
