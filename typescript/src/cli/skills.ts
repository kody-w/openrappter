/**
 * Skills command.
 *
 * This module previously ran on `ClawHubClient`, whose `listInstalled()`
 * returns a hardcoded empty array and whose `install()` fetches `skill.json`,
 * writes nothing, and returns `{status: 'success'}` with a message telling the
 * caller to use `SkillsRegistry` instead. `skills install` printed
 * "Successfully installed" and exited 0 over a no-op, and `skills list` said
 * "(none)" no matter how many skills were on disk.
 *
 * `SkillsRegistry` is the implementation that installs: it writes the manifest
 * and SKILL.md under the skills directory and records them in the lock file the
 * runtime reads. Everything here goes through it, and failure exits nonzero.
 */

import type { Command } from 'commander';
import { loadBundledSkills } from '../skills/bundled.js';
import { SkillsRegistry } from '../skills/registry.js';

async function openRegistry(): Promise<SkillsRegistry> {
  const registry = new SkillsRegistry();
  await registry.initialize();
  return registry;
}

/** Report a clean message instead of an unhandled rejection stack. */
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function registerSkillsCommand(program: Command): void {
  const skills = program.command('skills').description('Manage skills');

  skills
    .command('list')
    .description('List bundled and installed skills')
    .option('-b, --bundled', 'Show bundled skills only')
    .option('-u, --user', 'Show user-installed skills only')
    .action(async (options: { bundled?: boolean; user?: boolean }) => {
      if (options.bundled && options.user) {
        fail('Error: --bundled and --user are mutually exclusive');
      }

      if (!options.user) {
        const bundled = await loadBundledSkills();
        console.log(`\nBundled Skills (${bundled.length}):`);
        if (bundled.length === 0) console.log('  (none)');
        for (const skill of bundled) {
          console.log(`  ${skill.name} - ${skill.description || 'No description'}`);
        }
      }

      if (!options.bundled) {
        try {
          const registry = await openRegistry();
          const installed = registry.getInstalled();
          console.log(`\nInstalled Skills (${installed.length}):`);
          if (installed.length === 0) console.log('  (none)');
          for (const skill of installed) {
            const state = skill.enabled ? '' : ' [disabled]';
            console.log(
              `  ${skill.manifest.id} (${skill.manifest.version})${state}`
              + ` - ${skill.manifest.description || 'No description'}`,
            );
          }
        } catch (err) {
          fail(
            `Error reading installed skills: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    });

  skills
    .command('search <query>')
    .description('Search GitHub for openrappter skills')
    .action(async (query: string) => {
      const registry = await openRegistry();
      const results = await registry.search(query);
      // `search` swallows network errors and returns []. "Found 0" is the
      // honest rendering of that; claiming a match it never saw is not.
      console.log(`\nFound ${results.length} skill(s):\n`);
      for (const skill of results) {
        console.log(`  ${skill.id}${skill.author ? ` by ${skill.author}` : ''}`);
        console.log(`    ${skill.description || 'No description'}`);
        console.log('');
      }
    });

  skills
    .command('install <repo>')
    .description('Install a skill from a GitHub repo (owner/repo)')
    .option('--ref <ref>', 'Branch or tag to install from', 'main')
    .action(async (repo: string, options: { ref?: string }) => {
      if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
        fail(`Error: expected a skill reference of the form owner/repo, got: ${repo}`);
      }
      const registry = await openRegistry();
      const installed = await registry.install(repo, options.ref);
      if (!installed) {
        // registry.install already reported the reason on stderr.
        fail(`Failed to install skill: ${repo}`);
      }
    });

  skills
    .command('uninstall <repo>')
    .description('Uninstall a skill')
    .action(async (repo: string) => {
      const registry = await openRegistry();
      const removed = await registry.uninstall(repo);
      if (!removed) {
        fail(`Not installed: ${repo}`);
      }
    });
}
