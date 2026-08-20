/**
 * Port allocation for tests that bind real sockets.
 *
 * The original approach guessed: `34000 + Math.floor(Math.random() * 10000)`,
 * with no check that anything was listening there. That is a birthday problem
 * wearing a disguise, and it failed exactly as the arithmetic predicts.
 *
 * Asking the kernel is better, but it is not a fix. This helper binds port 0,
 * reads the port the OS chose, then *closes* the probe so the caller can bind
 * it. Between that close and the caller's bind the port belongs to nobody, and
 * anything on the machine may take it.
 *
 * A previous version of this comment claimed that window was safe in practice,
 * because "ephemeral ports are handed out cyclically, so an immediate reuse
 * does not happen", and because we never return the same port twice. Both
 * claims are about a single process. Vitest runs test files in separate worker
 * processes, so the `issued` set below is not shared, and on 2026-08-19 two
 * workers were handed the same port:
 *
 *     gateway-observability.test.ts: Gateway server started on 127.0.0.1:36297
 *     gateway.test.ts > should respond to GET /health
 *       Gateway server error: listen EADDRINUSE: address already in use 127.0.0.1:36297
 *
 * So treat this helper as a last resort. If the thing you are starting can
 * report the port it bound, pass it port 0 and ask it afterwards -- there is
 * no window at all in that arrangement, because the socket is never closed.
 * `GatewayServer` does this via its `port` getter, and every test that binds a
 * real socket now works that way.
 *
 * An earlier version of this note predicted the remaining callers would be
 * servers lacking such an accessor. That turned out to be wrong. Converting
 * them found something else: the two callers left do not start a server at
 * all. They need a port *number* for something that will deliberately never be
 * bound --
 *
 *   - `conformance.test.ts` hands `startBurrowBeacon` a list of candidate
 *     ports and checks which one it picks, so the candidates must be real
 *     numbers, and one of them must be free.
 *   - `skills-connections-contract.test.ts` needs an address nothing answers
 *     on, to prove that pairing with an unreachable peer reports failure.
 *
 * Port 0 cannot express either of those. Both still carry the window described
 * above, and that is not fixable here: you cannot hold a port to guarantee it
 * stays free, because holding it is exactly what makes it not free. The
 * exposure is much smaller than it was -- two ports instead of the seventy-six
 * that collided in CI -- but it is not zero, so if one of these ever flakes,
 * this comment is the explanation.
 */
import net from 'net';

const issued = new Set<number>();

/**
 * Ask the OS for a free TCP port on the loopback interface.
 *
 * Do not use this to pick a port for a server you are about to start: pass it
 * port 0 and read the port back instead. This is for the narrow case where you
 * need a port number that stays unbound -- see the note at the top of the file.
 */
export async function reserveTestPort(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await askKernelForAPort();
    if (issued.has(port)) continue;
    issued.add(port);
    return port;
  }
  throw new Error('reserveTestPort: the OS kept returning ports already issued in this process');
}

function askKernelForAPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen({ port: 0, host: '127.0.0.1' }, () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('reserveTestPort: server reported no numeric address')));
        return;
      }
      const { port } = address;
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Test seam: forget the issued set so uniqueness can be asserted in isolation. */
export function __resetIssuedPortsForTest(): void {
  issued.clear();
}
