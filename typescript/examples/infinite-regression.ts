/**
 * Infinite Regression — SubAgentManager depth limits + loop detection
 *
 * Demonstrates the safety mechanisms that prevent recursive agent
 * calls from spiraling out of control.
 *
 * Run: npx tsx examples/infinite-regression.ts
 */

import { SubAgentManager } from '../src/agents/subagent.js';

async function main() {
  console.log('=== Infinite Regression: Depth Limits & Loop Detection ===\n');

  const manager = new SubAgentManager({ maxDepth: 3 });
  manager.setExecutor(async (agentId, message, context) => {
    console.log(`  Executing ${agentId} at depth ${context?.depth ?? 0}: "${message}"`);
    return { status: 'success', message: `${agentId} completed` };
  });

  // Demo 1: Depth limits
  console.log('--- Demo 1: Depth Limit (maxDepth=3) ---');
  const ctx = manager.createContext('RecursiveCreator');
  console.log(`  canInvoke at depth 0: ${manager.canInvoke('LearnNew', 0)}`);
  console.log(`  canInvoke at depth 2: ${manager.canInvoke('LearnNew', 2)}`);
  console.log(`  canInvoke at depth 3: ${manager.canInvoke('LearnNew', 3)}`);

  await manager.invoke('LearnNew', 'create agent level 1', ctx);

  // Simulate depth overflow
  const deepCtx = { ...ctx, depth: 3, callId: 'deep', parentAgentId: 'deep', history: [...ctx.history] };
  try {
    await manager.invoke('LearnNew', 'too deep!', deepCtx);
  } catch (e) {
    console.log(`  Depth limit caught: ${(e as Error).message}`);
  }

  // Demo 2: Loop detection
  console.log('\n--- Demo 2: Loop Detection ---');
  const loopManager = new SubAgentManager({ maxDepth: 10 });
  loopManager.setExecutor(async (agentId, message, context) => {
    console.log(`  Executing ${agentId} at depth ${context?.depth ?? 0}`);
    return { status: 'success' };
  });

  const loopCtx = loopManager.createContext('Orchestrator');
  await loopManager.invoke('SameAgent', 'call 1', loopCtx);
  await loopManager.invoke('SameAgent', 'call 2', loopCtx);
  await loopManager.invoke('SameAgent', 'call 3', loopCtx);

  try {
    await loopManager.invoke('SameAgent', 'call 4 — should fail', loopCtx);
  } catch (e) {
    console.log(`  Loop detected: ${(e as Error).message}`);
  }

  console.log('\nDone. Safety mechanisms working correctly.');
}

main().catch(console.error);
