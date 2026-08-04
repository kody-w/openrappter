/**
 * Port allocation for tests that bind real sockets.
 *
 * The previous approach guessed: `34000 + Math.floor(Math.random() * 10000)`,
 * with no check that anything was listening there. That is a birthday problem
 * wearing a disguise — ~74 draws across three files, run in parallel vitest
 * workers, on a CI runner that has its own listeners. It failed exactly as the
 * arithmetic predicts:
 *
 *     × increments the auth_failure counter exactly once ...
 *       → listen EADDRINUSE: address already in use 127.0.0.1:35212
 *
 * Instead of guessing, ask the kernel. Binding port 0 makes the OS assign a
 * free ephemeral port, which it will not hand to another concurrent listener.
 * We then close our probe so the caller can bind it.
 *
 * Two windows remain, and both are narrow by construction:
 *
 *  - Between our close and the caller's bind, the OS could theoretically
 *    reassign the port. In practice ephemeral ports are handed out cyclically,
 *    so an immediate reuse does not happen.
 *  - A different process could guess our port. Nothing in this repo guesses
 *    any more, which is the point of routing every caller through here.
 *
 * We additionally never return the same port twice within a process, so a test
 * file cannot collide with itself no matter what the kernel recycles.
 */
import net from 'net';

const issued = new Set<number>();

/** Ask the OS for a free TCP port on the loopback interface. */
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
