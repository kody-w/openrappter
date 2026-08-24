import type { Command } from 'commander';
import { RINGS, fetchRingManifest, resolveRing, selectRing } from '../release-rings.js';
import { VERSION } from '../version.js';

export function registerRingsCommand(program: Command): void {
  const rings = program.command('rings').description('Inspect closed OpenRappter release-ring pointers');
  rings.command('list').description('List ring semantics and availability').action(async () => {
    const rows = await Promise.all(RINGS.map(async (ring) => {
      try {
        const manifest = await fetchRingManifest(ring);
        return { ring, status: manifest.status, version: manifest.version, commit: manifest.source.commit };
      } catch (error) {
        return { ring, status: 'unreachable', version: '-', commit: '-', reason: (error as Error).message };
      }
    }));
    console.table(rows);
  });
  rings.command('status').description('Show the selected ring pointer')
    .option('--ring <ring>', 'stable, beta, canary, alpha, or nightly')
    .option('--allow-downgrade', 'Allow selecting a version older than this CLI')
    .option('--json', 'Print JSON')
    .action(async (options: { ring?: string; allowDowngrade?: boolean; json?: boolean }) => {
      const ring = selectRing({ cliRing: options.ring });
      const manifest = await resolveRing(ring, {
        currentVersion: VERSION,
        allowDowngrade: options.allowDowngrade,
      });
      if (options.json) console.log(JSON.stringify(manifest, null, 2));
      else console.log(`${ring}: ${manifest.version} @ ${manifest.source.commit}`);
    });
}
