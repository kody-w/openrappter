import type { Command } from 'commander';
import { checkForUpdate } from '../infra/update-check.js';
import { VERSION } from '../version.js';
import { resolveRing, selectRing } from '../release-rings.js';

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Check whether a newer openrappter is published')
    .option('--json', 'Emit the result as JSON')
    .option('--ring <ring>', 'Resolve stable, beta, canary, alpha, or nightly')
    .option('--allow-downgrade', 'Allow resolving an older exact version')
    .action(async (options: { json?: boolean; ring?: string; allowDowngrade?: boolean }) => {
      if (options.ring || process.env.OPENRAPPTER_RING) {
        const ring = selectRing({ cliRing: options.ring });
        try {
          const manifest = await resolveRing(ring, {
            currentVersion: VERSION,
            allowDowngrade: options.allowDowngrade,
          });
          if (options.json) console.log(JSON.stringify(manifest, null, 2));
          else {
            console.log(`Ring:            ${ring}`);
            console.log(`Exact version:   ${manifest.version}`);
            console.log(`Source commit:   ${manifest.source.commit}`);
            console.log(`Install artifact: ${manifest.artifact.install_url}`);
          }
        } catch (error) {
          console.error(`Could not resolve ${ring}: ${(error as Error).message}`);
          process.exit(1);
        }
        return;
      }
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
        // Updating is a manual npm install, so nothing in the product can
        // snapshot first. This is the one moment the user is known to be
        // about to change the installation, so it is where the offer belongs.
        console.log('\nTo be able to go back if it goes wrong, first run:');
        console.log('  openrappter backup create --reason "before upgrade"');
      } else {
        console.log('\n\x1b[32mYou are using the latest version.\x1b[0m');
      }
    });
}
