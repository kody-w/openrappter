import type { Command } from 'commander';
import { AgentRegistry } from '../agents/registry.js';

export function registerAgentsCommand(program: Command): void {
  const agents = program.command('agents').description('Manage agents');

  agents
    .command('list')
    .description('List all registered agents')
    .action(async () => {
      const registry = AgentRegistry.getInstance();
      const allAgents = registry.listAgents();
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
      const registry = AgentRegistry.getInstance();
      const agent = registry.getAgent(name);
      if (!agent) {
        console.error(`Agent not found: ${name}`);
        process.exit(1);
      }
      console.log('\nAgent Information:\n');
      console.log(`  Name: ${agent.name}`);
      console.log(`  Description: ${agent.description || 'None'}`);
      if (agent.parameters) {
        console.log('\nParameters:');
        console.log(JSON.stringify(agent.parameters, null, 2));
      }
    });
}
