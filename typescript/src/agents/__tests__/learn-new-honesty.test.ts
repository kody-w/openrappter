/**
 * The agent writer must say what it actually produced.
 *
 * With no model available, `LearnNewAgent` falls back to a scaffold that echoes
 * its input rather than implementing the description. The result JSON reported
 * plain success, so a caller printed "installed X" for an agent that does
 * nothing — "writes the agent live" overstating a template.
 *
 * Two things are covered: the result now distinguishes a scaffold from a real
 * generation, and the writer can be handed a model after construction (the
 * registry builds agents with no arguments, which is why it never had one).
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearnNewAgent } from '../LearnNewAgent.js';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'learnnew-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('LearnNewAgent honesty', () => {
  it('labels a no-model build as a scaffold, not an implementation', async () => {
    const agent = new LearnNewAgent(dir); // no provider
    const res = JSON.parse(
      await agent.execute({ action: 'create', description: 'count words in text' }),
    ) as Record<string, unknown>;
    expect(res.status).toBe('success');
    expect(res.implementation, 'a template must not be reported as generated').toBe('scaffold');
    expect(String(res.note)).toMatch(/echoes its input/i);
  });

  it('still writes a loadable file', async () => {
    const agent = new LearnNewAgent(dir);
    const res = JSON.parse(
      await agent.execute({ action: 'create', description: 'count words' }),
    ) as Record<string, unknown>;
    const src = await readFile(String(res.file_path), 'utf8');
    expect(src).toContain('export function createAgent');
  });

  it('accepts a model after construction', async () => {
    const agent = new LearnNewAgent(dir);
    expect(typeof (agent as unknown as { setProvider?: unknown }).setProvider).toBe('function');
  });
});
