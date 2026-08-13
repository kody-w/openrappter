/**
 * The record of which agents actually ran, so `agent_logs` can be true.
 *
 * PARITY §2.3 defines `agent_logs` as the per-round tool-call lines joined by
 * `"\n"`, and §2.4 freezes it into the envelope. The reason it exists is that a
 * caller has to be able to see that an agent ran — Flight Recorder and rapp-god
 * both read it.
 *
 * ── Why a journal on disk rather than a return value ───────────────────────
 *
 * `Assistant` builds `agent_logs` from the tool calls it dispatches itself. That
 * works for a provider that hands tool calls back to us. It cannot work for the
 * Copilot CLI backend, which is the default on a fresh machine: the CLI runs the
 * tool loop *inside itself* and only returns finished prose, so it always
 * reported `tool_calls: null` and the log came back empty even when an agent had
 * demonstrably run.
 *
 * But those invocations still pass through **our** process — the CLI reaches the
 * agents through the MCP server in `mcp/stdio.ts`, which we own and spawn. So the
 * MCP side appends a line per call here, and the provider reads back the lines
 * written while its own request was in flight.
 *
 * Time-windowed rather than keyed by request id because the CLI spawns the MCP
 * server as its own child and gives us no channel to pass a correlation id
 * through. The window is the honest approximation available; concurrent chat
 * turns on one daemon may interleave, which is noted where it is consumed.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  flightLogResult,
  formatFlightAgentLog,
} from '../providers/flight-io.js';
import {
  assertPrivateDirectory,
  hardenPrivatePath,
  syncParentDirectory,
} from '../flight-recorder/permissions.js';

/** One tool call, in the shape PARITY §2.3 freezes. */
export interface JournalEntry {
  /** ms since epoch, when the call completed. */
  at: number;
  /** Correlates one Copilot CLI request with its inherited MCP process. */
  requestId?: string;
  /** `[<fn_name>] <result>` — success, or `[<fn_name>] ERROR: <e>` on failure. */
  line: string;
}

function requestToken(requestId: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(requestId)
    ? requestId
    : createHash('sha256').update(requestId).digest('hex');
}

function journalPath(requestId?: string): string {
  const dir = process.env.OPENRAPPTER_HOME ?? path.join(os.homedir(), '.openrappter');
  return path.join(
    dir,
    requestId
      ? `agent-invocations.${requestToken(requestId)}.jsonl`
      : 'agent-invocations.jsonl',
  );
}

function prepareJournalDirectory(directory: string): void {
  let existing = directory;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  assertPrivateDirectory(existing);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const created = fs.lstatSync(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("Invocation journal directory is not private.");
    }
    hardenPrivatePath(directory, true);
  }
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error("Invocation journal directory is not private.");
  }
  assertPrivateDirectory(directory);
}

function appendPrivateJournal(file: string, content: string): void {
  try {
    const existing = fs.lstatSync(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Invocation journal must be a regular file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const descriptor = fs.openSync(
    file,
    fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const linked = fs.lstatSync(file);
    if (
      !opened.isFile() ||
      linked.isSymbolicLink() ||
      !linked.isFile() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new Error("Invocation journal identity changed.");
    }
    hardenPrivatePath(file);
    fs.writeFileSync(descriptor, content, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function readPrivateJournal(file: string): string {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const linked = fs.lstatSync(file);
    if (
      !opened.isFile() ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    ) {
      throw new Error("Invocation journal identity changed.");
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function retireLegacyJournal(): void {
  const file = journalPath();
  let status: ReturnType<typeof fs.lstatSync>;
  try {
    status = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (status.isSymbolicLink()) {
    fs.unlinkSync(file);
    return;
  }
  if (!status.isFile()) {
    throw new Error("Legacy invocation journal is not a regular file.");
  }
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const zeroes = Buffer.alloc(64 * 1024);
    let remaining = status.size;
    while (remaining > 0) {
      const size = Math.min(remaining, zeroes.length);
      fs.writeSync(descriptor, zeroes, 0, size);
      remaining -= size;
    }
    fs.ftruncateSync(descriptor, 0);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.unlinkSync(file);
  syncParentDirectory(path.dirname(file));
}

/** Truncate a result the way the Assistant loop does, so both paths agree. */
function truncate(s: string, max = 200): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Record one invocation. Never throws: a journal write failing must not take
 * down an agent call that otherwise succeeded.
 */
export function recordInvocation(name: string, result: string, failed = false): void {
  const requestId = process.env.OPENRAPPTER_INVOCATION_REQUEST_ID;
  if (!requestId) return;
  const line = formatFlightAgentLog(
    name,
    truncate(flightLogResult(result)),
    failed,
  );
  try {
    const p = journalPath(requestId);
    const directory = path.dirname(p);
    prepareJournalDirectory(directory);
    appendPrivateJournal(p, JSON.stringify({
      at: Date.now(),
      requestId,
      line,
    } satisfies JournalEntry) + '\n');
  } catch {
    // Best effort by design.
  }
}

/**
 * The lines written at or after `since`.
 *
 * Reads the tail only. The journal is append-only and a chat turn is seconds
 * long, so scanning the whole file would grow unboundedly slower for no gain.
 */
export function invocationsSince(
  since: number,
  requestId?: string,
  limit = 64,
): string[] {
  let raw: string;
  const p = journalPath(requestId);
  try {
    raw = readPrivateJournal(p);
  } catch {
    return [];
  } finally {
    if (requestId) {
      try {
        fs.unlinkSync(p);
      } catch {
        // Another reader or cleanup pass may have consumed it.
      }
    }
  }
  const allLines = raw.split('\n').filter(Boolean);
  const lines = requestId
    ? allLines
    : allLines.slice(-limit * 4);
  const out: string[] = [];
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const l = lines[index];
    try {
      const e = JSON.parse(l) as JournalEntry;
      if (
        typeof e.line === 'string' &&
        (
          requestId === undefined
            ? e.at >= since
            : e.requestId === requestId
        )
      ) {
        out.push(e.line);
        if (out.length >= limit) break;
      }
    } catch {
      // A torn final line from a concurrent append. Skip it.
    }
  }
  return out.reverse();
}

/**
 * Keep the journal bounded.
 *
 * Called on daemon start rather than on every write: trimming inside
 * `recordInvocation` would put a read-modify-write on the hot path of every
 * agent call.
 */
export function trimJournal(_keep = 500): void {
  const dir = process.env.OPENRAPPTER_HOME ?? path.join(os.homedir(), '.openrappter');
  try {
    prepareJournalDirectory(dir);
  } catch {
    return;
  }
  try {
    retireLegacyJournal();
  } catch {
    // Legacy retirement is best effort.
  }
  try {
    const staleBefore = Date.now() - 24 * 60 * 60 * 1_000;
    const requestFiles = fs.readdirSync(dir)
      .filter((name) =>
        /^agent-invocations\.[A-Za-z0-9_-]+\.jsonl$/.test(name),
      )
      .map((name) => path.join(dir, name));
    for (const requestFile of requestFiles) {
      const status = fs.lstatSync(requestFile);
      if (status.isSymbolicLink()) {
        fs.unlinkSync(requestFile);
      } else if (
        status.isFile() &&
        status.mtimeMs < staleBefore
      ) {
        fs.unlinkSync(requestFile);
      }
    }
  } catch {
    // Stale request cleanup is best effort.
  }
}
