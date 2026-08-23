/**
 * The hot-load contract.
 *
 * "Hot" is the load-bearing word in this feature. A file that lands on disk and
 * is only usable after a restart is not a hot-load, and the failure is invisible
 * — the person believes the organism learned something and it did not. These
 * tests pin the parts of the grail brainstem's behaviour that make the claim
 * true, and the refusals that keep it honest.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { importAgentFile, safeAgentFilename } from '../agent-import.js';
import { AgentRegistry } from '../AgentRegistry.js';
import {
  FlightRecorder,
  setFlightRecorder,
} from '../../flight-recorder/recorder.js';

let dir = '';
let registry: AgentRegistry;
let recorder: FlightRecorder;
let previousRecorder: FlightRecorder;

/** A grail-shaped agent: imports from `agents.basic_agent`, like RAR ships. */
function grailAgent(cls: string, name: string, description: string, body?: string): Buffer {
  return Buffer.from(`from agents.basic_agent import BasicAgent
import json

class ${cls}(BasicAgent):
    def __init__(self):
        self.name = '${name}'
        self.metadata = {
            "name": self.name,
            "description": "${description}",
            "parameters": {"type": "object", "properties": {}, "required": []}
        }
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        ${body ?? `return json.dumps({"status": "success", "result": "ran ${name}"})`}
`);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-hotload-'));
  // Point the registry's user directory at the temp dir. The built-in dir is
  // deliberately bogus so the sweep does not load the whole product.
  registry = new AgentRegistry(path.join(dir, '__no_builtins__'), dir);
  recorder = new FlightRecorder({ enabled: true, inMemory: true });
  await recorder.initialize();
  previousRecorder = setFlightRecorder(recorder);
});

