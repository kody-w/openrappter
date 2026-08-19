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
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reserveTestPort } from '../support/test-port.js';
import {
  listRappters,
  plannedPortFor,
  portForInstance,
  urlForInstance,
} from '../../infra/roster.js';
import {
  ALPHA_GATEWAY_PORT,
  gatewayEndpointFileFor,
  gatewayLockFileFor,
  gatewayPortFor,
  canonicalInstanceKey,
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
    // OPENRAPPTER_HOME outranks HOME when resolving the data dir, and
    // the suite sets it globally, so the sandbox needs both redirected.
    vi.stubEnv('OPENRAPPTER_HOME', `${home}/.openrappter`);

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
  // OPENRAPPTER_HOME outranks HOME when resolving the data dir, and
  // the suite sets it globally, so the sandbox needs both redirected.
  vi.stubEnv('OPENRAPPTER_HOME', `${home}/.openrappter`);
  return home;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.close(() => r()); })));
});

/**
 * A gateway this test owns. — #127
 *
 * The tests below used to write a record naming port 18790 and assert on what
 * the roster concluded, without ever starting anything there. On the machine
 * they were written on, the alpha daemon was listening — so they read the
 * developer's machine and called it a result. Everywhere else, including every
 * CI runner, `probe()` found nothing and both assertions inverted:
 *
 *   expected undefined to be true    rappter-roster.test.ts:346  (stalePort)
 *   expected false to be true        rappter-roster.test.ts:377  (running)
 *
 * `main` was red for seven consecutive commits before anyone looked, because
 * locally the same commit reported `19 passed (19)`.
 *
 * Binding our own listener makes the outcome depend on the code under test and
 * nothing else. The pid answering is then `process.pid`, which is what lets a
 * test say whether the roster can tell one owner from another.
 */
async function gatewayServing(options: { instance?: string } = {}): Promise<number> {
  const port = await reserveTestPort();
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: 'test-fixture',
        // A real gateway names itself here (#131). Omitting it models a build
        // that predates the field, which is a case the roster must still
        // handle — not a shortcut for the fixture.
        ...(options.instance === undefined ? {} : { instance: options.instance }),
        checks: { gateway: true },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', resolve); });
  return port;
}

/**
 * Make it impossible to name the process holding a port. — #131
 *
 * `listenerPid` shells out to `lsof`; emptying PATH makes that fail with
 * ENOENT on any machine, which is precisely the situation on a host that has
 * no `lsof` — several Linux container images, and the case an independent
 * reviewer reproduced. Doing it inside the test means the guarantee is proved
 * everywhere the suite runs, rather than only where somebody remembered to
 * uninstall a binary.
 */
/**
 * Can this host name the process holding a port at all?
 *
 * The three tests below exercise the PID route specifically, and that route
 * needs `lsof`. Rather than assume (which is how port 18790 got hardcoded) or
 * skip silently (which reads exactly like a passing test), they measure the
 * host and assert what is correct FOR it: the pid comparison where it can be
 * made, and the fail-closed refusal where it cannot.
 */
