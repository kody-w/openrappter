/**
 * AgentRegistry - Dynamic agent discovery and management.
 *
 * Discovers agents from the agents directory by scanning for *Agent.ts files.
 * Mirrors the Python AgentRegistry in cli.py.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { pathToFileURL } from 'url';
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
        } catch {
          // Skip agents that fail to load
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    // Also discover factory-based agents from ~/.openrappter/agents/
    await this.discoverUserAgents();

    this.loaded = true;
  }

  /** Load user-generated agents (LearnNew factory pattern) from ~/.openrappter/agents/ */
  private async discoverUserAgents(): Promise<void> {
    const userAgentsDir = path.join(os.homedir(), '.openrappter', 'agents');
    try {
      const files = await fs.readdir(userAgentsDir);
      const agentFiles = files.filter(f => f.endsWith('_agent.js'));

      for (const file of agentFiles) {
        try {
          const filePath = path.join(userAgentsDir, file);
          const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;
          const mod = await import(fileUrl);
          if (typeof mod.createAgent === 'function') {
            const AgentClass = mod.createAgent(BasicAgent);
            if (AgentClass) {
              const instance = new AgentClass() as BasicAgent;
              if (!this.agents.has(instance.name)) {
                this.agents.set(instance.name, instance);
              }
            }
          }
        } catch {
          // Skip agents that fail to load
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
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