/**
 * CLI subcommand: openrappter channel
 *
 * Manage release channels — switch between stable (main) and experimental
 * branches like Chrome Stable vs Canary. Experimental acts as a digital
 * twin that can promote changes back to production.
 *
 * Commands:
 *   openrappter channel status                          Show current channel
 *   openrappter channel switch stable                   Switch to production
 *   openrappter channel switch experimental <branch>    Switch to feature branch
 *   openrappter channel promote [--count N]             Cherry-pick to stable
 *   openrappter channel promote --enable                Enable promote (safety gate)
 *   openrappter channel promote --disable               Disable promote
 */

import type { Command } from 'commander';
import {
  channelStatus,
  switchChannel,
  enablePromote,
  promoteToStable,
} from '../infra/channel.js';

export function registerChannelCommand(program: Command): void {
  const ch = program
    .command('channel')
    .description('Manage release channels (stable / experimental)');

  // ── status ──────────────────────────────────────────────────────────────
  ch.command('status')
    .description('Show current channel, branch, and drift')
    .action(() => {
      try {
        const s = channelStatus();
        console.log('');
        console.log(`  🦖 Release Channel`);
        console.log(`  ──────────────────────────`);
        console.log(`  Current:       ${s.current === 'stable' ? '🟢 stable' : '🟡 experimental'}`);
        console.log(`  Branch:        ${s.branch}`);
        console.log(`  Stable:        ${s.stableBranch}`);
        console.log(`  Experimental:  ${s.experimentalBranch}`);
        if (s.current === 'experimental') {
          console.log(`  Ahead/Behind:  +${s.commitsAheadStable} / -${s.commitsBehindStable}`);
        }
        console.log(`  Dirty:         ${s.dirty ? '⚠️  uncommitted changes' : '✅ clean'}`);
        console.log(`  Promote:       ${s.promoteEnabled ? '🔓 enabled' : '🔒 disabled'}`);
        console.log('');
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ── switch ──────────────────────────────────────────────────────────────
  ch.command('switch <target> [branch]')
    .description('Switch channel: stable | experimental <branch>')
    .action((target: string, branch?: string) => {
      if (target !== 'stable' && target !== 'experimental') {
        console.error('Target must be "stable" or "experimental"');
        process.exit(1);
      }
      try {
        const msg = switchChannel(target as 'stable' | 'experimental', branch);
        console.log(`\n  ✅ ${msg}\n`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  // ── promote ─────────────────────────────────────────────────────────────
  ch.command('promote')
    .description('Promote experimental commits to stable (digital twin → production)')
    .option('--enable', 'Enable promote (safety gate)')
    .option('--disable', 'Disable promote')
    .option('--count <n>', 'Number of commits to promote', '1')
    .action((options: { enable?: boolean; disable?: boolean; count?: string }) => {
      try {
        if (options.enable) {
          console.log(`\n  ${enablePromote(true)}\n`);
          return;
        }
        if (options.disable) {
          console.log(`\n  ${enablePromote(false)}\n`);
          return;
        }
        const n = parseInt(options.count ?? '1', 10);
        const msg = promoteToStable(n);
        console.log(`\n  ✅ ${msg}\n`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });
}
