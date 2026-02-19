/**
 * Memory Command
 * CLI interface for the OpenRappter memory system.
 * Subcommands: search, add, list, clear, stats
 */

import type { Command } from 'commander';
import { MemoryManager } from '../memory/manager.js';

function createManager(): MemoryManager {
  return new MemoryManager();
}

export function registerMemoryCommand(program: Command): void {
  const memory = program.command('memory').description('Manage agent memory');

  memory
    .command('search <query>')
    .description('Search memories using a natural language query')
    .option('-l, --limit <n>', 'Maximum number of results', '10')
    .option('-t, --threshold <n>', 'Minimum similarity score (0-1)', '0')
    .action(async (query: string, options: { limit: string; threshold: string }) => {
      const manager = createManager();
      const limit = parseInt(options.limit, 10);
      const threshold = parseFloat(options.threshold);

      const results = await manager.search(query, { limit, threshold });

      if (results.length === 0) {
        console.log('No memories found.');
        return;
      }

      console.log(`\nFound ${results.length} memory chunk(s):\n`);
      for (const r of results) {
        const score = r.score.toFixed(2);
        console.log(`  (${score}) ${r.chunk.content.slice(0, 120)}`);
        if (r.chunk.content.length > 120) console.log('         ...');
        console.log(`    [source: ${r.chunk.source}, created: ${r.chunk.createdAt}]`);
        console.log('');
      }
    });

  memory
    .command('add <content>')
    .description('Add a new memory entry')
    .option('-s, --source <source>', 'Memory source (session|workspace|memory)', 'memory')
    .action(async (content: string, options: { source: string }) => {
      const manager = createManager();
      const source = options.source as 'session' | 'workspace' | 'memory';
      const id = await manager.add(content, source, '', {});
      console.log(`Memory added: ${id}`);
    });

  memory
    .command('list')
    .description('List recent memories')
    .option('-l, --limit <n>', 'Maximum number of entries to show', '20')
    .action(async (options: { limit: string }) => {
      const manager = createManager();
      const limit = parseInt(options.limit, 10);

      const chunks = manager.listChunks().slice(0, limit);

      if (chunks.length === 0) {
        console.log('No memories stored.');
        return;
      }

      console.log(`\nRecent Memories (${chunks.length}):\n`);
      for (const chunk of chunks) {
        console.log(`  [${chunk.id}] ${chunk.content.slice(0, 80)}${chunk.content.length > 80 ? '...' : ''}`);
        console.log(`    source: ${chunk.source} | created: ${chunk.createdAt}`);
        console.log('');
      }
    });

  memory
    .command('clear')
    .description('Clear all memories')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (options: { yes?: boolean }) => {
      if (!options.yes) {
        console.log('WARNING: This will delete all memories.');
        console.log('Run with --yes to confirm.');
        return;
      }

      const manager = createManager();
      const before = manager.getStatus().totalChunks;
      manager.clear();

      console.log(`Cleared ${before} memory chunk(s).`);
    });

  memory
    .command('stats')
    .description('Show memory statistics')
    .action(async () => {
      const manager = createManager();
      const status = manager.getStatus();

      console.log('\nMemory Statistics:\n');
      console.log(`  Total chunks:   ${status.totalChunks}`);
      console.log(`  Indexed chunks: ${status.indexedChunks}`);
      console.log(`  Pending sync:   ${status.pendingSync}`);
      if (status.lastSync) {
        console.log(`  Last sync:      ${status.lastSync}`);
      }
      console.log('');
    });
}
