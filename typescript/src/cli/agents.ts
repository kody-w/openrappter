import type { Command } from 'commander';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentRegistry } from '../agents/AgentRegistry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, '..', 'agents');

export function registerAgentsCommand(program: Command): void {
  const agents = program.command('agents').description('Manage agents');

  agents
    .command('list')
    .description('List all registered agents')
    .action(async () => {
      const registry = new AgentRegistry(AGENTS_DIR);
      const allAgents = await registry.listAgents();
      console.log(`\nRegistered Agents (${allAgents.length}):\n`);
      for (const agent of allAgents) {
        console.log(`  ${agent.name}`);
        if (agent.description) {
          console.log(`    ${agent.description}`);
        }
        console.log('');
      }
    });

  agents
    .command('info <name>')
    .description('Show agent details')
    .action(async (name: string) => {
      const registry = new AgentRegistry(AGENTS_DIR);
      const agent = await registry.getAgent(name);
      if (!agent) {
        console.error(`Agent not found: ${name}`);
        process.exit(1);
      }
      console.log('\nAgent Information:\n');
      console.log(`  Name: ${agent.name}`);
      console.log(`  Description: ${agent.metadata?.description || 'None'}`);
      if (agent.metadata?.parameters) {
        console.log('\nParameters:');
        console.log(JSON.stringify(agent.metadata.parameters, null, 2));
      }
    });
}
