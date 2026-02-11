/**
 * AgentRegistry - Dynamic agent discovery and management.
 *
 * Discovers agents from the agents directory by scanning for *Agent.ts files.
 * Mirrors the Python AgentRegistry in cli.py.
 */

import fs from 'fs/promises';
import path from 'path';
import { BasicAgent } from './BasicAgent.js';
import type { AgentInfo } from './types.js';

export class AgentRegistry {
  private agentsDir: string;
  private agents: Map<string, BasicAgent> = new Map();
  private loaded = false;

  constructor(agentsDir: string) {
    this.agentsDir = agentsDir;
  }

  async discoverAgents(): Promise<void> {
    if (this.loaded) return;

    try {
      const files = await fs.readdir(this.agentsDir);
      const agentFiles = files.filter(
        f => (f.endsWith('Agent.js') || f.endsWith('Agent.ts')) && !f.startsWith('Basic') && !f.startsWith('_')
      );

      for (const file of agentFiles) {
        try {
          const modulePath = path.join(this.agentsDir, file);
          const mod = await import(modulePath);
          for (const exportName of Object.keys(mod)) {
            const ExportedClass = mod[exportName];
            if (
              typeof ExportedClass === 'function' &&
              ExportedClass.prototype instanceof BasicAgent
            ) {
              const instance = new ExportedClass() as BasicAgent;
              this.agents.set(instance.name, instance);
            }
          }
        } catch (e) {
          // Skip agents that fail to load
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    this.loaded = true;
  }

  async getAgent(name: string): Promise<BasicAgent | undefined> {
    await this.discoverAgents();
    return this.agents.get(name);
  }

  async getAllAgents(): Promise<Map<string, BasicAgent>> {
    await this.discoverAgents();
    return this.agents;
  }

  async listAgents(): Promise<AgentInfo[]> {
    await this.discoverAgents();
    return Array.from(this.agents.entries()).map(([name, agent]) => ({
      name,
      description: agent.metadata?.description ?? 'No description',
      parameters: agent.metadata?.parameters ?? { type: 'object' as const, properties: {}, required: [] },
      module: name,
      file: '',
    }));
  }
}