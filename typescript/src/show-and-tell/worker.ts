import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readActiveContext, showCaptureNotification } from './capture.js';
import { ShowAndTellStore } from './store.js';
import type { ActiveContext } from './types.js';

const REMINDER_INTERVAL_MS = 10 * 60 * 1000;

function sameContext(left: ActiveContext | null, right: ActiveContext): boolean {
  return Boolean(
    left &&
      left.app === right.app &&
      left.window === right.window &&
      left.url === right.url &&
      left.privateContext === right.privateContext,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryCollectorWrite(
  operation: () => Promise<unknown>,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(50 * (attempt + 1));
    }
  }
  throw lastError;
}

async function waitForNextPoll(
  store: ShowAndTellStore,
  sessionId: string,
  nonce: string,
  waitMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
    const session = await store.getSession(sessionId);
    if (
      !session ||
      session.collectorNonce !== nonce ||
      session.state !== 'recording'
    ) {
      return false;
    }
  }
  return true;
}

export async function runShowAndTellCollector(
  root: string,
  sessionId: string,
  nonce: string,
  ownerPid?: number,
): Promise<void> {
  const store = new ShowAndTellStore(root);
  await store.initialize();
  let failed: string | undefined;
  let attached = false;
  let stopping = false;
  const requestStop = () => {
    stopping = true;
  };
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);

  try {
    attached = await store.attachCollector(
      sessionId,
      'typescript',
      process.pid,
      nonce,
    );
    if (!attached) return;
    await store.appendEvent(sessionId, 'collector.started', 'typescript-collector', {
      runtime: 'typescript',
      pid: process.pid,
    });
    await showCaptureNotification(
      'Recording app and window changes. Screenshots are captured only when you explicitly request one.',
    );

    let previous: ActiveContext | null = null;
    let lastReminder = Date.now();
    let lastHeartbeatEvent = 0;
    let consecutiveFailures = 0;
    while (!stopping) {
      if (
        ownerPid &&
        ownerPid !== process.pid &&
        !processIsAlive(ownerPid)
      ) {
        await store.requestStop(sessionId);
        break;
      }
      const session = await store.getSession(sessionId);
      if (!session || session.collectorNonce !== nonce) break;
      if (session.state !== 'recording') break;
      if (Date.now() - session.startedAt >= session.maxDurationMs) {
        await store.requestStop(sessionId);
        break;
      }

      try {
        const context = await readActiveContext();
        if (!context.app && !context.window && !context.url) {
          throw new Error('Context adapter returned no active application or window.');
        }
        consecutiveFailures = 0;
        if (!sameContext(previous, context)) {
          await store.appendEvent(
            sessionId,
            'app.activate',
            'context-collector',
            {
              app: context.app,
              window: context.window,
              privateContext: context.privateContext === true,
            },
          );
          if (context.url && context.url !== previous?.url) {
            await store.appendEvent(
              sessionId,
              'browser.url',
              'context-collector',
              { app: context.app, url: context.url },
            );
          }
          previous = context;
        }
      } catch (error) {
        consecutiveFailures += 1;
        await store.appendEvent(
          sessionId,
          'collector.error',
          'context-collector',
          { error: error instanceof Error ? error.message : String(error) },
        );
        if (consecutiveFailures >= 3) {
          throw new Error('Context collector failed three consecutive samples.');
        }
      }

      const now = Date.now();
      if (!(await store.heartbeat(sessionId, nonce))) break;
      if (now - lastHeartbeatEvent >= 60_000) {
        await store.appendEvent(
          sessionId,
          'collector.heartbeat',
          'typescript-collector',
          {},
        );
        lastHeartbeatEvent = now;
      }
      if (now - lastReminder >= REMINDER_INTERVAL_MS) {
        await showCaptureNotification(
          'Show-and-Tell is still recording app and window changes.',
        );
        lastReminder = now;
      }
      if (
        !(await waitForNextPoll(
          store,
          sessionId,
          nonce,
          session.pollIntervalMs,
        ))
      ) {
        break;
      }
    }
  } catch (error) {
    failed = error instanceof Error ? error.message : String(error);
    try {
      await store.appendEvent(
        sessionId,
        'collector.error',
        'typescript-collector',
        { error: failed },
      );
    } catch {
      // Preserve the original worker failure.
    }
  } finally {
    if (attached) {
      let finalizationError: unknown;
      try {
        try {
          await retryCollectorWrite(() => store.appendEvent(
            sessionId,
            'collector.stopped',
            'typescript-collector',
            { failed: Boolean(failed) },
          ));
        } catch {
          // Session finalization is authoritative even if telemetry is contended.
        }
        try {
          await retryCollectorWrite(() => store.finishSession(
            sessionId,
            failed ? 'failed' : 'stopped',
            { nonce, error: failed },
          ));
        } catch (error) {
          finalizationError = error;
        }
        try {
          await showCaptureNotification(
            failed
              ? 'Recording stopped because the collector failed.'
              : 'Recording stopped. It is ready to analyze.',
          );
        } catch {
          // Notifications cannot prevent durable session finalization.
        }
      } finally {
        store.close();
      }
      if (finalizationError) throw finalizationError;
    } else {
      store.close();
    }
  }
  if (failed && !attached) throw new Error(failed);
}

export interface SpawnedCollector {
  pid: number;
  nonce: string;
  verify?: boolean;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function spawnShowAndTellCollector(
  root: string,
  sessionId: string,
  ownerPid?: number,
): Promise<SpawnedCollector> {
  const nonce = randomUUID();
  const compiled = fileURLToPath(new URL('./worker.js', import.meta.url));
  const source = fileURLToPath(new URL('./worker.ts', import.meta.url));
  let executable: string;
  let args: string[];
  if (existsSync(compiled)) {
    executable = process.env.OPENRAPPTER_NODE_BIN ?? process.execPath;
    args = [
      compiled,
      root,
      sessionId,
      nonce,
      ...(ownerPid ? [String(ownerPid)] : []),
    ];
  } else {
    executable = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    args = [
      'tsx',
      source,
      root,
      sessionId,
      nonce,
      ...(ownerPid ? [String(ownerPid)] : []),
    ];
  }

  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(process.versions.electron && executable === process.execPath
        ? { ELECTRON_RUN_AS_NODE: '1' }
        : {}),
      OPENRAPPTER_SHOW_AND_TELL_DIR: root,
    },
  });
  return new Promise<SpawnedCollector>((resolve, reject) => {
    let settled = false;
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`Show-and-Tell collector could not start: ${error.message}`));
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      if (!child.pid) {
        reject(new Error(
          'Show-and-Tell collector started without a process id.',
        ));
        return;
      }
      resolve({ pid: child.pid, nonce, verify: true });
    });
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) {
  const [root, sessionId, nonce, ownerPidText] = process.argv.slice(2);
  if (!root || !sessionId || !nonce) {
    process.stderr.write('Show-and-Tell collector requires root, session id, and nonce.\n');
    process.exitCode = 2;
  } else {
    const ownerPid = ownerPidText ? Number.parseInt(ownerPidText, 10) : undefined;
    runShowAndTellCollector(root, sessionId, nonce, ownerPid).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
