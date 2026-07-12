import type { Command } from 'commander';
import { checkForUpdate } from '../infra/update-check.js';
import { VERSION } from '../version.js';

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Check for updates')
    .option('--skip-check', 'Skip automatic update check')
    .action(async (options: { skipCheck?: boolean }) => {
      if (options.skipCheck) {
        console.log('Update check skipped.');
        return;
      }

      console.log('Checking for updates...\n');
      const result = await checkForUpdate(VERSION);

      console.log(`Current version: ${result.currentVersion}`);
      console.log(`Latest version:  ${result.latestVersion}`);

      if (result.hasUpdate) {
        console.log('\n\x1b[33mA new version is available!\x1b[0m');
        console.log('\nTo update, run:');
        console.log('  npm install -g openrappter@latest');
      } else {
        console.log('\n\x1b[32mYou are using the latest version.\x1b[0m');
      }
    });
}
