/**
 * AgentRegistry - Dynamic agent discovery and loading.
 *
 * Discovers and loads all agents from the src/agents/ directory.
 * Mirrors the Python AgentRegistry in openrappter.py
 */

import { readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import path from 'path';
import type { AgentMetadata, AgentInfo } from './types.js';
import { BasicAgent } from './BasicAgent.js';

interface AgentEntry {
  class: new () => BasicAgent;
  instance: BasicAgent;
  metadata: AgentMetadata;
  module: string;
  file: string;
}

export class AgentRegistry {
  private agentsDir: string;
  private agents: Map<string, AgentEntry> = new Map();
  private loaded = false;

  constructor(agentsDir?: string) {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    this.agentsDir = agentsDir ?? __dirname;
  }

  /**
   * Discover and load all agents from the agents directory.
   */
  async discoverAgents(): Promise<Map<string, AgentEntry>> {
    if (this.loaded) return this.agents;

    try {
      const files = await readdir(this.agentsDir);
      
      for (const file of files) {
        // Match *Agent.ts or *Agent.js files, excluding BasicAgent and types
        if (!/Agent\.(ts|js)$/.test(file) || file === 'BasicAgent.ts' || file === 'BasicAgent.js' || file === 'types.ts' || file === 'types.js') {
          continue;
        }

        try {
          const modulePath = path.join(this.agentsDir, file);
          const module = await import(modulePath);
          
          // Find exported classes that extend BasicAgent
          for (const exportName of Object.keys(module)) {
            const exported = module[exportName];
            
            if (typeof exported === 'function' && exported.prototype instanceof BasicAgent) {
              try {
                const instance = new exported() as BasicAgent;
                const agentName = instance.name || exportName.replace(/Agent$/, '');
                
                this.agents.set(agentName, {
                  class: exported,
                  instance,
                  metadata: instance.metadata,
                  module: file.replace(/\.(ts|js)$/, ''),
                  file: modulePath,
                });
              } catch (e) {
                console.warn(`Failed to instantiate ${exportName}:`, e);
              }
            }
          }
        } catch (e) {
          console.warn(`Failed to load ${file}:`, e);
        }
      }

      this.loaded = true;
      console.log(`Loaded ${this.agents.size} agent(s):`, Array.from(this.agents.keys()));
    } catch (e) {
      console.warn('Failed to discover agents:', e);
    }

    return this.agents;
  }

  /**
   * Get an agent instance by name.
   */
  async getAgent(name: string): Promise<BasicAgent | undefined> {
    await this.discoverAgents();
    return this.agents.get(name)?.instance;
  }

  /**
   * Get all agent instances.
   */
  async getAllAgents(): Promise<Map<string, BasicAgent>> {
    await this.discoverAgents();
    const result = new Map<string, BasicAgent>();
    for (const [name, entry] of this.agents) {
      result.set(name, entry.instance);
    }
    return result;
  }

  /**
   * Convert agent metadata to OpenAI tools format for function calling.
   */
  async getAgentMetadataTools(): Promise<Array<{ type: 'function'; function: AgentMetadata }>> {
    await this.discoverAgents();
    const tools: Array<{ type: 'function'; function: AgentMetadata }> = [];
    
    for (const [, entry] of this.agents) {
      if (entry.metadata) {
        tools.push({
          type: 'function',
          function: entry.metadata,
        });
      }
    }
    
    return tools;
  }

  /**
   * List all available agents with their metadata.
   */
  async listAgents(): Promise<AgentInfo[]> {
    await this.discoverAgents();
    
    return Array.from(this.agents.entries()).map(([name, entry]) => ({
      name,
      description: entry.metadata?.description ?? 'No description',
      parameters: entry.metadata?.parameters ?? { type: 'object', properties: {}, required: [] },
      module: entry.module,
      file: entry.file,
    }));
  }
}
