import type { Command } from 'commander';
import { initiateOAuthFlow } from '../auth/oauth.js';

const SUPPORTED_PROVIDERS = [
  'slack',
  'discord',
  'google',
  'microsoft',
  'github',
  'notion',
  'linear',
];

export function registerLoginCommand(program: Command): void {
  program
    .command('login <provider>')
    .description('Authenticate with a provider via OAuth')
    .option('-p, --port <port>', 'Local server port for callback', '18791')
    .action(async (provider: string, options: { port?: string }) => {
      if (!SUPPORTED_PROVIDERS.includes(provider.toLowerCase())) {
        console.error(
          `Unsupported provider: ${provider}\nSupported: ${SUPPORTED_PROVIDERS.join(', ')}`
        );
        process.exit(1);
      }

      const port = parseInt(options.port || '18791', 10);
      console.log(`\nInitiating OAuth flow for ${provider}...`);

      try {
        const result = await initiateOAuthFlow(provider, { port });
        console.log('\n\x1b[32mAuthentication successful!\x1b[0m');
        console.log(`\nAccess token: ${result.accessToken.substring(0, 20)}...`);
        if (result.refreshToken) {
          console.log(`Refresh token: ${result.refreshToken.substring(0, 20)}...`);
        }
        console.log('\nCredentials have been saved to your config.');
      } catch (err) {
        console.error('\n\x1b[31mAuthentication failed:\x1b[0m', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
