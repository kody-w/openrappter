import { openrappterPath } from '../infra/openrappter-home.js';
/**
 * AgentRegistry - Dynamic agent discovery and management.
 *
 * Discovers agents from the agents directory by scanning for *Agent.ts files.
 * Mirrors the Python AgentRegistry in cli.py.
 */

import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import { BasicAgent } from './BasicAgent.js';
import { PythonAgent, introspectPythonAgents } from './PythonAgent.js';
import { canonicalAgentSourcePath } from './source-lock.js';
import type { AgentInfo } from './types.js';
import { logger } from '../logging/logger.js';
import { RESERVED_AGENT_DIRS, isReservedAgentPath } from './reserved-paths.js';

/**
 * The reserved-directory rules live in `./reserved-paths.js` so callers that
 * must stay free of this module's dependencies can share one definition. They
 * are re-exported here because this is where they have always been imported
 * from.
 */
export { RESERVED_AGENT_DIRS, isReservedAgentPath } from './reserved-paths.js';

/**
 * Every agent file under `dir`, relative to it, excluding reserved directories.
 *
 * KERNEL §2.3 allows subdirectories for swarms and stacks, so discovery has to
 * walk the tree — and walking is what makes the reserved-dir exclusion mean
 * something. A flat readdir never returns a path inside `disabled_agents/`, so
 * the guard would have been unreachable and the rule unenforced.
 */
