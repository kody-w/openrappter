/**
 * Healing Loop — SelfHealingCronAgent showcase
 *
 * Run: npx tsx examples/healing-loop.ts
 */

import { SelfHealingCronAgent } from '../src/agents/SelfHealingCronAgent.js';
import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata } from '../src/agents/types.js';

class MockWebAgent extends BasicAgent {
  private responses: Array<{ status: string }>;
  private idx = 0;
  constructor(responses: Array<{ status: string }>) {
    super('MockWeb', { name: 'MockWeb', description: 'Mock', parameters: { type: 'object', properties: {}, required: [] } });
    this.responses = responses;
  }
  async perform(): Promise<string> {
    return JSON.stringify(this.responses[Math.min(this.idx++, this.responses.length - 1)]);
  }
}

class MockShellAgent extends BasicAgent {
  constructor() {
    super('MockShell', { name: 'MockShell', description: 'Mock', parameters: { type: 'object', properties: {}, required: [] } });
  }
  async perform(): Promise<string> { return JSON.stringify({ status: 'success', output: 'restarted' }); }
}

class MockMessageAgent extends BasicAgent {
  constructor() {
    super('MockMessage', { name: 'MockMessage', description: 'Mock', parameters: { type: 'object', properties: {}, required: [] } });
  }
  async perform(): Promise<string> { return JSON.stringify({ status: 'success' }); }
}

async function main() {
  console.log('=== Healing Loop ===\n');

  // Step 1: Setup
  console.log('Step 1: Setup job...');
  const agent = new SelfHealingCronAgent();
  agent.setAgents({
    webAgent: new MockWebAgent([{ status: 'success' }]),
    shellAgent: new MockShellAgent(),
    messageAgent: new MockMessageAgent(),
  });
  const setup = JSON.parse(await agent.execute({
    action: 'setup', name: 'api-health', url: 'http://localhost/health',
    restartCommand: 'systemctl restart api', notifyChannel: 'slack', conversationId: 'C1',
  }));
  console.log(`  Job created: ${setup.job.name}\n`);

  // Step 2: Healthy check
  console.log('Step 2: Healthy check...');
  const check = JSON.parse(await agent.execute({ action: 'check', name: 'api-health' }));
  console.log(`  Healthy: ${check.healthy}, Action: ${check.data_slush?.action_taken}\n`);

  // Step 3: Status
  console.log('Step 3: Status...');
  const status = JSON.parse(await agent.execute({ action: 'status', name: 'api-health' }));
  console.log(`  Uptime: ${status.stats.uptimePercent}%, Checks: ${status.stats.totalChecks}\n`);

  // Step 4: Teardown
  console.log('Step 4: Teardown...');
  const teardown = JSON.parse(await agent.execute({ action: 'teardown', name: 'api-health' }));
  console.log(`  Result: ${teardown.status}`);
}

main().catch(console.error);
