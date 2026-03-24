import type { Command } from 'commander';
import { loadEnv, saveEnv } from '../env.js';
import { COPILOT_DEFAULT_MODELS, COPILOT_DEFAULT_MODEL } from '../providers/copilot.js';

const EMOJI = '🦖';

/**
 * Try to discover models from the live Copilot API.
 * Falls back to the hardcoded list if the API isn't reachable.
 */
async function discoverModels(): Promise<string[]> {
  const models: string[] = [...COPILOT_DEFAULT_MODELS];

  try {
    const { resolveGithubToken } = await import('../copilot-check.js');
    const token = await resolveGithubToken();
    if (!token) return models;

    const { resolveCopilotApiToken } = await import('../providers/copilot-token.js');
    const resolved = await resolveCopilotApiToken({ githubToken: token });
    const res = await fetch(`${resolved.baseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${resolved.token}` },
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      if (data.data && Array.isArray(data.data)) {
        for (const m of data.data) {
          if (m.id && !models.includes(m.id)) {
            models.push(m.id);
          }
        }
      }
    }
  } catch { /* use hardcoded list */ }

  return models;
}

export function registerModelsCommand(program: Command): void {
  const cmd = program
    .command('models')
    .description('List, get, or set the active LLM model');

  // Default action: list models
  cmd
    .action(async () => {
      const env = await loadEnv();
      const current = env.OPENRAPPTER_MODEL || process.env.OPENRAPPTER_MODEL || COPILOT_DEFAULT_MODEL;

      console.log(`\n${EMOJI} Discovering available models…\n`);
      const models = await discoverModels();

      console.log('  Copilot Models:\n');
      for (const model of models) {
        const marker = model === current ? '  ● ' : '    ';
        const label = model === COPILOT_DEFAULT_MODEL ? ` ${chalk_dim('(default)')}` : '';
        console.log(`${marker}${model}${label}`);
      }

      console.log(`\n  Active: ${current}`);
      console.log(`\n  Set model:  openrappter models set <model-id>`);
      console.log(`  Get model:  openrappter models get\n`);
    });

  // Subcommand: get
  cmd
    .command('get')
    .description('Show the current active model')
    .action(async () => {
      const env = await loadEnv();
      const current = env.OPENRAPPTER_MODEL || process.env.OPENRAPPTER_MODEL || COPILOT_DEFAULT_MODEL;
      console.log(current);
    });

  // Subcommand: set
  cmd
    .command('set <model>')
    .description('Set the default model (persisted to ~/.openrappter/.env)')
    .action(async (model: string) => {
      const env = await loadEnv();
      const previous = env.OPENRAPPTER_MODEL || process.env.OPENRAPPTER_MODEL || COPILOT_DEFAULT_MODEL;

      env.OPENRAPPTER_MODEL = model;
      await saveEnv(env);

      console.log(`${EMOJI} Model set: ${previous} → ${model}`);
      console.log('  Restart the gateway for the change to take effect,');
      console.log('  or use the dashboard to hot-swap without restarting.');
    });
}

/** Minimal dim text helper (avoid importing chalk just for this) */
function chalk_dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
