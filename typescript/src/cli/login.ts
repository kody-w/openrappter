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
        // Deliberately prints nothing derived from the tokens. A prefix is
        // still credential material: it goes to terminal scrollback and to CI
        // logs, and it narrows a brute force. The user does not need to see a
        // token to know the flow worked.
        console.log(`Signed in to ${provider}.`);
        if (result.refreshToken) {
          console.log('A refresh token was issued.');
        }
        // Nothing persists this token. `initiateOAuthFlow` returns it and
        // returns nothing else -- `auth/oauth.ts` performs no filesystem
        // writes at all, and `OAuthTokenStore` is two in-memory Maps that the
        // flow never calls. Claiming a save here is the same defect as the
        // macOS Bar reporting success from a discarded write (#316): the user
        // is told to stop worrying about something that did not happen.
        console.log('\nThis token was NOT saved -- it is discarded when this command exits.');
        console.log('Persistent credential storage is not implemented yet.');
      } catch (err) {
        console.error('\n\x1b[31mAuthentication failed:\x1b[0m', err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
