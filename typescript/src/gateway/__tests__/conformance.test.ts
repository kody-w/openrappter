/**
 * Conformance guards for the burrowed pattern and the reserved agent dirs.
 *
 * Both are cases where the honest answer and the convenient answer differ, and
 * where getting it wrong is invisible until it hurts someone:
 *
 *  - A detector that cannot see openrappter tells a user with a live organism
 *    that they have none. `burrow.js`: *"A 403 is an answer. Silence is not."*
 *  - A `disabled_agents/` directory that does not disable anything means an
 *    agent someone deliberately switched off keeps running.
 */

import { describe, expect, it, afterEach } from 'vitest';
import http from 'http';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { startBurrowBeacon, BURROW_PROBE_PORTS, type BeaconHandle } from '../burrow-beacon.js';
import { isReservedAgentPath, RESERVED_AGENT_DIRS, AgentRegistry } from '../../agents/AgentRegistry.js';
import { readAnatomy } from '../anatomy.js';
import { reserveTestPort } from '../../__tests__/support/test-port.js';

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close().catch(() => {});
});

/** A stand-in for something already holding a probed port (the grail, a twin). */
function occupy(port: number): Promise<{ close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const s = http.createServer((_q, r) => { r.writeHead(200); r.end('busy'); });
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve({
      close: () => new Promise<void>(res => s.close(() => res())),
    }));
  });
}

describe('the burrow beacon makes openrappter detectable', () => {
  it('probes the same ports burrow.js does', () => {
    // If these drift apart the detector silently stops seeing us again.
    expect([...BURROW_PROBE_PORTS]).toEqual([7071, 7081, 7082, 7083]);
  });

  it('binds a free probed port and answers /health', async () => {
    // Kernel-assigned so a real grail on 7071 is never touched and nothing on
    // the runner can already hold them. These used to be hardcoded 49_18x,
    // which is the guessing PR #51 removed everywhere else.
    const probes = [await reserveTestPort(), await reserveTestPort()];
    const beacon = await startBurrowBeacon(probes, {
      name: 'Mero', designation: 'openrappter-MR-3565', gatewayPort: 18790,
    });
    expect(beacon).not.toBeNull();
    open.push(beacon as BeaconHandle);

    const body = await new Promise<string>((resolve) => {
      http.get(`http://127.0.0.1:${beacon!.port}/health`, res => {
        let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(d));
      });
    });
    const json = JSON.parse(body);
    expect(json.status).toBe('ok');
    // A signpost, not a door: it names where the real gateway is.
    expect(json.gateway).toContain('18790');
  }, 20_000);

  it('NEVER displaces something already listening', async () => {
    // 7071 is the grail parent and 7081+ are its twins. Squatting one would
    // break a real brainstem in order to advertise ourselves.
    const taken = await reserveTestPort();
    const free = await reserveTestPort();
    const squatter = await occupy(taken);
    open.push(squatter);

    const beacon = await startBurrowBeacon([taken, free], {
      name: 'Mero', gatewayPort: 18790,
    });
    open.push(beacon as BeaconHandle);
    expect(beacon!.port).toBe(free);
  }, 20_000);

  it('stays quiet when every probed port is taken, rather than fighting', async () => {
    const first = await reserveTestPort();
    const second = await reserveTestPort();
    const a = await occupy(first); open.push(a);
    const b = await occupy(second); open.push(b);
    // Not a failure: if something else answers there, the detector already
    // reports a brainstem on this device.
    expect(await startBurrowBeacon([first, second], { name: 'Mero', gatewayPort: 18790 })).toBeNull();
  }, 20_000);

  it('refuses a cross-origin read but still answers, so an opaque probe resolves', async () => {
    const beacon = await startBurrowBeacon([await reserveTestPort()], { name: 'Mero', gatewayPort: 18790 });
    open.push(beacon as BeaconHandle);

    const status = await new Promise<number>((resolve) => {
      http.get({
        host: '127.0.0.1', port: beacon!.port, path: '/health',
        headers: { Origin: 'https://kody-w.github.io' },
      }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    });
    // A 403 is an answer — it resolves the probe without becoming a data path.
    expect(status).toBe(403);
  }, 20_000);
});

