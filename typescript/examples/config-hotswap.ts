/**
 * Config Hotswap — Parse, validate, merge, env substitution
 *
 * Run: npx tsx examples/config-hotswap.ts
 */

import { substituteEnvVars, mergeConfigs, parseConfigContent } from '../src/config/loader.js';
import { validateConfig, getConfigJsonSchema } from '../src/config/schema.js';

async function main() {
  console.log('=== Config Hotswap ===\n');

  // Step 1: Parse + validate
  console.log('Step 1: Parse JSON5 and validate...');
  const content = `{
    // Gateway config
    "configVersion": 1,
    "gateway": { "port": 8080, "bind": "loopback", },
  }`;
  const parsed = parseConfigContent(content);
  const validation = validateConfig(parsed);
  console.log(`  Valid: ${validation.success}`);
  console.log(`  Port: ${(validation.data as Record<string, unknown>)?.gateway}\n`);

  // Step 2: Merge configs
  console.log('Step 2: Merge configs...');
  const merged = mergeConfigs(
    { gateway: { port: 8080, bind: 'loopback' } },
    { gateway: { port: 9090, bind: 'all' }, cron: { enabled: true } },
  );
  console.log(`  Merged port: ${merged.gateway?.port}`);
  console.log(`  Merged cron: ${merged.cron?.enabled}\n`);

  // Step 3: Env substitution + JSON Schema
  console.log('Step 3: Env substitution + schema...');
  process.env.DEMO_PORT = '4000';
  const substituted = substituteEnvVars('port=${DEMO_PORT}');
  console.log(`  Substituted: ${substituted}`);
  const schema = getConfigJsonSchema();
  console.log(`  Schema sections: ${Object.keys(schema.properties as object).join(', ')}`);
  delete process.env.DEMO_PORT;
}

main().catch(console.error);