afterEach(async () => {
  setFlightRecorder(previousRecorder);
  await recorder.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('a dropped Python agent becomes usable immediately', () => {
  it('loads, registers, and can be executed without a restart', async () => {
    const result = await importAgentFile(
      'weather_agent.py',
      grailAgent('WeatherAgent', 'Weather', 'Reports the weather.'),
      registry,
      { dir },
    );

    expect(result.status).toBe('ok');
    expect(result).toMatchObject({
      activeGeneration: 'present',
      commitState: 'committed',
      retrySafe: false,
      activeSourceSha256: result.candidateSourceSha256,
    });
    expect(result.learned?.[0]).toMatchObject({ name: 'Weather', description: 'Reports the weather.' });

    // The whole point: usable NOW, from the same registry instance.
    const agent = await registry.getAgent('Weather');
    expect(agent).toBeDefined();
    const output = await agent!.perform({});
    expect(output).toContain('ran Weather');
  }, 30_000);

  it('reports the capability, not the filename', async () => {
    const result = await importAgentFile(
      'mb_agent.py',
      grailAgent('MorningBriefAgent', 'MorningBrief', 'Summarises your day.'),
      registry,
      { dir },
    );
    // "morning_brief_agent.py" is not the interesting fact.
    expect(result.learned?.[0].description).toBe('Summarises your day.');
  }, 30_000);
});

describe('the refusals', () => {
  it('rejects a file that is not an agent, and does not leave it installed', async () => {
    const result = await importAgentFile(
      'notes.py',
      Buffer.from('x = 1\nprint("hello")\n'),
      registry,
      { dir },
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/did not load as an agent/i);
    expect(result).toMatchObject({
      activeGeneration: 'absent',
      commitState: 'not-committed',
      retrySafe: true,
    });
    expect(result.activeSourceSha256).toBeUndefined();
    // Nothing left behind: a file that cannot load must not sit in the agents
    // directory looking installed.
    await expect(fs.access(path.join(dir, 'notes.py'))).rejects.toThrow();
  }, 30_000);

  it('rejects a malformed agent with the actual Python error', async () => {
    const result = await importAgentFile(
      'broken_agent.py',
      Buffer.from('from agents.basic_agent import BasicAgent\nclass Broken(BasicAgent):\n  def perform(self'),
      registry,
      { dir },
    );
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/SyntaxError/);
  }, 30_000);

  it('keeps the working agent when a bad file is dropped over it', async () => {
    await importAgentFile('w_agent.py', grailAgent('W', 'Weather', 'Good version.'), registry, { dir });
    expect((await registry.getAgent('Weather'))).toBeDefined();

    const result = await importAgentFile(
      'w_agent.py',
      Buffer.from('this is not python at all ((('),
      registry,
      { dir },
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/working version was kept/i);
    // The original bytes must still be on disk and still loadable.
    const onDisk = await fs.readFile(path.join(dir, 'w_agent.py'), 'utf-8');
    expect(onDisk).toContain('Good version.');
  }, 40_000);

  it('refuses a name collision from a different file', async () => {
    await importAgentFile('first_agent.py', grailAgent('A', 'Weather', 'First.'), registry, { dir });
    const result = await importAgentFile('second_agent.py', grailAgent('B', 'Weather', 'Second.'), registry, { dir });

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/already exists/i);
    // The loser must not be left on disk shadowing the winner.
    await expect(fs.access(path.join(dir, 'second_agent.py'))).rejects.toThrow();
  }, 40_000);

  it('allows re-dropping the SAME file as an update, not a collision', async () => {
    await importAgentFile('w_agent.py', grailAgent('W', 'Weather', 'Version one.'), registry, { dir });
    const result = await importAgentFile('w_agent.py', grailAgent('W', 'Weather', 'Version two.'), registry, { dir });

    expect(result.status).toBe('ok');
    expect(result.replaced).toBe(true);
    // And the live agent must be the NEW code, not the cached old one.
    const agent = await registry.getAgent('Weather');
    expect(agent!.metadata?.description).toBe('Version two.');
  }, 40_000);

  it('removes agents that disappeared from a replaced Python file', async () => {
    const first = Buffer.concat([
      grailAgent('A', 'Alpha', 'Alpha version one.'),
      Buffer.from('\n'),
      grailAgent('B', 'Beta', 'Beta version one.'),
    ]);
    await importAgentFile('multi_agent.py', first, registry, { dir });
    expect(await registry.getAgent('Alpha')).toBeDefined();
    expect(await registry.getAgent('Beta')).toBeDefined();

    await importAgentFile(
      'multi_agent.py',
      grailAgent('A', 'Alpha', 'Alpha version two.'),
      registry,
      { dir },
    );

    expect((await registry.getAgent('Alpha'))?.metadata?.description).toBe(
      'Alpha version two.',
    );
    expect(await registry.getAgent('Beta')).toBeUndefined();
  }, 40_000);

  it('re-reads an edit that CPython\'s bytecode cache would call unchanged', async () => {
    // The .pyc validity check is (mtime_seconds, size). Two versions of the same
    // agent that differ only in a same-length string, written inside one
    // timestamp tick, are indistinguishable to it — so the previous bytecode
    // gets re-executed and the edit appears to do nothing.
    //
    // Forced here rather than hoped for: both files are the same size and both
    // mtimes are pinned to the same second.
    const file = path.join(dir, 'pin_agent.py');
    const one = grailAgent('P', 'Pinned', 'Version one.');
    const two = grailAgent('P', 'Pinned', 'Version two.');
    expect(two.length).toBe(one.length); // the condition the cache is fooled by

    await importAgentFile('pin_agent.py', one, registry, { dir });
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
    await fs.utimes(file, pinned, pinned);

    await importAgentFile('pin_agent.py', two, registry, { dir });
    await fs.utimes(file, pinned, pinned);
    await registry.reloadUserAgents();

    expect((await registry.getAgent('Pinned'))!.metadata?.description).toBe('Version two.');
  }, 40_000);

  it('refuses the shared base class', async () => {
    const result = await importAgentFile('basic_agent.py', Buffer.from('x=1'), registry, { dir });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scaffolding/i);
    expect(result.activeGeneration).toBe('absent');
    expect(result.activeSourceSha256).toBeUndefined();
  });

  it('refuses a file that is not .py or .js', async () => {
    const result = await importAgentFile('notes.txt', Buffer.from('hello'), registry, { dir });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not an agent/i);
    expect(result.activeGeneration).toBe('absent');
    expect(result.activeSourceSha256).toBeUndefined();
  });

  it('refuses an empty file rather than installing nothing', async () => {
    const result = await importAgentFile('empty_agent.py', Buffer.from(''), registry, { dir });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/empty/i);
    expect(result.activeGeneration).toBe('absent');
    expect(result.activeSourceSha256).toBeUndefined();
  });
});

describe('the filename is never trusted', () => {
  it('strips path traversal', () => {
    expect(safeAgentFilename('../../../etc/passwd')).toBe('passwd');
    expect(safeAgentFilename('/etc/shadow')).toBe('shadow');
    expect(safeAgentFilename('..')).toBe('agent.py');
  });

  it('writes inside the agents directory even for a hostile name', async () => {
    await importAgentFile(
      '../../escape_agent.py',
      grailAgent('E', 'Escape', 'Tries to escape.'),
      registry,
      { dir },
    );
    // It lands in the agents dir, not two levels up.
    const entries = await fs.readdir(dir);
    expect(entries).toContain('escape_agent.py');
  }, 30_000);
});

describe('the registry can rescan while running', () => {
  it('picks up a file written behind its back', async () => {
    await registry.getAllAgents(); // force the initial sweep and latch `loaded`
    await fs.writeFile(path.join(dir, 'late_agent.py'), grailAgent('L', 'Late', 'Arrived late.'));

    // Before the rescan the latch means nothing new is visible.
    const learned = await registry.reloadUserAgents();

    expect(learned).toContain('Late');
    expect(await registry.getAgent('Late')).toBeDefined();
  }, 30_000);
});
