import type { Command } from 'commander';
import { checkForUpdate } from '../infra/update-check.js';
import { VERSION } from '../version.js';

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Check whether a newer openrappter is published')
    .option('--json', 'Emit the result as JSON')
    .action(async (options: { json?: boolean }) => {
      const result = await checkForUpdate(VERSION);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        // Doctor's rule from #159: a failed check exits nonzero in JSON mode
        // too, so a script cannot read success out of a check that never ran.
        if (!result.checked) process.exit(1);
        return;
      }

      console.log(`Current version: ${result.currentVersion}`);

      // The only honest answer when the registry was unreachable. The previous
      // command printed "You are using the latest version." here.
      if (!result.checked) {
        console.error(`\nCould not check for updates: ${result.error ?? 'unknown error'}`);
        process.exit(1);
      }

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
