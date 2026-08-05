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
    const roster = await import('../../infra/roster.js');
    expect(roster.urlForInstance('scout'))
      .toBe(`http://127.0.0.1:${roster.portForInstance('scout')}`);
    expect(roster.portForInstance(undefined)).toBe(ALPHA_GATEWAY_PORT);
  });

  it('the alpha still resolves to its original port with no record', () => {
    expect(gatewayPortFor({})).toBe(ALPHA_GATEWAY_PORT);
  });
});
