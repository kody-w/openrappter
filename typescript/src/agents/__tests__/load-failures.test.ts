/**
 * A file that fails to become an agent must still be accounted for.
 *
 * The sweep is deliberately resilient — one broken file must not cost you
 * every other agent. But every failure path discarded its error, so the only
 * evidence was an absence: the capability was simply missing, with nothing
 * anywhere saying which file or why.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { AgentRegistry } from '../AgentRegistry.js';
import { logger, type LogEntry, type Transport } from '../../logging/logger.js';

let dir = '';
let registry: AgentRegistry;

function workingAgent(cls: string, name: string): string {
  return `from agents.basic_agent import BasicAgent
import json

class ${cls}(BasicAgent):
    def __init__(self):
        self.name = '${name}'
        self.metadata = {
            "name": self.name,
            "description": "works",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "result": "ran ${name}"})
`;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-loadfail-'));
  registry = new AgentRegistry(path.join(dir, '__no_builtins__'), dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the failure reaches an operator, not just an accessor', () => {
  it('warns, the way the Python registry always has', async () => {
    // getLoadFailures() only helps something that calls it, and nothing does.
    const entries: LogEntry[] = [];
    const capture: Transport = { write: (e) => entries.push(e) };
    logger.addTransport(capture);
    try {
      await fs.writeFile(path.join(dir, 'broken_agent.py'), 'not python(\n');
      await registry.reloadUserAgents();
    } finally {
      logger.removeTransport(capture);
    }

    const warning = entries.find((e) => e.level === 'warn' && e.component === 'agents');
    expect(warning).toBeDefined();
    expect(String(warning?.data?.file)).toContain('broken_agent.py');
    expect(String(warning?.data?.reason).length).toBeGreaterThan(0);
  });
});

describe('a file that cannot become an agent', () => {
  it('is reported, with the file and a reason', async () => {
    await fs.writeFile(path.join(dir, 'broken_agent.py'), 'this is not valid python(\n');

    await registry.reloadUserAgents();

    const failures = registry.getLoadFailures();
    expect(failures).toHaveLength(1);
    expect(failures[0].file).toContain('broken_agent.py');
    expect(failures[0].reason.length).toBeGreaterThan(0);
  });

  it('does not cost the sweep the agents that do load', async () => {
    // The whole reason the errors were swallowed. Keep that property.
    await fs.writeFile(path.join(dir, 'broken_agent.py'), 'nope(\n');
    await fs.writeFile(path.join(dir, 'good_agent.py'), workingAgent('GoodAgent', 'Good'));

    await registry.reloadUserAgents();

    const agents = await registry.getAllAgents();
    expect([...agents.keys()]).toContain('Good');
    expect(registry.getLoadFailures().map((f) => f.file).join()).toContain('broken_agent.py');
  });

  it('reports nothing when every file loads', async () => {
    // Without this, always reporting a failure would satisfy the tests above.
    await fs.writeFile(path.join(dir, 'good_agent.py'), workingAgent('GoodAgent', 'Good'));

    await registry.reloadUserAgents();

    expect(registry.getLoadFailures()).toEqual([]);
  });

  it('clears the entry once the file is fixed and rescanned', async () => {
    const file = path.join(dir, 'later_agent.py');
    await fs.writeFile(file, 'still broken(\n');
    await registry.reloadUserAgents();
    expect(registry.getLoadFailures()).toHaveLength(1);

    await fs.writeFile(file, workingAgent('LaterAgent', 'Later'));
    await registry.reloadUserAgents();

    expect(registry.getLoadFailures()).toEqual([]);
  });
});
