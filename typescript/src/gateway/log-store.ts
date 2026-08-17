/**
 * What "the logs" are for a running gateway.
 *
 * There were three candidates and only one of them is real in production:
 *
 *  - `methods/logs-methods.ts` keeps an in-memory `logBuffer` fed by `pushLog`.
 *    `pushLog` has no callers anywhere in the repo, so that buffer is empty on
 *    every machine, forever. It also registers `logs.tail`, not the `logs.get`
 *    the Bar calls.
 *  - `logging/logger.ts` has a rotating `FileTransport`/`JsonTransport`, but
 *    nothing in the shipped runtime ever installs one — the global `logger` is
 *    console-only, and only two modules use it at all.
 *  - The daemon runs under launchd with its stdout and stderr redirected to
 *    files. That is where `logGatewayLifecycle`, every `console.log` in the
 *    runtime, and every crash actually land, and it survives restarts. That is
 *    the log an operator means when they open the Bar's Logs pane.
 *
 * So this module reads the daemon's launchd log files out of the gateway's own
 * data directory. Both installers are covered, because both exist in the wild:
 *
 *    ~/.openrappter/daemon.log                  (`--daemon` plist, index.ts)
 *    ~/.openrappter/logs/gateway.stdout.log     (GUI LaunchAgent,
 *    ~/.openrappter/logs/gateway.stderr.log      imessage-launchd.ts)
 *    ~/.openrappter/logs/daemon.stdout.log      (delegated system daemon,
 *    ~/.openrappter/logs/daemon.stderr.log       index.ts)
 *
 * Two properties this file exists to guarantee:
 *
 *  1. It never reads a whole log file. These rotate at 5–10 MB; only the tail
 *     is read, and only up to the requested limit is returned.
 *  2. It never emits raw log bytes. Every line is parsed into a structured
 *     entry and passed through the shared redactor (`security/redact.ts`)
 *     first — key-wise for JSON records, text-wise for plain lines. A log file
 *     is the one place a stray credential is most likely to already be
 *     sitting, and RPC hands it to whoever is connected.
 */

import fs from 'fs';
import path from 'path';
import { redactSecrets, redactSecretsInText } from '../security/redact.js';

export type GatewayLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface GatewayLogEntry {
  /** Epoch milliseconds. The Bar divides by 1000 to build a `Date`. */
  timestamp: number;
  level: GatewayLogLevel;
  message: string;
  /** Log file the line came from, relative to the data dir. */
  source: string;
  /**
   * Whether `timestamp` was read off the line itself or inferred from the
   * file's last-write time. Plain launchd output frequently carries no
   * timestamp, and claiming those lines happened "now" would be a lie the
   * caller cannot detect.
   */
  timestampFrom: 'line' | 'file';
}

/** Log files written by the launchd jobs this repo installs, newest-writer last. */
export const GATEWAY_LOG_FILES = [
  'daemon.log',
  path.join('logs', 'daemon.stdout.log'),
  path.join('logs', 'daemon.stderr.log'),
  path.join('logs', 'gateway.stdout.log'),
  path.join('logs', 'gateway.stderr.log'),
] as const;

/** Never read more than this per file, however large it has grown. */
export const LOG_TAIL_BYTES = 256 * 1024;

/** A single line is a message, not a payload. Anything longer is truncated. */
export const MAX_MESSAGE_LENGTH = 2000;

export const DEFAULT_LOG_LIMIT = 100;
export const MAX_LOG_LIMIT = 1000;

const LEVELS: GatewayLogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];

export interface ReadGatewayLogsOptions {
  dataDir: string;
  limit?: number;
  /** Only entries at or after this epoch-ms timestamp. */
  since?: number;
  level?: string;
}

/**
 * Clamp a caller-supplied limit. A missing or nonsensical limit falls back to
 * the default rather than "everything" — the Bar sends 100, and an unbounded
 * read is how a log endpoint becomes a memory incident.
 */
export function resolveLogLimit(limit: unknown): number {
  const parsed = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_LOG_LIMIT;
  const floored = Math.floor(parsed);
  if (floored <= 0) return 0;
  return Math.min(floored, MAX_LOG_LIMIT);
}

/** Read the last `LOG_TAIL_BYTES` of a file without loading the rest of it. */
function readTail(filePath: string): { text: string; truncated: boolean; mtimeMs: number } | null {
  let handle: number | null = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return { text: '', truncated: false, mtimeMs: Math.round(stat.mtimeMs) };
    const buffer = Buffer.alloc(length);
    handle = fs.openSync(filePath, 'r');
    const read = fs.readSync(handle, buffer, 0, length, start);
    return {
      text: buffer.subarray(0, read).toString('utf-8'),
      truncated: start > 0,
      // Rounded: a fractional epoch is not a time anyone can read back.
      mtimeMs: Math.round(stat.mtimeMs),
    };
  } catch {
    // A log file that cannot be read is not an error the caller can act on;
    // the other files still have something to say.
    return null;
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch { /* already gone */ }
    }
  }
}

function normalizeLevel(value: unknown): GatewayLogLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if ((LEVELS as string[]).includes(lowered)) return lowered as GatewayLogLevel;
  if (lowered === 'warning') return 'warn';
  if (lowered === 'err') return 'error';
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds vs milliseconds: anything below this is not a plausible ms epoch.
    return value < 1e11 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

