import type { Command } from 'commander';
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
    });
}
