/**
 * Authorization Fortress — ApprovalManager policies and request flows
 *
 * Run: npx tsx examples/auth-fortress.ts
 */

import { createApprovalManager } from '../src/security/approvals.js';

async function main() {
  console.log('=== Authorization Fortress ===\n');

  const manager = createApprovalManager();

  // Step 1: Policies
  console.log('Step 1: Policies...');
  manager.setDefaultPolicy('deny');
  const denied = manager.checkApproval({ toolName: 'bash', toolArgs: {} });
  console.log(`  Deny policy → allowed: ${denied.allowed}`);

  manager.setDefaultPolicy('full');
  const allowed = manager.checkApproval({ toolName: 'bash', toolArgs: {} });
  console.log(`  Full policy → allowed: ${allowed.allowed}\n`);

  // Step 2: Priority + scoping
  console.log('Step 2: Priority and scoping...');
  manager.setDefaultPolicy('allowlist');
  manager.addRule({
    id: 'low', name: 'Allow', policy: 'full', tools: ['bash'],
    priority: 1, enabled: true,
  });
  manager.addRule({
    id: 'high', name: 'Block', policy: 'deny', tools: ['bash'],
    priority: 100, enabled: true,
  });
  const priority = manager.checkApproval({ toolName: 'bash', toolArgs: {} });
  console.log(`  Priority winner: ${priority.rule?.id} (allowed: ${priority.allowed})\n`);

  // Step 3: Request/approve/reject
  console.log('Step 3: Request/approve/reject...');
  manager.removeRule('low');
  manager.removeRule('high');

  const promise = manager.requestApproval({ toolName: 'write', toolArgs: {} });
  const pending = manager.getPendingRequests();
  console.log(`  Pending requests: ${pending.length}`);
  manager.approveRequest(pending[0].id, 'admin');
  const result = await promise;
  console.log(`  Approved: ${result.allowed}`);
}

main().catch(console.error);
