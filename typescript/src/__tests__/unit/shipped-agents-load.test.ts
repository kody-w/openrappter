/**
 * A shipped agent has to load. — the gap behind #144
 *
 * `agents/morning_brief_agent.js` could not be imported at all for 26 days.
 * Its manifest declaration ended `} as const;` — TypeScript, in a `.js` file —
 * so Node threw `Unexpected identifier 'as'` before reading a line of it. It
 * arrived that way in "all 43 agents on the RAPP contract, and a gate that can
 * prove it", which put a `__manifest__` on every agent.
 *
 * The gate could not prove it. Run `conformance.py` against the broken file
 * and against the fixed one and it reports `8 passed, 0 failed` both times,
 * because it reads the manifest out of the file and never asks Node whether
 * the file is loadable. Everything downstream agreed: the agent was contract-
 * compliant, correctly named, tagged `quality_tier: 'official'` — and absent.
 *
 * The only symptom was one WARN per gateway start:
 *
 *   WARN [agents] Agent file failed to load
 *     {"file":"~/.openrappter/agents/morning_brief_agent.js",
 *      "reason":"Unexpected identifier 'as'"}
 *
 * `LearnNewAgent` already carries a comment naming this exact file as the
 * casualty that proved a generated agent could report success while being
 * unloadable. That fixed the generator. Nobody fixed the file it generated,
 * and nothing in CI would have said so.
 *
 * `node --check` is not the missing check: it passes on `as const` because it
 * parses as a script, while the ESM import that the registry actually performs
 * fails. So this runs the registry's real sequence instead — import, then
 * `createAgent(BasicAgent)`, then `new AgentClass()`, then read `.name` — which
 * is the only thing that answers the question being asked.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { BasicAgent } from '../../agents/BasicAgent.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const shippedAgentsDir = join(repoRoot, 'agents');

const shippedAgents = readdirSync(shippedAgentsDir).filter((file) => file.endsWith('_agent.js'));

describe('every shipped agent loads the way the registry loads it', () => {
  /**
   * Without this, the suite would pass by finding nothing — which is the same
   * kind of hole as a gate that proves a manifest and not a load.
   */
  it('finds the shipped agents at all', () => {
    expect(shippedAgents.length).toBeGreaterThan(0);
  });

  it.each(shippedAgents)('%s imports as an ES module', async (file) => {
    const url = pathToFileURL(join(shippedAgentsDir, file)).href;
    await expect(import(url)).resolves.toBeDefined();
  });

  it.each(shippedAgents)('%s exports createAgent and instantiates', async (file) => {
    const url = pathToFileURL(join(shippedAgentsDir, file)).href;
    const mod = await import(url);

    expect(typeof mod.createAgent, `${file} must export createAgent(BasicAgent)`).toBe('function');

    const AgentClass = mod.createAgent(BasicAgent);
    expect(AgentClass, `${file} createAgent returned nothing`).toBeTruthy();

    const instance = new AgentClass();
    // The registry keys the agent map on this, so a blank name is a silent no-op.
    expect(typeof instance.name).toBe('string');
    expect(instance.name.length).toBeGreaterThan(0);
  });

  it.each(shippedAgents)('%s declares a manifest that survives the import', async (file) => {
    const url = pathToFileURL(join(shippedAgentsDir, file)).href;
    const mod = await import(url);

    // Read from the imported module rather than the file text: the whole point
    // is that a manifest can be perfectly well-formed in a file Node refuses.
    expect(mod.__manifest__?.schema).toBe('rapp-agent/1.0');
    expect(mod.__manifest__?.name).toBeTruthy();
  });

  it('would have caught the TypeScript-in-JavaScript that broke this', async () => {
    const url = pathToFileURL(join(shippedAgentsDir, 'morning_brief_agent.js')).href;
    const mod = await import(url);
    expect(mod.__manifest__.name).toBe('@openrappter/morning-brief');
  });
});
