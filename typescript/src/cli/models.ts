import type { Command } from 'commander';
import { loadEnv, saveEnv } from '../env.js';
import { COPILOT_DEFAULT_MODELS, COPILOT_DEFAULT_MODEL } from '../providers/copilot.js';
import { CopilotAuthority } from '../providers/copilot-authority.js';

const EMOJI = '🦖';

/**
 * Try to discover models from the live Copilot API.
 * Falls back to the hardcoded list if the API isn't reachable.
 */
async function discoverModels(): Promise<string[]> {
  const models: string[] = [...COPILOT_DEFAULT_MODELS];

  try {
    const { discoverCopilotAccounts } = await import('../copilot-check.js');
    const authority = new CopilotAuthority({
      accountResolver: discoverCopilotAccounts,
      allowAmbientCredentials: false,
    });
    for (const model of await authority.availableModels()) {
      if (!models.includes(model)) {
        models.push(model);
      }
    }
  } catch { /* use hardcoded list */ }

  return models;
}

/**
 * The model the runtime will actually use.
 *
 * `hydrateManagedEnv` copies `~/.openrappter/.env` into `process.env` only for
 * keys that are not already set — "existing values always win". Every model
 * read in the runtime is then `process.env.OPENRAPPTER_MODEL`. This command
 * used to resolve the file first, so with `OPENRAPPTER_MODEL` exported in the
 * shell, `models get` named one model while the agent ran another. #159 fixed
 * the same inversion for `config`.
 */
async function resolveActiveModel(): Promise<ModelResolution> {
  const env = await loadEnv();
  const fileModel = env.OPENRAPPTER_MODEL;
  const processModel = process.env.OPENRAPPTER_MODEL;

  return {
    model: processModel || fileModel || COPILOT_DEFAULT_MODEL,
    fileModel,
    // index.ts calls hydrateManagedEnv() before parsing, so the file's own
    // value is in process.env by the time any action runs. Only a value that
    // disagrees with the file can have come from the user's shell — treating
    // every process value as exported would warn on every `models set`.
    shadowedByEnvironment: Boolean(processModel) && processModel !== fileModel,
  };
}

interface ModelResolution {
  /** What the runtime will use. */
  model: string;
  /** What `~/.openrappter/.env` holds, if anything. */
  fileModel?: string;
  /** An exported OPENRAPPTER_MODEL is overriding the file. */
  shadowedByEnvironment: boolean;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function registerModelsCommand(program: Command): void {
  const cmd = program
    .command('models')
    .description('List, get, or set the active LLM model');

  // Default action: list models
  cmd
    .action(async () => {
      const { model: current } = await resolveActiveModel();

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
      const { model } = await resolveActiveModel();
      console.log(model);
    });

  // Subcommand: set
  cmd
    .command('set <model>')
    .description('Set the default model (persisted to ~/.openrappter/.env)')
    .action(async (model: string) => {
      const requested = model.trim();
      if (!requested) {
        fail('Error: model id must not be empty');
      }

      const { model: previous, shadowedByEnvironment } = await resolveActiveModel();

      const env = await loadEnv();
      env.OPENRAPPTER_MODEL = requested;
      try {
        await saveEnv(env);
      } catch (err) {
        // saveEnv verifies its own read-back. A failure there means the file on
        // disk is not what we just claimed to write.
        fail(`Failed to save model: ${err instanceof Error ? err.message : String(err)}`);
      }

      console.log(`${EMOJI} Model set: ${previous} → ${requested}`);
      if (shadowedByEnvironment && previous !== requested) {
        // The file is now correct and still ignored: the exported variable
        // wins in every process that inherits it. Saying "restart the gateway"
        // here would send the user to fix the wrong thing.
        console.log(
          `  Warning: OPENRAPPTER_MODEL is exported in this environment as "${previous}"`,
        );
        console.log('  and overrides the saved value. Unset it for the change to apply.');
        return;
      }
      console.log('  Restart the gateway for the change to take effect,');
      console.log('  or use the dashboard to hot-swap without restarting.');
    });
}

/** Minimal dim text helper (avoid importing chalk just for this) */
function chalk_dim(s: string): string {
  return `\x1b[2m${s}\x1b[0m`;
}
