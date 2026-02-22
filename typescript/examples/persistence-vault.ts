/**
 * Persistence Vault — In-memory SQLite storage showcase
 *
 * Run: npx tsx examples/persistence-vault.ts
 */

import { createStorageAdapter } from '../src/storage/index.js';

async function main() {
  console.log('=== Persistence Vault ===\n');

  const storage = createStorageAdapter({ type: 'memory', inMemory: true });
  await storage.initialize();

  // Step 1: Init
  console.log('Step 1: Initialize in-memory storage...');
  console.log('  Storage initialized\n');

  // Step 2: Sessions
  console.log('Step 2: Sessions...');
  await storage.saveSession({
    id: 'sess_1', channelId: 'slack', conversationId: 'C123', agentId: 'ShellAgent',
    metadata: {}, messages: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const session = await storage.getSession('sess_1');
  console.log(`  Saved and retrieved: ${session?.id}\n`);

  // Step 3: Cron + Config
  console.log('Step 3: Cron jobs + Config KV...');
  await storage.saveCronJob({
    id: 'job_1', name: 'health-check', schedule: '*/5 * * * *',
    agentId: 'SelfHealingCron', message: 'check', enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  console.log(`  Cron job: ${(await storage.getCronJob('job_1'))?.name}`);

  await storage.setConfig('theme', 'dark');
  await storage.setConfig('lang', 'en');
  const allConfig = await storage.getAllConfig();
  console.log(`  Config: ${JSON.stringify(allConfig)}\n`);

  // Step 4: Multiple config operations
  console.log('Step 4: Sequential config operations...');
  await storage.setConfig('tx1', 'a');
  await storage.setConfig('tx2', 'b');
  console.log(`  tx1=${await storage.getConfig('tx1')}, tx2=${await storage.getConfig('tx2')}`);

  await storage.close();
}

main().catch(console.error);
