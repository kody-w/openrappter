/**
 * A directory is not a heartbeat. — #107
 *
 * Measured on this machine before any of this existed:
 *
 *   $ ls ~/.openrappter/instances/
 *   courier
 *   scout
 *   $ lsof -nP -iTCP -sTCP:LISTEN | awk '$9 ~ /:19[0-9][0-9][0-9]$/'
 *   (nothing)
 *
 * Two names, zero running, and `courier` had never successfully started at all
 * — it exited before binding during a port-collision test. The runtime lock is
 * `gateway.pid.sqlite`; SQLite releases the advisory lock when the process dies
 * and leaves the file behind, so a directory means "this name was used once".
 *
 * An implementation that listed directories would have confidently reported two
 * live twins. That is the failure this file exists to prevent, so the tests
 * below are mostly about what the roster must REFUSE to conclude.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  listRappters,
  plannedPortFor,
  portForInstance,
  recordedPortFor,
  urlForInstance,
} from '../../infra/roster.js';
import {
  ALPHA_GATEWAY_PORT,
  gatewayEndpointFileFor,
  gatewayLockFileFor,
  gatewayPortFor,
  readGatewayEndpoint,
  writeGatewayEndpoint,
} from '../../infra/gateway-lock.js';

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a rappter records where it actually landed', () => {
  it('keeps the endpoint beside that rappter\'s own lock', () => {
    // If these ever separate, a twin's address and its lock end up in different
    // directories and the roster reads one twin's record for another.
    for (const options of [{}, { instance: 'scout' }, { port: 19_901 }]) {
      expect(dirname(gatewayEndpointFileFor(options)))
        .toBe(dirname(gatewayLockFileFor(options)));
    }
  });

  it('survives a round trip', () => {
    const home = mkdtempSync(join(tmpdir(), 'rappter-home-'));
    homes.push(home);
    const file = join(home, 'endpoint.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: 'scout', port: 19_509, pid: 4242, startedAt: '2026-08-05T07:00:00.000Z',
    }));
    expect(readGatewayEndpoint(file)?.port).toBe(19_509);
    expect(readGatewayEndpoint(file)?.pid).toBe(4242);
  });

  it('treats a missing, corrupt or portless record as unknown, never as an address', () => {
    const home = mkdtempSync(join(tmpdir(), 'rappter-home-'));
    homes.push(home);

    expect(readGatewayEndpoint(join(home, 'nope.json'))).toBeNull();

    const corrupt = join(home, 'corrupt.json');
    writeFileSync(corrupt, '{ not json');
    expect(readGatewayEndpoint(corrupt)).toBeNull();

    // A record without a usable port is worse than none: it would send the
    // roster to probe NaN and report a running twin as dead.
    for (const [name, body] of [
      ['noport.json', '{"instance":"scout"}'],
      ['nanport.json', '{"instance":"scout","port":"19509"}'],
    ] as const) {
      const file = join(home, name);
      writeFileSync(file, body);
      expect(readGatewayEndpoint(file)).toBeNull();
    }
  });

  it('never throws when it cannot write — a rappter that cannot say where it is must still serve', () => {
    // The record is a convenience for the roster. Losing it must never take
    // down the thing that is actually answering requests.
    //
    // HOME is redirected first. The first version of this test called the real
    // function against the real home and left a directory called
    // `__impossible` in ~/.openrappter/instances/ — which the roster then
    // dutifully listed, because the name sanitiser turns almost any input into
    // a writable path. A unit test that pollutes the machine it runs on is a
    // defect in the test.
    const home = mkdtempSync(join(tmpdir(), 'rappter-home-'));
    homes.push(home);
    vi.stubEnv('HOME', home);

    expect(() => writeGatewayEndpoint({
      instance: '\0/impossible', port: 1, pid: 1, startedAt: 'x',
    })).not.toThrow();
  });
});

describe('the roster refuses to infer life from the filesystem', () => {
  it('reports a known-but-dead twin as not running, and still lists it', async () => {
    // The exact measured state: a name on disk with nothing behind it. The
    // name is passed in rather than mocked, so this exercises the real
    // function — a test that stubbed the lookup would only prove the stub ran.
    const roster = await import('../../infra/roster.js');
    const entries = await roster.listRappters({
      // A name nothing could be listening for: its derived port is free, and
      // if it somehow were not, the health SHAPE check rejects a non-gateway.
      names: ['ghost-instance-that-never-ran'],
    });
    const ghost = entries.find((e) => e.name === 'ghost-instance-that-never-ran');
    expect(ghost).toBeDefined();
    expect(ghost?.running).toBe(false);
    // Listed, not filtered out. Hiding it recreates the blindness.
    expect(entries).toHaveLength(2);
  });

  it('always includes the alpha, even with no instance directories at all', async () => {
    const roster = await import('../../infra/roster.js');
    const entries = await roster.listRappters({ names: [] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.isAlpha).toBe(true);
    expect(entries[0]?.name).toBe('alpha');
  });
});

describe('a twin\'s address still cannot always be re-derived', () => {
  it('a name and its sanitised form now agree — that disagreement WAS a defect', () => {
    // This test used to assert the opposite, and cited the disagreement as a
    // reason the endpoint record exists. It was documenting a bug as a feature.
    //
    // `gatewayPortFor` hashed the RAW name while `gatewayLockFileFor` sanitised
    // it, so `scout/two` and `scout_two` derived different ports and shared one
    // lock, one endpoint record and one roster row. Live, `hatch "a b"` then
    // `hatch a_b` reported "a_b is already running" and handed back the pid of
    // a different twin that had never been asked for. Fixed in #111 by putting
    // both through `canonicalInstanceKey`.
    //
    // The endpoint record is still necessary — see the next test — but for the
    // other reason, not this one.
    const raw = 'scout/two';
    const sanitised = 'scout_two';
    expect(gatewayPortFor({ instance: raw }))
      .toBe(gatewayPortFor({ instance: sanitised }));
    expect(gatewayLockFileFor({ instance: raw }))
      .toBe(gatewayLockFileFor({ instance: sanitised }));
    expect(gatewayLockFileFor({ instance: raw })).toContain(sanitised);
  });

  it('an explicit port beats the derivation, so only a record can find that twin', () => {
    // A twin started with `--instance scout --port 19901` binds 19901, while
    // its name implies 19509. Re-deriving would report it DEAD while serving.
    expect(gatewayPortFor({ instance: 'scout' })).not.toBe(19_901);
    expect(gatewayPortFor({ instance: 'scout', port: 19_901 })).toBe(19_901);
  });

  it('the roster and `twin say` resolve an address the same way', async () => {
    // Measured: `twins` found archivist on :19950 from its record while
    // `twin say --to-instance archivist` derived :19591 and could not reach it.
    // A twin that can be SEEN by name but not SPOKEN to by name breaks the
    // promise #101 made. One resolver, both callers.
    //
    // Both now return undefined for a name with no endpoint record rather than
    // deriving a port that may belong to another rappter — see #114.
    const roster = await import('../../infra/roster.js');
    expect(roster.urlForInstance('no-such-twin-has-ever-run')).toBeUndefined();
    expect(roster.portForInstance('no-such-twin-has-ever-run')).toBeUndefined();
    // The alpha keeps its documented constant; that is not a guess.
    expect(roster.portForInstance(undefined)).toBe(ALPHA_GATEWAY_PORT);
    expect(roster.urlForInstance(undefined)).toBe(`http://127.0.0.1:${ALPHA_GATEWAY_PORT}`);
  });

  it('the alpha still resolves to its original port with no record', () => {
    expect(gatewayPortFor({})).toBe(ALPHA_GATEWAY_PORT);
  });
});

/**
 * A name that never started is not answered for by somebody else. — #114
 *
 * `gatewayPortFor` maps a name into 900 slots. "Far more twins than a device
 * will ever hatch" is true for capacity and irrelevant to collisions: measured,
 * 4 collisions among 52 plausible names, including `twin-0` and `twin-38`.
 *
 * Reproduced live. `tender` and `thicket` both derive 19212:
 *
 *   $ openrappter hatch tender     -> Hatching tender on :19212 (pid 25383)
 *   $ openrappter hatch thicket    -> Hatching thicket on :19212 (pid 25577)
 *     ...pid 25577 died on EADDRINUSE, in a log nobody was watching
 *
 *   $ openrappter twins
 *     ● tender    :19212  pid 25383  up 2m
 *     ● thicket   :19212  pid 25383  up 2m        <- thicket was dead
 *
 *   $ openrappter twin say --to-instance thicket --text "your instance name?"
 *     thicket: openrappter-RM-0059                <- tender answered
 *
 * Three running rappters reported where there were two, and a message to a
 * rappter that had never existed was answered by a different one under its
 * name. That is the sentence #111's own commit used, reached by the collision
 * route instead of the sanitisation route.
 *
 * The evidence that settles it is on disk: a twin that listened has an
 * `endpoint.json`; `thicket` had only `gateway.pid.sqlite`, because
 * `acquireLock` mkdirs the directory before the bind is attempted. So the
 * record — not the directory — is what proves a name ever owned a port.
 */