async function walkAgentFiles(dir: string, prefix = ''): Promise<string[]> {
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if ((RESERVED_AGENT_DIRS as readonly string[]).includes(entry.name)) continue;
      // node_modules under a user agents dir is never an agent tree.
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...await walkAgentFiles(path.join(dir, entry.name), rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

const registryLog = logger.child('agents');

export { canonicalAgentSourcePath } from './source-lock.js';

/**
 * Attribute a generated JavaScript agent to the file that produced it.
 *
 * Ownership is intentionally immutable and invisible to normal object
 * enumeration: import transactions use it to distinguish a same-file update
 * from a foreign capability with the same public name.
 */
export function markAgentSourceFile(
  agent: BasicAgent,
  file: string,
): void {
  Object.defineProperty(agent, 'sourceFile', {
    value: canonicalAgentSourcePath(file),
    enumerable: false,
    writable: false,
    configurable: false,
  });
}

export class AgentRegistry {
  private agentsDir: string;
  private userAgentsDir: string;
  private agents: Map<string, BasicAgent> = new Map();
  private loaded = false;
  /**
   * Why a file on disk did not become an agent, keyed by path.
   *
   * A failed load used to be discarded, so a capability could disappear with
   * no signal anywhere: the sweep is deliberately resilient, but resilient is
   * not the same as silent. Keyed by path so a re-scan of a fixed file clears
   * its own entry.
   */
  private loadFailures: Map<string, string> = new Map();

  constructor(
    agentsDir: string,
    userAgentsDir = openrappterPath('agents'),
  ) {
    this.agentsDir = agentsDir;
    this.userAgentsDir = userAgentsDir;
  }

  /**
   * Re-scan the user agents directory and pick up anything new.
   *
   * `discoverAgents()` latches on `loaded` so the built-in sweep runs once —
   * which is right for agents compiled into the build, and wrong for the ones a
   * person drops in while the daemon is running. Without this, a dropped agent
   * was only visible after a restart, which is not what "hot" means.
   *
   * Returns the names that appeared, so the caller can say what was learned
   * rather than claiming success and hoping.
   */
  async reloadUserAgents(): Promise<string[]> {
    const before = new Set(this.agents.keys());
    await this.discoverUserAgents();
    return Array.from(this.agents.keys()).filter(n => !before.has(n));
  }

  /** Drop an agent from the live map, so a replaced file does not leave a ghost. */
  forget(name: string): boolean {
    return this.agents.delete(name);
  }

  async discoverAgents(): Promise<void> {
    if (this.loaded) return;

    let builtinFound = false;
    try {
      const files = await fs.readdir(this.agentsDir);
      builtinFound = true;
      const agentFiles = files.filter(
        f => (f.endsWith('Agent.js') || f.endsWith('Agent.ts')) && !f.startsWith('Basic') && !f.startsWith('_')
      );

      for (const file of agentFiles) {
        try {
          const modulePath = path.join(this.agentsDir, file);
          const mod = await import(pathToFileURL(modulePath).href);
          for (const exportName of Object.keys(mod)) {
            const ExportedClass = mod[exportName];
            if (
              typeof ExportedClass === 'function' &&
              ExportedClass.prototype instanceof BasicAgent &&
              // A template is constructed per descriptor elsewhere and cannot be
              // instantiated bare; calling `new` on it here throws and records a
              // permanent, false load failure. Constructor arity cannot be used
              // to detect this — an optional parameter still counts toward
              // `Function.length`, so ShellAgent reports arity 1 while loading
              // perfectly well.
              !(ExportedClass as { isTemplate?: boolean }).isTemplate
            ) {
              const instance = new ExportedClass() as BasicAgent;
              this.agents.set(instance.name, instance);
            }
          }
          this.loadFailures.delete(modulePath);
        } catch (error) {
          this.noteLoadFailure(path.join(this.agentsDir, file), error);
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    // Also discover factory-based agents from ~/.openrappter/agents/
    // Only if the built-in agents dir was valid (skip in test contexts)
    if (builtinFound) {
      await this.discoverUserAgents();
    }

    this.loaded = true;
  }

  /** Load user-generated agents (LearnNew factory pattern) from ~/.openrappter/agents/ */
  private async discoverUserAgents(): Promise<void> {
    await this.discoverPythonAgents();
    try {
      const files = await walkAgentFiles(this.userAgentsDir);
      const agentFiles = files.filter(f => f.endsWith('_agent.js') && !isReservedAgentPath(f));

      for (const file of agentFiles) {
        try {
          const filePath = path.join(this.userAgentsDir, file);
          const fileUrl = pathToFileURL(filePath).href + `?t=${Date.now()}`;
          const mod = await import(fileUrl);
          if (typeof mod.createAgent === 'function') {
            const AgentClass = mod.createAgent(BasicAgent);
            if (AgentClass) {
              const instance = new AgentClass() as BasicAgent;
              markAgentSourceFile(instance, filePath);
              if (!this.agents.has(instance.name)) {
                this.agents.set(instance.name, instance);
              }
            }
          }
          this.loadFailures.delete(filePath);
        } catch (error) {
          this.noteLoadFailure(path.join(this.userAgentsDir, file), error);
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
  }

  /**
   * Load `.py` agents from the user directory through the Python bridge.
   *
   * The grail brainstem and the RAR catalog are Python, so most agents a person
   * already has are `.py`. Refusing them would have meant "hot-load works, but
   * not for the agents you own".
   */
  private async discoverPythonAgents(): Promise<void> {
    const files = await walkAgentFiles(this.userAgentsDir);

    for (const file of files.filter(f =>
      f.endsWith('.py') && f !== 'basic_agent.py' && !isReservedAgentPath(f)
    )) {
      const filePath = path.join(this.userAgentsDir, file);
      try {
        const found = await introspectPythonAgents(filePath);
        if (!found.ok) {
          // A broken file is not a reason to fail the sweep, but it is a
          // reason to be able to say which file and why.
          this.noteLoadFailure(filePath, found.error);
          continue;
        }
        for (const descriptor of found.agents) {
          // A re-dropped file must replace its own agent rather than being
          // ignored as a duplicate, or editing an agent would never take.
          const existing = this.agents.get(descriptor.name);
          const isOurs = existing instanceof PythonAgent && existing.sourceFile === filePath;
          if (existing && !isOurs) continue;
          this.agents.set(descriptor.name, new PythonAgent(filePath, descriptor));
        }
        this.loadFailures.delete(filePath);
      } catch (error) {
        this.noteLoadFailure(filePath, error);
      }
    }
  }

  private noteLoadFailure(file: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error);
    this.loadFailures.set(file, reason);
    // Recording it is not the same as anyone seeing it. The Python registry
    // has always warned here; this is the half that reaches an operator.
    registryLog.warn('Agent file failed to load', { file, reason });
  }

  /**
   * Files that failed to become agents, and why.
   *
   * The sweep keeps going when a file is broken — one bad agent must not cost
   * you the rest. This is how the failure stays visible instead of the
   * capability just being absent.
   */
  getLoadFailures(): Array<{ file: string; reason: string }> {
    return Array.from(this.loadFailures, ([file, reason]) => ({ file, reason }));
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