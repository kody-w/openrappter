/**
 * Install an agent file dropped onto openrappter, and make it usable now.
 *
 * Modelled directly on the grail brainstem's `/agents/import`, because Kody's
 * ask was parity: "just like the vbrainstem and grail brainstem installer repo
 * allows". The behaviours worth copying, in order of how badly their absence
 * hurts:
 *
 *  1. **Verify by loading, not by writing.** Writing a file always succeeds.
 *     The only way to know an agent works is to load it and see. Reporting
 *     "installed" for a file that cannot load is the worst outcome here — the
 *     person believes the organism learned something and it did not.
 *  2. **Roll back on failure.** A bad drop over a working agent must leave the
 *     working one in place, not a broken replacement.
 *  3. **Refuse name collisions.** Two files claiming one capability means the
 *     assistant silently calls whichever won the scan.
 *  4. **Protect the base class.** `basic_agent.py` is shared scaffolding.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { introspectPythonAgents } from './PythonAgent.js';
import type { AgentRegistry } from './AgentRegistry.js';

export interface ImportResult {
  status: 'ok' | 'error';
  /** What the organism can now do — the capability names, not the filename. */
  learned?: { name: string; description: string }[];
  file?: string;
  error?: string;
  /** True when an existing agent of the same name was replaced by this drop. */
  replaced?: boolean;
}

/** Base-class filenames that are scaffolding, not capabilities. */
const PROTECTED = new Set(['basic_agent.py', 'BasicAgent.ts', 'BasicAgent.js', '__init__.py']);

/**
 * Filename sanitiser.
 *
 * A dropped name is attacker-controlled in the general case, so it is reduced to
 * a leaf name and a conservative character set before it is ever joined to a
 * directory. `..` and separators cannot survive this.
 */
export function safeAgentFilename(raw: string): string {
  const leaf = path.basename(raw).replace(/[^A-Za-z0-9._-]/g, '_');
  return leaf.replace(/^\.+/, '') || 'agent.py';
}

/** Where user agents live. Matches the registry's default. */
export function userAgentsDir(): string {
  return path.join(os.homedir(), '.openrappter', 'agents');
}

async function readIfExists(p: string): Promise<Buffer | null> {
  try { return await fs.readFile(p); } catch { return null; }
}

/**
 * Write, verify, and register a dropped agent.
 *
 * `registry` is required: an install that does not reach the running registry is
 * not a hot-load, and this function is the only thing that can honestly report
 * that the capability is live.
 */
export async function importAgentFile(
  originalName: string,
  contents: Buffer,
  registry: Pick<AgentRegistry, 'reloadUserAgents' | 'forget' | 'getAllAgents'>,
  opts: { dir?: string } = {},
): Promise<ImportResult> {
  const dir = opts.dir ?? userAgentsDir();
  const name = safeAgentFilename(originalName);

  if (!name.endsWith('.py') && !name.endsWith('.js')) {
    return { status: 'error', error: `${name} is not an agent — only .py and .js files can be installed.` };
  }
  if (PROTECTED.has(name)) {
    return { status: 'error', error: `${name} is shared scaffolding, not a capability, and cannot be replaced.` };
  }
  if (contents.length === 0) {
    return { status: 'error', error: `${name} is empty.` };
  }

  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);

  // Keep the previous bytes so a failed drop can be undone.
  const previous = await readIfExists(target);

  const restore = async (): Promise<void> => {
    if (previous) await fs.writeFile(target, previous);
    else await fs.rm(target, { force: true });
  };

  await fs.writeFile(target, contents);

  // ── Verify by loading ──────────────────────────────────────────────────────
  if (name.endsWith('.py')) {
    const found = await introspectPythonAgents(target);
    if (!found.ok) {
      await restore();
      return {
        status: 'error',
        error: previous
          ? `${name} did not load as an agent (${found.error}). The working version was kept.`
          : `${name} did not load as an agent: ${found.error}`,
      };
    }

    // ── Collision check ──────────────────────────────────────────────────────
    // Compare against everything already live EXCEPT agents this same file owns,
    // so re-dropping an edited agent is an update rather than a conflict.
    const live = await registry.getAllAgents();
    const clashes = found.agents
      .map(a => a.name)
      .filter(n => {
        const existing = live.get(n) as { sourceFile?: string } | undefined;
        if (!existing) return false;
        return existing.sourceFile !== target;
      });
    if (clashes.length > 0) {
      await restore();
      return {
        status: 'error',
        error: `${clashes.join(', ')} already exists. Rename the agent inside ${name} or remove the one that is installed.`,
      };
    }

    // ── Make it live ─────────────────────────────────────────────────────────
    // Forget first: a replaced file may define a different set of names, and a
    // stale entry would keep answering from the old code.
    const ownedBefore = [...live.entries()]
      .filter(([, agent]) =>
        (agent as { sourceFile?: string }).sourceFile === target)
      .map(([agentName]) => agentName);
    const replaced = ownedBefore.length > 0;
    for (const agentName of new Set([
      ...ownedBefore,
      ...found.agents.map((agent) => agent.name),
    ])) {
      registry.forget(agentName);
    }
    await registry.reloadUserAgents();

    const after = await registry.getAllAgents();
    const missing = found.agents.filter(a => !after.has(a.name)).map(a => a.name);
    if (missing.length > 0) {
      await restore();
      const failed = await registry.getAllAgents();
      for (const [agentName, agent] of failed) {
        if ((agent as { sourceFile?: string }).sourceFile === target) {
          registry.forget(agentName);
        }
      }
      await registry.reloadUserAgents();
      return { status: 'error', error: `${name} loaded but did not register: ${missing.join(', ')}.` };
    }

    return {
      status: 'ok',
      file: name,
      replaced,
      learned: found.agents.map(a => ({ name: a.name, description: a.description })),
    };
  }

  // ── JavaScript factory agents ──────────────────────────────────────────────
  // The registry only scans `_agent.js`, so a `.js` drop that is not named that
  // way would be written and silently never loaded.
  if (!name.endsWith('_agent.js')) {
    await restore();
    return {
      status: 'error',
      error: `JavaScript agents must be named *_agent.js (got ${name}) so the registry can find them.`,
    };
  }

  const before = await registry.getAllAgents();
  const beforeNames = new Set(before.keys());
  const learnedNames = await registry.reloadUserAgents();
  if (learnedNames.length === 0) {
    // Either it failed to load, or it re-registered something already present.
    await restore();
    await registry.reloadUserAgents();
    return {
      status: 'error',
      error: `${name} did not load as an agent — check that it exports createAgent(BasicAgent).`,
    };
  }

  const after = await registry.getAllAgents();
  return {
    status: 'ok',
    file: name,
    replaced: learnedNames.some(n => beforeNames.has(n)),
    learned: learnedNames.map(n => ({
      name: n,
      description: after.get(n)?.metadata?.description ?? '',
    })),
  };
}
