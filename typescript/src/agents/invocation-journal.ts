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

/** One tool call, in the shape PARITY §2.3 freezes. */
export interface JournalEntry {
  /** ms since epoch, when the call completed. */
  at: number;
  /** `[<fn_name>] <result>` — success, or `[<fn_name>] ERROR: <e>` on failure. */
  line: string;
}

function journalPath(): string {
  const dir = process.env.OPENRAPPTER_HOME ?? path.join(os.homedir(), '.openrappter');
  return path.join(dir, 'agent-invocations.jsonl');
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
  const line = failed
    ? `[${name}] ERROR: ${truncate(result)}`
    : `[${name}] ${truncate(result)}`;
  try {
    const p = journalPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ at: Date.now(), line } satisfies JournalEntry) + '\n');
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
export function invocationsSince(since: number, limit = 64): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath(), 'utf-8');
  } catch {
    return [];
  }
  const lines = raw.split('\n').filter(Boolean).slice(-limit * 4);
  const out: string[] = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as JournalEntry;
      if (e.at >= since && typeof e.line === 'string') out.push(e.line);
    } catch {
      // A torn final line from a concurrent append. Skip it.
    }
  }
  return out.slice(-limit);
}

/**
 * Keep the journal bounded.
 *
 * Called on daemon start rather than on every write: trimming inside
 * `recordInvocation` would put a read-modify-write on the hot path of every
 * agent call.
 */
export function trimJournal(keep = 500): void {
  try {
    const p = journalPath();
    const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    if (lines.length <= keep) return;
    fs.writeFileSync(p, lines.slice(-keep).join('\n') + '\n');
  } catch {
    // No journal yet, or unreadable. Nothing to trim.
  }
}