/** `[2026-08-16T12:00:00.000Z] [INFO] [component] message` and looser variants. */
const LEADING_TIMESTAMP = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*/;
/**
 * A bare `Error:` at the start of a stack trace is a message, not a level
 * marker — requiring whitespace after the word keeps `Error: ENOENT …` intact
 * while still recognising `[INFO] …` and `WARN …`.
 */
const LEADING_LEVEL = /^(?:\[(debug|info|warn|warning|error|fatal|err)\]|(debug|info|warn|warning|error|fatal|err)(?=\s))\s*/i;

function truncate(message: string): string {
  if (message.length <= MAX_MESSAGE_LENGTH) return message;
  return `${message.slice(0, MAX_MESSAGE_LENGTH)}… [truncated]`;
}

/**
 * Turn one raw line into a redacted entry, or null if there is nothing in it.
 *
 * JSON lines (what `observability.ts` emits under `OPENRAPPTER_LOG_FORMAT=json`
 * and what `JsonTransport` writes) go through `redactSecrets` so a secret-named
 * field is blanked by key. Every message string then also goes through
 * `redactSecretsInText`, because a credential pasted into a message body has no
 * key left for the object walk to judge.
 */
export function parseLogLine(
  line: string,
  context: { source: string; fileMtimeMs: number; defaultLevel: GatewayLogLevel }
): GatewayLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let timestamp: number | undefined;
  let level: GatewayLogLevel | undefined;
  let message = trimmed;

  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const safe = redactSecrets(parsed) as Record<string, unknown>;
        timestamp = parseTimestamp(safe.timestamp ?? safe.time ?? safe.ts);
        level = normalizeLevel(safe.level);
        const body = typeof safe.message === 'string' ? safe.message.trim() : '';
        const component = typeof safe.component === 'string' ? safe.component : undefined;
        const event = typeof safe.event === 'string' ? safe.event : undefined;
        // `logGatewayRequest` emits an empty message and carries its meaning in
        // component/event, so an empty body is not an empty record.
        message = body || [component, event].filter(Boolean).join(' ') || JSON.stringify(safe);
        if (!body && component && event) {
          const detail = { ...safe };
          delete detail.timestamp;
          delete detail.level;
          delete detail.component;
          delete detail.event;
          delete detail.message;
          const rest = Object.entries(detail).map(([k, v]) => `${k}=${String(v)}`).join(' ');
          if (rest) message = `${message} ${rest}`;
        }
      }
    } catch {
      // Not JSON after all — fall through and treat it as text.
    }
  }

  if (timestamp === undefined && level === undefined && message === trimmed) {
    const timestampMatch = LEADING_TIMESTAMP.exec(message);
    if (timestampMatch) {
      timestamp = parseTimestamp(timestampMatch[1]);
      message = message.slice(timestampMatch[0].length);
    }
    const levelMatch = LEADING_LEVEL.exec(message);
    if (levelMatch) {
      level = normalizeLevel(levelMatch[1] ?? levelMatch[2]);
      message = message.slice(levelMatch[0].length);
    }
  }

  message = truncate(redactSecretsInText(message).trim());
  if (!message) return null;

  return {
    timestamp: timestamp ?? context.fileMtimeMs,
    timestampFrom: timestamp === undefined ? 'file' : 'line',
    level: level ?? context.defaultLevel,
    message,
    source: context.source,
  };
}

/**
 * Read the gateway's real log files, newest entry last, at most `limit`
 * entries. Missing files are not an error: a gateway started by hand has no
 * launchd log, and an empty list is the honest answer for it.
 */
export function readGatewayLogs(options: ReadGatewayLogsOptions): GatewayLogEntry[] {
  const limit = resolveLogLimit(options.limit ?? DEFAULT_LOG_LIMIT);
  if (limit === 0) return [];

  const wantedLevel = normalizeLevel(options.level);
  const entries: GatewayLogEntry[] = [];

  for (const relative of GATEWAY_LOG_FILES) {
    const filePath = path.join(options.dataDir, relative);
    const tail = readTail(filePath);
    if (!tail || !tail.text) continue;

    const lines = tail.text.split('\n');
    // The first line of a tail read is very likely half a line.
    if (tail.truncated) lines.shift();

    const defaultLevel: GatewayLogLevel = relative.endsWith('stderr.log') ? 'error' : 'info';
    for (const line of lines) {
      const entry = parseLogLine(line, {
        source: relative,
        fileMtimeMs: tail.mtimeMs,
        defaultLevel,
      });
      if (entry) entries.push(entry);
    }
  }

  let selected = entries;
  if (wantedLevel) selected = selected.filter((entry) => entry.level === wantedLevel);
  if (typeof options.since === 'number' && Number.isFinite(options.since)) {
    const since = options.since;
    selected = selected.filter((entry) => entry.timestamp >= since);
  }

  // Stable sort keeps each file's append order intact where timestamps tie,
  // which is the only ordering plain launchd output actually carries.
  selected = selected
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => (a.entry.timestamp - b.entry.timestamp) || (a.index - b.index))
    .map(({ entry }) => entry);

  return selected.slice(-limit);
}
