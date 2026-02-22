/**
 * Memory Recall — MemoryManager FTS, chunking, snippets, lifecycle
 *
 * Run: npx tsx examples/memory-recall.ts
 */

import { MemoryManager } from '../src/memory/manager.js';
import { chunkContent, generateSnippet } from '../src/memory/chunker.js';

async function main() {
  console.log('=== Memory Recall ===\n');

  // Step 1: Chunking
  console.log('Step 1: Content chunking...');
  const longContent = 'word '.repeat(200).trim();
  const chunks = chunkContent(longContent, { chunkSize: 100, overlap: 20 });
  console.log(`  Input: ${longContent.length} chars → ${chunks.length} chunks\n`);

  // Step 2: Add documents and search
  console.log('Step 2: Add documents and FTS search...');
  const manager = new MemoryManager({ chunkSize: 512 });
  await manager.add('AgentGraph executes DAG nodes in parallel', 'workspace', '/graph.md');
  await manager.add('ChannelRegistry routes messages to channels', 'workspace', '/channels.md');
  await manager.add('MemoryManager provides FTS and vector search', 'memory', '/memory.md');

  const results = await manager.searchFts('AgentGraph parallel');
  console.log(`  Found ${results.length} results for "AgentGraph parallel"`);
  for (const r of results) {
    console.log(`    score=${r.score.toFixed(2)} source=${r.chunk.sourcePath}`);
  }

  // Step 3: Lifecycle
  console.log('\nStep 3: Lifecycle...');
  console.log(`  Status: ${JSON.stringify(manager.getStatus())}`);
  manager.removeBySourcePath('/channels.md');
  console.log(`  After remove: ${JSON.stringify(manager.getStatus())}`);
  manager.clear();
  console.log(`  After clear: ${JSON.stringify(manager.getStatus())}`);
}

main().catch(console.error);
