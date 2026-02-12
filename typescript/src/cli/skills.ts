import type { Command } from 'commander';
import { loadBundledSkills } from '../skills/bundled.js';
import { ClawHubClient } from '../clawhub.js';

export function registerSkillsCommand(program: Command): void {
  const skills = program.command('skills').description('Manage skills');

  skills
    .command('list')
    .description('List installed skills')
    .option('-b, --bundled', 'Show bundled skills only')
    .option('-u, --user', 'Show user-installed skills only')
    .action(async (options: { bundled?: boolean; user?: boolean }) => {
      if (!options.user) {
        console.log('\nBundled Skills:');
        const bundled = await loadBundledSkills();
        for (const skill of bundled) {
          console.log(`  ${skill.name} - ${skill.description}`);
        }
      }

      if (!options.bundled) {
        console.log('\nUser-Installed Skills:');
        try {
          const hub = new ClawHubClient();
          const userSkills = await hub.listInstalled();
          if (userSkills.length === 0) {
            console.log('  (none)');
          } else {
            for (const skill of userSkills) {
              console.log(`  ${skill.name} - ${skill.description || 'No description'}`);
            }
          }
        } catch (err) {
          console.log(`  Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

  skills
    .command('search <query>')
    .description('Search for skills in ClawHub')
    .action(async (query: string) => {
      const hub = new ClawHubClient();
      const results = await hub.search(query);
      console.log(`\nFound ${results.length} skill(s):\n`);
      for (const skill of results) {
        console.log(`  ${skill.name}${skill.author ? ` by ${skill.author}` : ''}`);
        console.log(`    ${skill.description || 'No description'}`);
        console.log('');
      }
    });

  skills
    .command('install <name>')
    .description('Install a skill from ClawHub')
    .action(async (name: string) => {
      const hub = new ClawHubClient();
      console.log(`Installing skill: ${name}...`);
      await hub.install(name);
      console.log(`Successfully installed: ${name}`);
    });
}