async function canNamePids(): Promise<boolean> {
  try {
    await promisify(execFile)('lsof', ['-v'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function withoutLsof(): void {
  vi.stubEnv('PATH', '/nonexistent-for-this-test');
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
  /**
   * The guard used to rest entirely on `lsof`. — #131
   *
   * `listenerPid` returned `undefined` both when nothing was listening and
   * when it could not ask, and `impostor` required a pid — so on a host with
   * no `lsof` the guard did not stop working, it failed OPEN and certified a
   * record it had never checked. Measured before the fix, same commit, only
   * `lsof` removed from PATH:
   *
   *     × does not report a name as running when another process holds its port
   *         → expected true to be false        (ghost.running)
   *         → expected undefined to be 38985   (ghost.pid)
   *
   * A listener that says its own name settles it without any external binary,
   * and is better evidence besides: a pid proves only "the same process wrote
   * this record", a name proves "you reached the rappter you asked for".
   */
  it('unmasks an impostor with no way to name the process holding the port', async () => {
    const home = isolatedHome();
    withoutLsof();
    // Somebody else's gateway is on this port, and it says so.
    const port = await gatewayServing({ instance: 'someone-else' });
    const file = gatewayEndpointFileFor({ instance: 'ghost' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: 'ghost', port, pid: 999_999, startedAt: 'x',
    }));

    const ghost = (await listRappters({ names: ['ghost'] })).find((r) => r.name === 'ghost');

    expect(ghost?.running).toBe(false);
    expect(ghost?.stalePort).toBe(true);
    expect(ghost?.pid).toBeUndefined();
    expect(ghost?.version).toBeUndefined();
  });

  it('recognises its own name with no way to name the process holding the port', async () => {
    // The negative control for the case above: the same conditions, and the
    // listener is who the record says. It must stay reachable — a guard that
    // refuses everything on a host without `lsof` is not a fix.
    const home = isolatedHome();
    withoutLsof();
    const port = await gatewayServing({ instance: 'live-twin' });
    const file = gatewayEndpointFileFor({ instance: 'live-twin' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: 'live-twin', port, pid: 999_999, startedAt: 'x',
    }));

    const twin = (await listRappters({ names: ['live-twin'] })).find((r) => r.name === 'live-twin');

    // The recorded pid is wrong and unverifiable, and it does not matter: the
    // listener answered to the name.
    expect(twin?.running).toBe(true);
    expect(twin?.stalePort).toBeUndefined();
    expect(twin?.ownershipUnverified).toBeUndefined();
    expect(twin?.version).toBe('test-fixture');
  });

  it('refuses to certify a record nothing can vouch for', async () => {
    // An older listener that does not name itself, on a host that cannot name
    // the process either. Neither route can speak, so the record is not an
    // address — "I could not check" is not "the record is fine".
    const home = isolatedHome();
    withoutLsof();
    const port = await gatewayServing();
    const file = gatewayEndpointFileFor({ instance: 'unknowable' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ instance: 'unknowable', port, pid: 4242 }));

    const row = (await listRappters({ names: ['unknowable'] })).find((r) => r.name === 'unknowable');

    expect(row?.running).toBe(false);
    expect(row?.ownershipUnverified).toBe(true);
    // And it must not attribute a stranger's details to this name.
    expect(row?.pid).toBeUndefined();
    expect(row?.version).toBeUndefined();
  });

  it('does not report a name as running when another process holds its port', async () => {
    const home = isolatedHome();
    // `ghost` recorded a port under a pid that is not the one answering there.
    // A healthy gateway IS serving it — this test started it — which is
    // exactly the trap: liveness alone says "running".
    const port = await gatewayServing();
    const file = gatewayEndpointFileFor({ instance: 'ghost' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: 'ghost', port, pid: 999_999, startedAt: 'x',
    }));

    const rows = await listRappters({ names: ['ghost'] });
    const ghost = rows.find((r) => r.name === 'ghost');

    // Either way it is refused; only the reason differs.
    expect(ghost?.running).toBe(false);
    if (await canNamePids()) {
      expect(ghost?.stalePort).toBe(true);
    } else {
      expect(ghost?.ownershipUnverified).toBe(true);
    }
    // And it must not hand back the pid it has no claim to.
    expect(ghost?.pid).toBeUndefined();
    expect(ghost?.version).toBeUndefined();
  });

  it('reports a twin whose record names the pid that is answering', async () => {
    // The negative control for the case above, and the property no test
    // covered: the fix must not blind the roster to real twins. Same fixture,
    // one field different — the recorded pid is the one actually listening.
    const home = isolatedHome();
    const port = await gatewayServing();
    const file = gatewayEndpointFileFor({ instance: 'live-twin' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: 'live-twin', port, pid: process.pid, startedAt: 'x',
    }));

    const rows = await listRappters({ names: ['live-twin'] });
    const twin = rows.find((r) => r.name === 'live-twin');

    expect(twin?.stalePort).toBeUndefined();
    if (await canNamePids()) {
      expect(twin?.running).toBe(true);
      expect(twin?.pid).toBe(process.pid);
      expect(twin?.version).toBe('test-fixture');
    } else {
      // This listener predates #131 and does not name itself, so on a host
      // that cannot name the process either, nothing can vouch for it.
      expect(twin?.running).toBe(false);
      expect(twin?.ownershipUnverified).toBe(true);
    }
  });

  it('trusts a record with no pid, so an upgrade does not report twins as dead', async () => {
    const home = isolatedHome();
    const port = await gatewayServing();
    const file = gatewayEndpointFileFor({ instance: 'older-build' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    // Records written before the pid field existed.
    writeFileSync(file, JSON.stringify({ instance: 'older-build', port }));

    const rows = await listRappters({ names: ['older-build'] });
    const row = rows.find((r) => r.name === 'older-build');
    // No pid to compare, so no impostor claim — it is reported on what the
    // probe alone can see, as before.
    expect(row?.stalePort).toBeUndefined();
    expect(row?.running).toBe(await canNamePids());
  });
});

/**
 * One derivation of "which twin am I". — #142
 *
 * #131 taught the roster to believe the name a gateway reports on `/health`.
 * That name was raw, while every name the roster expects is canonical, so any
 * twin whose name contains a space (or `@`, or unicode) was judged an impostor
 * by the check added to stop impostors being missed. Reproduced against a real
 * gateway started with the documented flag:
 *
 *   /health           -> instance: "review demo twin"     (raw)
 *   on disk           -> instances/review_demo_twin/…     (canonical)
 *   record pid        == listening pid
 *   openrappter twins -> ○ review_demo_twin  not running — another process
 *                          now holds its last port
 *
 * The twin WAS the process holding that port. Same failure as #101, #111 and
 * #118: two derivations of one fact drifting apart.
 */
describe('a twin is judged by the same name the roster calls it', () => {
  it('does not call a live twin an impostor because its name needed escaping', async () => {
    const home = isolatedHome();
    withoutLsof();   // force the name route to be the only one that can speak
    const raw = 'review demo twin';
    // A real gateway publishes the RAW name it was started with.
    const port = await gatewayServing({ instance: raw });
    // The record lives under the CANONICAL name, because that is what
    // `gatewayEndpointFileFor` derives.
    const file = gatewayEndpointFileFor({ instance: raw });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: raw, port, pid: process.pid, startedAt: 'x',
    }));

    const rows = await listRappters({ names: [canonicalInstanceKey(raw)] });
    const twin = rows.find((r) => r.name === canonicalInstanceKey(raw));

    expect(twin?.running).toBe(true);
    expect(twin?.stalePort).toBeUndefined();
    expect(twin?.ownershipUnverified).toBeUndefined();
  });

  it('still unmasks a real impostor whose name needed escaping', async () => {
    // The negative control: escaping must not become a way to be believed.
    const home = isolatedHome();
    withoutLsof();
    const port = await gatewayServing({ instance: 'somebody else' });
    const file = gatewayEndpointFileFor({ instance: 'review demo twin' });
    expect(file.startsWith(home)).toBe(true);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
      instance: 'review demo twin', port, pid: process.pid, startedAt: 'x',
    }));

    const name = canonicalInstanceKey('review demo twin');
    const row = (await listRappters({ names: [name] })).find((r) => r.name === name);

    expect(row?.running).toBe(false);
    expect(row?.stalePort).toBe(true);
  });
});
