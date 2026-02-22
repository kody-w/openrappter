/**
 * Stream Weaver — StreamManager sessions, blocks, deltas, subscribers
 *
 * Run: npx tsx examples/stream-weaver.ts
 */

import { StreamManager } from '../src/gateway/streaming.js';

async function main() {
  console.log('=== Stream Weaver ===\n');

  const manager = new StreamManager();

  // Step 1: Sessions + blocks
  console.log('Step 1: Sessions and blocks...');
  const session = manager.createSession('demo_1');
  console.log(`  Session: ${session.id}, status: ${session.status}`);

  manager.pushBlock('demo_1', { type: 'text', content: 'Hello', done: false });
  manager.pushBlock('demo_1', { type: 'tool_call', content: '{"name":"search"}', done: true });
  console.log(`  Blocks: ${manager.getSession('demo_1')?.blocks.length}\n`);

  // Step 2: Deltas + subscribers
  console.log('Step 2: Deltas and subscribers...');
  manager.createSession('demo_2');
  const received: string[] = [];
  manager.onBlock('demo_2', (block) => received.push(block.content));

  manager.pushDelta('demo_2', 'b1', 'Hel');
  manager.pushDelta('demo_2', 'b1', 'lo ');
  manager.pushDelta('demo_2', 'b1', 'world');
  console.log(`  Accumulated: "${manager.getSession('demo_2')?.blocks[0].content}"`);
  console.log(`  Subscriber notifications: ${received.length}\n`);

  // Step 3: Lifecycle
  console.log('Step 3: Lifecycle...');
  manager.complete('demo_1');
  manager.error('demo_2');
  console.log(`  Active sessions: ${manager.activeSessions()}`);
  console.log(`  demo_1 status: ${manager.getSession('demo_1')?.status}`);
  console.log(`  demo_2 status: ${manager.getSession('demo_2')?.status}`);
}

main().catch(console.error);
