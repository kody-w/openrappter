/**
 * Data Sloshing Deep Dive — Full slosh pipeline showcase
 *
 * Demonstrates: signal categories, SloshFilter, SloshPrivacy,
 * debug handler, feedback loop, breadcrumbs, and getSignal().
 *
 * Run: npx tsx examples/slosh-deep-dive.ts
 */

import { BasicAgent } from '../src/agents/BasicAgent.js';
import type { AgentMetadata, SloshDebugEvent } from '../src/agents/types.js';

class SloshTestAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'SloshTest',
      description: 'Captures slosh context for inspection',
      parameters: { type: 'object', properties: {}, required: [] },
    };
    super('SloshTest', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      status: 'success',
      context_keys: this.context ? Object.keys(this.context) : [],
      data_slush: { source_agent: 'SloshTest', captured: true },
    });
  }
}

async function main() {
  console.log('=== Data Sloshing Deep Dive ===\n');

  // Step 1: Default slosh with all categories
  console.log('Step 1: Default slosh (all categories)...');
  const agent = new SloshTestAgent();
  await agent.execute({ query: 'show me recent items' });
  console.log(`  Temporal: ${agent.context!.temporal.time_of_day}`);
  console.log(`  Query specificity: ${agent.context!.query_signals.specificity}`);
  console.log(`  Orientation: ${agent.context!.orientation.approach}\n`);

  // Step 2: Filtered slosh
  console.log('Step 2: Filtered slosh (temporal only)...');
  agent.sloshFilter = { include: ['temporal'] };
  await agent.execute({ query: 'filtered' });
  console.log(`  Memory echoes: ${agent.context!.memory_echoes.length} (should be 0)`);
  console.log(`  Temporal present: ${!!agent.context!.temporal.time_of_day}\n`);

  // Step 3: Privacy controls
  console.log('Step 3: Privacy (redact + obfuscate)...');
  agent.sloshFilter = null;
  agent.sloshPrivacy = { redact: ['temporal.fiscal'], obfuscate: ['temporal.day_of_week'] };
  await agent.execute({ query: 'private' });
  console.log(`  fiscal: ${agent.context!.temporal.fiscal} (should be undefined)`);
  console.log(`  day_of_week: ${agent.context!.temporal.day_of_week}\n`);

  // Step 4: Debug events + feedback
  console.log('Step 4: Debug events + feedback...');
  agent.sloshPrivacy = null;
  agent.sloshDebug = true;
  const stages: string[] = [];
  agent.onSloshDebug = (event: SloshDebugEvent) => stages.push(event.stage);
  await agent.execute({ query: 'debug' });
  console.log(`  Debug stages captured: ${stages.join(', ')}`);
  console.log(`  getSignal('temporal.time_of_day'): ${agent.getSignal('temporal.time_of_day')}`);
  console.log(`  Breadcrumbs: ${agent.breadcrumbs.length}`);
}

main().catch(console.error);
