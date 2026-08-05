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
import { homedir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ALPHA_GATEWAY_PORT,
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
}

/** Every instance name this device has a directory for. */
export function knownInstanceNames(): string[] {
  try {
    return readdirSync(join(homedir(), '.openrappter', 'instances'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Where a rappter said it landed, falling back to what its name implies. */
export function portForInstance(instance: string | undefined): number {
  const file = gatewayEndpointFileFor(instance ? { instance } : {});
  const recorded = readGatewayEndpoint(file);
  if (recorded) return recorded.port;
  // No record: the name is all there is. Correct for a twin on its derived
  // port, and knowingly wrong for one started with an explicit --port, which
  // is exactly why the record exists.
  return instance ? gatewayPortFor({ instance }) : ALPHA_GATEWAY_PORT;
}

/** The loopback base URL a named rappter on this device answers on. */
export function urlForInstance(instance: string | undefined): string {
  return `http://127.0.0.1:${portForInstance(instance)}`;
}

const portFor = portForInstance;

/**
 * The PID listening on a port.
 *
 * `-sTCP:LISTEN` is not optional. Without it `lsof` also returns every process
 * holding a CLIENT connection to that port — asked about the live gateway on
 * 18790 it returns the daemon AND Microsoft Edge, which merely had the
 * dashboard open. That mistake has already been made once on this machine.
 */
async function listenerPid(port: number): Promise<number | undefined> {
  try {
    const { stdout } = await run('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], { timeout: 5_000 });
    const pid = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10);
    return Number.isSafeInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  }
}

interface HealthShape {
  status?: string;
  version?: string;
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
    const port = portFor(instance);
    const [health, pid] = await Promise.all([probe(port), listenerPid(port)]);
    const running = health !== null;

    return {
      name: instance ?? 'alpha',
      isAlpha: instance === undefined,
      port,
      running,
      ...(pid !== undefined ? { pid } : {}),
      ...(health?.version ? { version: health.version } : {}),
      ...(typeof health?.metrics?.uptimeSeconds === 'number'
        ? { uptimeSeconds: health.metrics.uptimeSeconds }
        : {}),
      // Something is holding the port, but it did not answer as a gateway.
      ...(!running && pid !== undefined ? { portTakenByOther: true } : {}),
    };
  }));
}