const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** A private HOME so nothing here reads or writes the real machine. */
function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'roster-home-'));
  sandboxes.push(home);
  vi.stubEnv('HOME', home);
  return home;
}

/**
 * Write an endpoint record, refusing to leave the sandbox.
 *
 * The guard is not decoration. When `defaultGatewayLockFile()` froze home at
 * import time (#110), the equivalent helper wrote its fixture into the
 * operator's real ~/.openrappter/endpoint.json and the live roster began
 * reporting a running alpha as dead. A regression should break this test, never
 * the machine running it.
 */
function recordEndpoint(instance: string, port: number): void {
  const file = gatewayEndpointFileFor({ instance });
  const sandbox = sandboxes[sandboxes.length - 1];
  if (!sandbox || !file.startsWith(sandbox)) {
    throw new Error(`refusing to write outside the sandbox\n  sandbox: ${sandbox}\n  target: ${file}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ instance, port, pid: 4242, startedAt: 'x' }));
}

describe('a name with no endpoint record is not given someone else\'s port', () => {
  it('returns no port and no url for a name that never started', () => {
    isolatedHome();
    expect(portForInstance('never-hatched')).toBeUndefined();
    expect(urlForInstance('never-hatched')).toBeUndefined();
  });

  it('still resolves a twin that DID record an address', () => {
    // The fix must not blind the roster to real twins.
    isolatedHome();
    recordEndpoint('tender', 19_212);
    expect(portForInstance('tender')).toBe(19_212);
    expect(urlForInstance('tender')).toBe('http://127.0.0.1:19212');
  });

  it('keeps the alpha resolvable without a record — a constant is not a guess', () => {
    isolatedHome();
    expect(portForInstance(undefined)).toBe(ALPHA_GATEWAY_PORT);
  });

  it('reports a never-started name as not running, without probing', async () => {
    // `tender` is recorded on 19212 and something may well be listening there.
    // `thicket` must NOT inherit that liveness.
    isolatedHome();
    recordEndpoint('tender', 19_212);
    const rows = await listRappters({ names: ['thicket'] });
    const thicket = rows.find((r) => r.name === 'thicket');
    expect(thicket?.running).toBe(false);
    expect(thicket?.neverStarted).toBe(true);
    // No pid borrowed from whoever holds the port.
    expect(thicket?.pid).toBeUndefined();
  });

  it('still plans a port for a NEW twin of that name', () => {
    // Planning where to put a twin and saying where one lives are different
    // questions; conflating them is what let a guess be reported as a fact.
    isolatedHome();
    expect(plannedPortFor('thicket')).toBe(gatewayPortFor({ instance: 'thicket' }));
    expect(plannedPortFor('tender')).toBe(gatewayPortFor({ instance: 'tender' }));
    // tender and thicket genuinely collide — that is why hatch must check.
    expect(plannedPortFor('tender')).toBe(plannedPortFor('thicket'));
  });

  it('prefers a recorded address over the derived plan', () => {
    isolatedHome();
    recordEndpoint('tender', 19_950);
    expect(plannedPortFor('tender')).toBe(19_950);
  });
});

/**
 * A record is an address only while its own pid is the one answering. — #118
 *
 * #114 replaced "derive a port from the name" with "read the port the twin
 * recorded", closing the DERIVED route to a phantom twin. `releaseLock` unlinks
 * `gateway.pid` and never `endpoint.json`, so a dead twin's record keeps naming
 * a port somebody else may since have taken — and every symptom #114 claimed to
 * end came back, with no `--port`, using the same two colliding names:
 *
 *   hatch thicket -> up on :19212 (pid 48774);  kill it; record REMAINS
 *   hatch tender  -> up on :19212 (pid 49019)
 *
 *   twins   ● tender  :19212 pid 49019
 *           ● thicket :19212 pid 49019     <- dead; that is tender's pid
 *   twin say --to-instance thicket -> "tender"
 *   hatch thicket -> "already running (pid 49019)"  -> can never be hatched again
 *
 * #114 reasoned about "a name that never started" and fixed exactly that. "A
 * name that started once and died" is the same phantom by a different road, and
 * the tests it shipped only ever exercised an ABSENT record — which is why 4328
 * of them passed.
 *
 * The two numbers that tell the two apart were already being fetched and thrown
 * away: the record's own pid, and whoever is actually listening.
 */
describe('a stale endpoint record is history, not an address', () => {
  it('does not report a name as running when another process holds its port', async () => {
    const home = isolatedHome();
    // `ghost` recorded port 18790 under a pid that is not the alpha's. The
    // alpha IS listening there, so the probe will find a healthy gateway —
    // exactly the trap.
    const file = gatewayEndpointFileFor({ instance: 'ghost' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: 'ghost', port: 18_790, pid: 999_999, startedAt: 'x',
    }));

    const rows = await listRappters({ names: ['ghost'] });
    const ghost = rows.find((r) => r.name === 'ghost');

    expect(ghost?.running).toBe(false);
    expect(ghost?.stalePort).toBe(true);
    // And it must not hand back the pid it has no claim to.
    expect(ghost?.pid).toBeUndefined();
    expect(ghost?.version).toBeUndefined();
  });

  it('still reports a live twin whose record matches the listener', async () => {
    // The fix must not blind the roster to real twins. The alpha's own record
    // names the pid that is actually serving 18790, so it stays visible.
    isolatedHome();
    const rows = await listRappters({ names: [] });
    const alpha = rows.find((r) => r.isAlpha);
    expect(alpha).toBeDefined();
    // The alpha is exempt from the pid check by design: its port is a
    // documented constant rather than a recorded claim.
    expect(alpha?.stalePort).toBeUndefined();
  });

  it('trusts a record with no pid, so an upgrade does not report twins as dead', async () => {
    const home = isolatedHome();
    const file = gatewayEndpointFileFor({ instance: 'older-build' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    // Records written before the pid field existed.
    writeFileSync(file, JSON.stringify({ instance: 'older-build', port: 18_790 }));

    const rows = await listRappters({ names: ['older-build'] });
    const row = rows.find((r) => r.name === 'older-build');
    // No pid to compare, so no impostor claim — it is reported on what the
    // probe alone can see, as before.
    expect(row?.stalePort).toBeUndefined();
    expect(row?.running).toBe(true);
  });
});
