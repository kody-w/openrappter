import type { Command } from 'commander';

interface ModelInfo {
  provider: string;
  models: string[];
  configured: boolean;
}

async function listModels(): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [
    {
      provider: 'anthropic',
      models: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku', 'claude-2.1', 'claude-2.0'],
      configured: !!process.env.ANTHROPIC_API_KEY,
    },
    {
      provider: 'openai',
      models: ['gpt-4', 'gpt-4-turbo', 'gpt-3.5-turbo', 'gpt-4o', 'gpt-4o-mini'],
      configured: !!process.env.OPENAI_API_KEY,
    },
    {
      provider: 'ollama',
      models: ['llama2', 'mistral', 'mixtral', 'codellama', 'phi'],
      configured: true,
    },
  ];
  return models;
}

export function registerModelsCommand(program: Command): void {
  program
    .command('models')
    .description('List available models')
    .option('-p, --provider <provider>', 'Filter by provider')
    .action(async (options: { provider?: string }) => {
      const models = await listModels();
      const filtered = options.provider
        ? models.filter((m) => m.provider === options.provider)
        : models;

      console.log('\nAvailable Models:\n');
      for (const info of filtered) {
        const status = info.configured ? '✓' : '✗';
        console.log(`${status} ${info.provider.toUpperCase()}`);
        for (const model of info.models) {
          console.log(`    ${model}`);
        }
        if (!info.configured && info.provider !== 'ollama') {
          console.log(`    (not configured - set ${info.provider.toUpperCase()}_API_KEY)`);
        }
        console.log('');
      }
    });
}
