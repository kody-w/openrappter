/**
 * Waiting for the gateway child to report itself ready.
 *
 * This lived inside `ensureGateway` in `main.ts`, which imports `electron` and
 * therefore cannot be loaded by a plain `node --test` process. That is why the
 * desktop suite asserts `main.ts` as *text*: the readiness handshake — the one
 * piece of desktop startup that decides whether the app launches at all — had
 * no executable coverage.
 *
 * Nothing here needs Electron. It needs a child that emits `message`, `exit`
 * and `error`, which a test can supply.
 */

export const GATEWAY_READY_SCHEMA = 'openrappter-gateway-ready/1.0';

/**
 * How long the gateway may take to say it is ready before we give up on it.
 *
 * Worth knowing before changing it: `onExit` already rejects immediately when
 * the gateway genuinely fails to start, so this timer only ever fires while the
 * process is alive and simply slow — a cold start, a first run resolving
 * modules, an antivirus scan — which is the case where killing it is least
 * likely to be the right answer.
 *
 * Left at the original 30s. A Windows CI run has failed on it once and passed
 * on re-run, which is not enough to justify picking a different number; the
 * question is open in issue #223. Callers can override it, and now that this
 * handshake is testable a future change can be made against evidence rather
 * than guessed at.
 */
export const GATEWAY_READY_TIMEOUT_MS = 30_000;

/**
 * The environment variable an operator can use to widen that budget.
 *
 * The 30s default stays where it is, because a single Windows CI flake is not
 * evidence for a different universal number and #223 leaves that question open.
 * But the person who actually hits it — a cold first run, an antivirus scan, a
 * loaded machine — could not do anything about it: `waitForGatewayReady` has
 * always accepted a `timeoutMs`, and no caller passed one and nothing read an
 * environment variable, so the documented escape hatch could only be reached by
 * editing source.
 *
 * This does not decide what the budget should be. It lets someone who knows
 * their machine raise it without waiting for that decision.
 */
export const GATEWAY_READY_TIMEOUT_ENV = 'OPENRAPPTER_GATEWAY_READY_TIMEOUT_MS';

/** Upper bound, so a typo cannot hang desktop startup indefinitely. */
const MAX_GATEWAY_READY_TIMEOUT_MS = 10 * 60_000;

/**
 * Resolve the readiness budget from the environment, falling back to the
 * default for anything that is not a plain positive integer within bounds.
 *
 * A bad value is ignored rather than fatal: refusing to launch the app because
 * someone exported a malformed number would be a worse failure than the one
 * this setting exists to relieve.
 */
export function resolveGatewayReadyTimeout(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[GATEWAY_READY_TIMEOUT_ENV];
  if (raw === undefined) return GATEWAY_READY_TIMEOUT_MS;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return GATEWAY_READY_TIMEOUT_MS;

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return GATEWAY_READY_TIMEOUT_MS;
  if (parsed > MAX_GATEWAY_READY_TIMEOUT_MS) return MAX_GATEWAY_READY_TIMEOUT_MS;
  return parsed;
}

/** The part of a child process this handshake uses. */
export interface ReadyChildProcess {
  readonly pid?: number;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface WaitForGatewayReadyOptions {
  /** The port the desktop app asked the gateway to listen on. */
  port: number;
  timeoutMs?: number;
}

/**
 * Resolve when the child reports it is ready, reject on exit, error or timeout.
 *
 * The readiness message is accepted only when the schema, pid and port all
 * match: the desktop app owns this child, and a message that does not describe
 * it is not evidence that *our* gateway is up.
 */
export function waitForGatewayReady(
  child: ReadyChildProcess,
  options: WaitForGatewayReadyOptions,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? resolveGatewayReadyTimeout();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve();
    };

    const onMessage = (message: unknown) => {
      const ready = message as {
        schema?: unknown;
        pid?: unknown;
        port?: unknown;
      };
      if (
        ready?.schema === GATEWAY_READY_SCHEMA &&
        ready.pid === child.pid &&
        ready.port === options.port
      ) {
        finish();
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(
        new Error(
          `OpenRappter gateway exited during desktop startup (${code ?? signal ?? 'unknown'}).`,
        ),
      );
    };

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(
        new Error(
          `OpenRappter gateway did not become ready in ${Math.round(timeoutMs / 1000)} seconds.`,
        ),
      );
    }, timeoutMs);

    child.on('error', (error: Error) => finish(error));
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}
