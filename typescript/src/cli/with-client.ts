/**
 * One connection helper for every RPC-backed CLI command.
 *
 * Six files -- `approvals`, `backup`, `channels`, `cron`, `send`, `sessions` --
 * each carried a byte-identical private copy of this function (verified: same
 * md5). They also each carried the same defect, because there was no single
 * place to fix it: the body had `try`/`finally` but no `catch`.
 *
 * Commander does not await an async `.action()` handler, so a rejection
 * escaping that handler becomes an unhandled promise rejection, and Node
 * prints it as a raw stack dump full of internal paths:
 *
 *     $ openrappter approvals list
 *     file:///.../dist/cli/rpc-client.js:33
 *                 p.reject(new Error(frame.error?.message ?? 'RPC error'));
 *                          ^
 *     Error: Method 'exec.pending' not found
 *         at WebSocket.<anonymous> (file:///.../rpc-client.js:33:42)
 *         at Receiver.receiverOnMessage (/.../ws/lib/websocket.js:1239:20)
 *         ... 6 more frames
 *
 * Every reachable failure here is ordinary and expected -- the gateway is not
 * running, the token is wrong, the daemon is older than the CLI -- and none of
 * them are the user's bug to debug. They get one line and a non-zero exit.
 */
import { RpcClient } from './rpc-client.js';

/** The port the gateway listens on for CLI clients. */
export const GATEWAY_PORT = 18790;

/** Turn a thrown value into one actionable line. Exported for tests. */
export function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // ECONNREFUSED is by far the most common failure, and "connect ECONNREFUSED
  // 127.0.0.1:18790" does not tell anyone what to do about it.
  if (/ECONNREFUSED|not connected|socket hang up/i.test(message)) {
    return `Cannot reach the openrappter gateway on port ${GATEWAY_PORT}.\n  Start it with: openrappter gateway`;
  }
  if (/unauthor|forbidden|token/i.test(message)) {
    return `The gateway rejected this request as unauthorised.\n  Set OPENRAPPTER_TOKEN, or check: openrappter config show`;
  }
  if (/not found/i.test(message)) {
    // Usually a version skew: an older daemon is still running.
    return `${message}\n  The running gateway may be older than this CLI. Check: openrappter service status`;
  }
  return message;
}

/**
 * Connect, run `fn`, and always disconnect.
 *
 * On failure prints one line and sets a non-zero exit code, matching how
 * `cli/config.ts` reports errors. Returns `undefined` when the call failed, so
 * callers must not assume a value came back.
 */
export async function withClient<T>(
  fn: (client: RpcClient) => Promise<T>,
): Promise<T | undefined> {
  const client = new RpcClient();
  try {
    await client.connect(GATEWAY_PORT, process.env.OPENRAPPTER_TOKEN);
    return await fn(client);
  } catch (error) {
    console.error(`\n  ${explain(error)}\n`);
    process.exitCode = 1;
    return undefined;
  } finally {
    client.disconnect();
  }
}