describe('reserved agent directories are never auto-loaded', () => {
  it('names exactly what KERNEL §2.3 freezes', () => {
    expect([...RESERVED_AGENT_DIRS]).toEqual(['experimental_agents', 'disabled_agents']);
  });

  it('recognises a reserved path at any depth', () => {
    expect(isReservedAgentPath('disabled_agents/tide_agent.py')).toBe(true);
    expect(isReservedAgentPath('experimental_agents/x/tide_agent.py')).toBe(true);
    expect(isReservedAgentPath('swarms/disabled_agents/tide_agent.py')).toBe(true);
    // A normal subdirectory is the user's to organize (§2.3 allows it).
    expect(isReservedAgentPath('swarms/tide_agent.py')).toBe(false);
    expect(isReservedAgentPath('tide_agent.py')).toBe(false);
  });

  it('actually stops a disabled agent from loading', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openrappter-reserved-'));
    try {
      const agent = (name: string) => `from agents.basic_agent import BasicAgent
import json

class ${name}Agent(BasicAgent):
    def __init__(self):
        self.name = '${name}'
        self.metadata = {"name": self.name, "description": "t",
                         "parameters": {"type": "object", "properties": {}, "required": []}}
        super().__init__(name=self.name, metadata=self.metadata)

    def perform(self, **kwargs):
        return json.dumps({"status": "success", "result": "${name}"})
`;
      // One live, one deliberately switched off, one in an ordinary subdir.
      await fs.writeFile(path.join(dir, 'live_agent.py'), agent('Live'));
      await fs.mkdir(path.join(dir, 'disabled_agents'), { recursive: true });
      await fs.writeFile(path.join(dir, 'disabled_agents', 'off_agent.py'), agent('Off'));
      await fs.mkdir(path.join(dir, 'swarms'), { recursive: true });
      await fs.writeFile(path.join(dir, 'swarms', 'nested_agent.py'), agent('Nested'));

      // The registry only sweeps user agents when the built-in dir resolves,
      // so give it an empty one — this exercises the real discovery path rather
      // than the test-context shortcut.
      const builtins = path.join(dir, 'builtins');
      await fs.mkdir(builtins, { recursive: true });
      const registry = new AgentRegistry(builtins, dir);
      const agents = await registry.getAllAgents();

      expect(agents.has('Live')).toBe(true);
      // The whole point: switching it off actually switches it off.
      expect(agents.has('Off')).toBe(false);
      // And a normal subdirectory still loads, or the walk broke something.
      expect(agents.has('Nested')).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('liveness is three states, never a boolean', () => {
  it('reports awake when it answered', () => {
    const v = readAnatomy(undefined, { awake: true }).vitals;
    expect(v.liveness).toBe('awake');
    expect(v.certain).toBe(true);
  });

  it('reports asleep when it refused — observed, normal, and certain', () => {
    const v = readAnatomy(undefined, { awake: false }).vitals;
    expect(v.liveness).toBe('asleep');
    expect(v.certain).toBe(true);
  });

  it('reports blocked, NOT asleep, when we were not allowed to look', () => {
    // The failure this state exists to prevent: telling someone with a live
    // organism that they have none.
    const v = readAnatomy(undefined, { awake: false, blocked: true }).vitals;
    expect(v.liveness).toBe('blocked');
    expect(v.certain).toBe(false);
    expect(v.livenessReason.toLowerCase()).toContain('nothing was learned');
  });

  it('is not certain about a timeout — an expired deadline is a missing verdict', () => {
    // Loopback refuses in ~3ms; a live brainstem answers in ~236ms. A deadline
    // that expired did not observe an absence.
    const v = readAnatomy(undefined, { awake: false, timedOut: true }).vitals;
    expect(v.liveness).toBe('asleep');
    expect(v.certain).toBe(false);
    expect(v.livenessReason.toLowerCase()).toContain('not conclusive');
  });
});
