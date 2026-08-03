/**
 * A presence beacon on a port the burrowed detector actually probes.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * `burrow.js` answers one question — *is there a brainstem running on this
 * device right now?* — by probing a small fixed set of loopback ports:
 *
 *     const DEFAULT_PORTS = [7071, 7081, 7082, 7083];   // burrow.js:53
 *
 * openrappter listens on 18790. So a user with openrappter running, visiting the
 * hosted chat, is told `unburrowed`. That is precisely the lie the detector
 * exists to prevent: *"it would tell someone with a live brainstem that they
 * have none."*
 *
 * ── The choice, and why ────────────────────────────────────────────────────
 *
 * Three ways to close it:
 *
 *   1. Add 18790 to `DEFAULT_PORTS`. Correct in the long run, but it lives in
 *      the `chat` repo — a different repo, and this round's job is to make
 *      *openrappter* conformant without reaching into anyone else's code.
 *   2. Move the gateway to a probed port. Rejected: 18790 is baked into the
 *      LaunchAgent, the menu-bar app, the deep links and every doc, and moving
 *      it would break working installs to satisfy a detector.
 *   3. Answer on a probed port *as well*. Chosen.
 *
 * The beacon takes the first **free** port in the probe range and never
 * displaces anything already listening — 7071 is the grail parent and 7081+ are
 * its booted twins, so squatting one would break a real brainstem to advertise
 * ourselves. If every probed port is taken, that means something else already
 * answers there and the detector already says `burrowed`; the honest thing is to
 * stay quiet rather than fight for the port.
 *
 * ── What it is not ─────────────────────────────────────────────────────────
 *
 * It is presence, not a door. It serves `/health` and nothing else, binds
 * loopback only, holds no secret, proxies nothing, and refuses cross-origin
 * reads exactly like the main gateway. The detector uses an opaque `no-cors`
 * fetch, so a 403 resolves and answers the question without ever becoming a data
 * path — which is the whole design: *"A 403 is an answer."*
 */

import http from 'http';
import type { AddressInfo } from 'net';

/** The ports `burrow.js` probes. Kept in this order deliberately: 7071 first. */
export const BURROW_PROBE_PORTS = [7071, 7081, 7082, 7083] as const;

export interface BeaconHandle {
  port: number;
  close: () => Promise<void>;
}

/** True when the request came from somewhere that is not this machine. */
function isCrossOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  return !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => { server.removeListener('error', onError); resolve(false); };
    server.once('error', onError);
    // Loopback only. The beacon must never be reachable from the network — it
    // exists to be seen by a page running on this machine, nothing else.
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(true);
    });
  });
}

/**
 * Start the beacon on the first free probed port.
 *
 * Returns null when every probed port is occupied, which is not a failure: if
 * something else is listening there, the detector already resolves and already
 * reports a brainstem on this device.
 */
export async function startBurrowBeacon(
  ports: readonly number[] = BURROW_PROBE_PORTS,
  info: { name: string; designation?: string; gatewayPort: number } = {
    name: 'openrappter', gatewayPort: 18790,
  },
): Promise<BeaconHandle | null> {
  for (const port of ports) {
    const server = http.createServer((req, res) => {
      if (isCrossOrigin(req)) {
        // Answer, but refuse the read. An opaque probe resolves on this, which
        // is exactly what makes presence detectable without leaking anything.
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cross-origin reads are refused' }));
        return;
      }
      if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          organism: info.name,
          ...(info.designation ? { designation: info.designation } : {}),
          // Where the real thing lives. The beacon is a signpost, not the door.
          gateway: `http://127.0.0.1:${info.gatewayPort}/`,
        }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    if (await tryListen(server, port)) {
      const bound = (server.address() as AddressInfo).port;
      return {
        port: bound,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }
    server.close();
  }
  return null;
}
