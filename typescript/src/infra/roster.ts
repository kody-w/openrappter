import { openrappterPath } from './openrappter-home.js';
/**
 * Who is running on this device. — #107
 *
 * After #101, #102 and #103 a device can run an alpha plus any number of
 * hatched twins, each on its own port, each knowing which rappter it is and
 * each correctly refusing to duplicate the alpha's outbound channels. Nothing
 * could answer "what is running right now".
 *
 * The obvious implementation is wrong. Measured before this existed:
 *
 *   $ ls ~/.openrappter/instances/
 *   courier
 *   scout
 *   $ lsof -nP -iTCP -sTCP:LISTEN | awk '$9 ~ /:19[0-9][0-9][0-9]$/'
 *   (nothing)
 *
 * Two names on disk, zero running — and `courier` had never successfully
 * started at all. The lock is `gateway.pid.sqlite`, and SQLite drops the
 * advisory lock when a process dies but leaves the file behind, so presence on
 * disk means "this name was used once", not "this twin is alive".
 *
 * So liveness here is only ever answered by PROBING. A directory contributes a
 * candidate to check; it never contributes an answer.
 */

import { readdirSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ALPHA_GATEWAY_PORT,
  canonicalInstanceKey,
  gatewayEndpointFileFor,
  gatewayPortFor,
  readGatewayEndpoint,
} from './gateway-lock.js';

const run = promisify(execFile);

export interface RappterStatus {
  /** The twin's name, or 'alpha'. */
  name: string;
  isAlpha: boolean;
  port: number;
  /** Answering, and answering as an OpenRappter gateway. */
  running: boolean;
  pid?: number;
  version?: string;
  uptimeSeconds?: number;
  /**
   * Set when the port is held by something that is NOT an OpenRappter gateway.
   * Reporting that as `running` would be a lie, and reporting it as simply not
   * running would hide why a twin cannot start.
   */
  portTakenByOther?: boolean;
  /**
   * This name's recorded port is now held by a different process. The record is
   * history, not an address — the name last ran here and something else has the
   * port now.
   */
  stalePort?: boolean;
  /**
   * A healthy gateway answers here, but nothing could confirm it is this name:
   * the listener does not report its instance (an older build) and the process
   * holding the port could not be identified. The record is not certified —
   * "I could not check" is not "the record is fine". #131
   */
  ownershipUnverified?: boolean;
  /**
   * This name has no endpoint record, so it never successfully owned a port.
   * Its `port` is the one a new twin of that name WOULD try to claim, which is
   * a plan rather than an address — and may already belong to someone else.
   */
  neverStarted?: boolean;
}

/** Every instance name this device has a directory for. */
export function knownInstanceNames(): string[] {
  try {
    return readdirSync(openrappterPath('instances'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** The whole endpoint record a rappter wrote for itself, if any. */
export function recordFor(instance: string | undefined) {
  return readGatewayEndpoint(gatewayEndpointFileFor(instance ? { instance } : {}));
}

/**
 * The port a rappter RECORDED for itself, or undefined when it never did.
 *
 * The record is written only after a successful listen, so its absence is
 * meaningful: that name never got as far as owning a port. `acquireLock`
 * mkdirs `instances/<name>/` before the bind is attempted, so a directory
 * proves nothing — only the record does.
 */
export function recordedPortFor(instance: string | undefined): number | undefined {
  const file = gatewayEndpointFileFor(instance ? { instance } : {});
  return readGatewayEndpoint(file)?.port;
}

/**
 * Where a named rappter can actually be reached, or undefined.
 *
 * A twin with no endpoint record gets **undefined**, never a derived port.
 * Deriving one is a guess, and 900 slots means guesses collide — measured, 4
 * collisions among 52 plausible names, including `twin-0` and `twin-38`.
 *
 * When `thicket` failed to bind because `tender` already held their shared
 * derived port, this function handed back that port anyway. The roster then
 * probed it, found a healthy gateway, and reported:
 *
 *   ● tender    :19212  pid 25383  up 2m
 *   ● thicket   :19212  pid 25383  up 2m      <- thicket was dead
 *
 * and `twin say --to-instance thicket` was answered by `tender`. A name that
 * never started must not be answered for by somebody else. #114
 *
 * The ALPHA keeps its fallback: `ALPHA_GATEWAY_PORT` is a documented constant
 * that every part of this product already agrees on, not a guess that might
 * belong to another rappter.
 */
export function portForInstance(instance: string | undefined): number | undefined {
  const recorded = recordedPortFor(instance);
  if (recorded !== undefined) return recorded;
  return instance ? undefined : ALPHA_GATEWAY_PORT;
}

/**
 * The port a NEW twin of this name would try to claim.
 *
 * Separate from `portForInstance` on purpose: planning where to put a twin is a
 * different question from where an existing one lives, and conflating them is
 * what let a guess be reported as a fact.
 */
export function plannedPortFor(instance: string): number {
  return recordedPortFor(instance) ?? gatewayPortFor({ instance });
}

/** The loopback base URL a named rappter answers on, or undefined. */
export function urlForInstance(instance: string | undefined): string | undefined {
  const port = portForInstance(instance);
  return port === undefined ? undefined : `http://127.0.0.1:${port}`;
}


/**
 * The PID listening on a port.
 *
 * `-sTCP:LISTEN` is not optional. Without it `lsof` also returns every process
 * holding a CLIENT connection to that port — asked about the live gateway on
 * 18790 it returns the daemon AND Microsoft Edge, which merely had the
 * dashboard open. That mistake has already been made once on this machine.
 */
/**
 * Who is listening on this port, and did we manage to find out?
 *
 * `undefined` used to mean both "nothing is listening" and "I could not ask",
 * and the caller treated the second as the first — so where `lsof` is absent
 * the stale-record guard did not stop working, it failed OPEN and certified a
 * record it had not checked. #131
 */
async function listenerPid(port: number): Promise<{ known: boolean; pid?: number }> {
  try {
    const { stdout } = await run('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], { timeout: 5_000 });
    const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return { known: true, pid: Number.isSafeInteger(pid) ? pid : undefined };
  } catch (error) {
    // `lsof` exits non-zero with no output when nothing is listening, which is
    // a real answer. Anything else — not installed, not permitted, timed out —
    // is not an answer at all.
    const failed = error as { code?: number | string; stdout?: string };
    const exitedCleanlyWithNothing = typeof failed?.code === 'number'
      && !((failed.stdout ?? '').trim());
    return exitedCleanlyWithNothing ? { known: true, pid: undefined } : { known: false };
  }
}

interface HealthShape {
  status?: string;
  version?: string;
  /** Which rappter is answering. Absent on builds predating #131. */
  instance?: string;
  metrics?: { uptimeSeconds?: number };
  checks?: { gateway?: boolean };
}

/**
 * Is an OpenRappter gateway answering here?
 *
 * Checks the shape, not merely that something replied. A twin's derived port
 * can be squatted by an unrelated process — that is a real case, it is what
 * makes a twin fail to start — and calling that "running" would send an owner
 * looking for a rappter that does not exist.
 */
async function probe(port: number): Promise<HealthShape | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) return null;
    const body = await response.json() as HealthShape;
    if (body?.status !== 'ok' || body?.checks?.gateway !== true) return null;
    return body;
  } catch {
    return null;
  }
}

/**
 * Every rappter this device knows about, alpha first, each with whether it is
 * actually running right now.
 *
 * Names with no live process are RETURNED, not filtered out. A name that was
 * used and is now gone is precisely what an owner is trying to see, and hiding
 * it would recreate the blindness this exists to remove.
 */
export async function listRappters(options: {
  /**
   * Which instance names to consider. Defaults to every directory this device
   * has. Injectable so a caller — and a test — can ask about a known set
   * without reaching into the module, which keeps the assertion on real
   * behaviour rather than on a mock of it.
   */
  names?: string[];
} = {}): Promise<RappterStatus[]> {
  const instances = options.names ?? knownInstanceNames();
  const names: (string | undefined)[] = [undefined, ...instances];

  return Promise.all(names.map(async (instance): Promise<RappterStatus> => {
    const port = portForInstance(instance);

    // No recorded address means this name never successfully owned a port, so
    // there is nothing legitimate to probe. Probing a DERIVED port here is what
    // made the roster report `thicket` as running with `tender`'s pid, on the
    // port they happen to share. Report what is known — the name exists, it is
    // not running — and never borrow another rappter's liveness. #114
    if (port === undefined) {
      return {
        name: instance ?? 'alpha',
        isAlpha: false,
        port: gatewayPortFor({ instance: instance! }),
        running: false,
        neverStarted: true,
      };
    }

    const [health, listener] = await Promise.all([probe(port), listenerPid(port)]);
    const pid = listener.pid;

    /**
     * A record is an address only while the rappter that wrote it is the one
     * answering. #118
     *
     * `releaseLock` unlinks `gateway.pid` and never `endpoint.json`, so a dead
     * twin's record keeps naming a port somebody else may since have taken.
     * #114 closed the DERIVED route to a phantom twin and left this one open,
     * and every symptom it claimed to end came back — measured:
     *
     *   hatch thicket -> pid 48774; kill it; hatch tender -> pid 49019
     *   twins    ● tender :19212 pid 49019   ● thicket :19212 pid 49019
     *   twin say --to-instance thicket  ->  "tender"
     *   hatch thicket -> "already running (pid 49019)", so it can never
     *                    be hatched again
     *
     * Two independent ways to check, best evidence first. #131
     *
     * 1. The listener says its own name. This proves you reached the rappter
     *    you asked for, needs no external binary, and is the only check that
     *    works where `lsof` does not.
     * 2. The recorded pid matches the pid holding the port. Weaker — it proves
     *    only that the same process wrote the record — and unavailable when
     *    `lsof` cannot answer.
     *
     * If neither can speak, the record is UNVERIFIED. It is not certified,
     * because "I could not check" is not "the record is fine": that collapse
     * reported a stale record as running and handed back a stranger's pid.
     *
     * A record with no pid is from an older build; those are trusted on the
     * pid route, because refusing them would report working twins as dead on
     * upgrade. The name route has no such exemption — a listener that names a
     * different rappter is an impostor whatever the record omits.
     */
    const recordedPid = instance === undefined ? undefined : recordFor(instance)?.pid;
    /**
     * Compare names the roster's own way. #142
     *
     * `expectedName` is canonical — it comes from the instance directory, which
     * `gatewayLockFileFor` derives through `canonicalInstanceKey`. `claimedName`
     * arrives over HTTP from another process, which may be an older build that
     * publishes the raw `--instance` string. Comparing them as typed made a
     * live twin called "review demo twin" an impostor of `review_demo_twin`,
     * and the check written to catch impostors reported it dead.
     *
     * Declaration canonicalises now (infra/current-instance), so a current
     * gateway already agrees. This normalises the wire value as well, because a
     * name that crossed a process boundary is input, not a fact.
     */
    const claimedRaw = typeof health?.instance === 'string' ? health.instance : undefined;
    const claimedName = claimedRaw === undefined ? undefined : canonicalInstanceKey(claimedRaw);
    const expectedName = instance ?? 'alpha';

    const namedImpostor = claimedName !== undefined && claimedName !== expectedName;
    const pidImpostor = recordedPid !== undefined
      && listener.known
      && pid !== undefined
      && recordedPid !== pid;
    const impostor = namedImpostor || pidImpostor;

    // Nothing could vouch for this record: the listener does not say who it is
    // (an older build) and we could not name the process holding the port.
    const unverified = !impostor
      && health !== null
      && claimedName === undefined
      && !listener.known;

    const running = health !== null && !impostor && !unverified;

    return {
      name: instance ?? 'alpha',
      isAlpha: instance === undefined,
      port,
      running,
      // Do not hand back a pid this name has no claim to.
      ...(impostor ? { stalePort: true } : {}),
      // Something healthy answers, but nothing could confirm it is this name.
      ...(unverified ? { ownershipUnverified: true } : {}),
      ...(pid !== undefined && !impostor && !unverified ? { pid } : {}),
      ...(health?.version && !impostor && !unverified ? { version: health.version } : {}),
      ...(typeof health?.metrics?.uptimeSeconds === 'number' && !impostor && !unverified
        ? { uptimeSeconds: health.metrics.uptimeSeconds }
        : {}),
      // Something is holding the port, but it did not answer as a gateway.
      ...(!running && pid !== undefined ? { portTakenByOther: true } : {}),
    };
  }));
}
