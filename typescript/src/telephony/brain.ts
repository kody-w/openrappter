/**
 * Client for the RAPP Second Brain (`rsb`).
 *
 * https://github.com/kody-w/rapp-secondbrain
 *
 * The brain is a separate, dependency-free binary rather than a library on
 * purpose: the phone agent, the Telegram channel, the CLI and any other harness
 * all write to the same hash-chained log, so "it said it would call them back"
 * is a fact on disk rather than something in one process's memory.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface BrainOptions {
  /** Path to the rsb executable. Defaults to a PATH lookup then known install locations. */
  binary?: string;
  /** Brain directory. Defaults to $RAPP_SECOND_BRAIN_HOME or ~/.rapp-second-brain. */
  home?: string;
  /** Written into every event so you can see which surface produced it. */
  actor?: string;
  timeoutMs?: number;
}

export interface BrainResult<T = Record<string, unknown>> {
  ok: boolean;
  error?: string;
  data: T;
}

const CANDIDATES = [
  join(homedir(), '.local', 'bin', 'rsb'),
  join(homedir(), '.rapp-second-brain', 'bin', 'rsb'),
  join(homedir(), 'rapp-secondbrain', 'rsb'),
  '/usr/local/bin/rsb',
  '/opt/homebrew/bin/rsb',
];

export function locateBrainBinary(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.RSB_BIN) return process.env.RSB_BIN;
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return 'rsb'; // fall back to PATH
}

export class SecondBrain {
  private readonly binary: string;
  private readonly home?: string;
  private readonly actor: string;
  private readonly timeoutMs: number;

  /**
   * Appends are read-then-write: each one reads the last hash to chain onto it.
   * Two overlapping writers would therefore both chain onto the same event and
   * corrupt the log. Every call is queued through here so that cannot happen,
   * no matter how many callers a live phone call has.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BrainOptions = {}) {
    this.binary = locateBrainBinary(options.binary);
    this.home = options.home ?? process.env.RAPP_SECOND_BRAIN_HOME;
    this.actor = options.actor ?? 'openrappter';
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    // Keep the chain alive even when a task rejects.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Run an rsb command. Never throws for an ordinary non-zero exit — several
   * commands use the exit code as their answer (`approval check` in particular),
   * so callers need both the code and the payload.
   */
  async exec<T = Record<string, unknown>>(...args: string[]): Promise<BrainResult<T> & { code: number }> {
    return this.serialize(async () => {
      const first = await this.execNow<T>(...args);

      // An uninitialised brain would otherwise swallow everything silently:
      // the call happens, nothing is recorded, and no one finds out until they
      // go looking for the transcript. `init` is idempotent, so create and retry.
      if (!first.ok && /run `?rsb init/.test(first.error ?? '') && args[0] !== 'init') {
        const created = await this.execNow('init');
        if (created.ok) return this.execNow<T>(...args);
      }

      return first;
    });
  }

  private async execNow<T>(...args: string[]): Promise<BrainResult<T> & { code: number }> {
    const argv = ['--json', '--actor', this.actor, ...(this.home ? ['--home', this.home] : []), ...args];

    try {
      const { stdout } = await run(this.binary, argv, { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      return { ...this.parse<T>(stdout), code: 0 };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };

      if (err.code === 'ENOENT') {
        return {
          ok: false,
          code: 127,
          error: `rsb not found (looked for ${this.binary}). Install: curl -fsSL https://raw.githubusercontent.com/kody-w/rapp-secondbrain/main/install.sh | bash`,
          data: {} as T,
        };
      }

      const exitCode = typeof err.code === 'number' ? err.code : 1;
      const parsed = this.parse<T>(err.stdout ?? '');
      return {
        ok: false,
        code: exitCode,
        error: parsed.error ?? ((err.stderr || '').trim() || `rsb exited ${exitCode}`),
        data: parsed.data,
      };
    }
  }

  private parse<T>(stdout: string): BrainResult<T> {
    const text = (stdout ?? '').trim();
    if (!text) return { ok: true, data: {} as T };
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return { ok: parsed.ok !== false, error: parsed.error as string | undefined, data: parsed as T };
    } catch {
      return { ok: false, error: `unparseable rsb output: ${text.slice(0, 200)}`, data: {} as T };
    }
  }

  async isAvailable(): Promise<boolean> {
    const result = await this.exec('doctor');
    return result.code === 0 || result.code === 1; // 1 = reachable but unhealthy
  }

  // -- reads --------------------------------------------------------------

  async brief(): Promise<Record<string, unknown>> {
    return (await this.exec('brief')).data;
  }

  /** The `<second_brain>` block for injection into a system prompt. */
  async context(): Promise<string> {
    const result = await this.exec<{ context?: string }>('context');
    return result.data.context ?? '';
  }

  async findContact(query: string): Promise<Record<string, unknown> | null> {
    const result = await this.exec<{ contact?: Record<string, unknown> }>('contact', 'find', query);
    return result.code === 0 ? (result.data.contact ?? null) : null;
  }

  async recall(query: string): Promise<Record<string, unknown>[]> {
    const result = await this.exec<{ hits?: Record<string, unknown>[] }>('recall', query);
    return result.data.hits ?? [];
  }

  // -- writes -------------------------------------------------------------

  async remember(text: string, tags: string[] = []): Promise<void> {
    await this.exec('remember', text, ...tags.flatMap((tag) => ['--tag', tag]));
  }

  async addContact(contact: { name: string; phone?: string; email?: string; org?: string }): Promise<string | null> {
    const args = ['contact', 'add', '--name', contact.name];
    if (contact.phone) args.push('--phone', contact.phone);
    if (contact.email) args.push('--email', contact.email);
    if (contact.org) args.push('--org', contact.org);
    const result = await this.exec<{ contact?: { id?: string } }>(...args);
    return result.data.contact?.id ?? null;
  }

  async startCall(input: {
    to: string;
    direction?: 'inbound' | 'outbound';
    objective?: string;
    constraints?: string[];
    provider?: string;
  }): Promise<string | null> {
    const args = ['call', 'start', '--to', input.to, '--direction', input.direction ?? 'outbound'];
    if (input.objective) args.push('--objective', input.objective);
    if (input.provider) args.push('--provider', input.provider);
    for (const constraint of input.constraints ?? []) args.push('--constraint', constraint);
    const result = await this.exec<{ call?: { id?: string } }>(...args);
    return result.data.call?.id ?? null;
  }

  async logTurn(callId: string, role: string, text: string): Promise<void> {
    await this.exec('call', 'turn', '--call', callId, '--role', role, '--text', text);
  }

  async endCall(callId: string, outcome: string, success: boolean, summary = ''): Promise<void> {
    const args = ['call', 'end', '--call', callId, '--outcome', outcome];
    if (success) args.push('--success');
    if (summary) args.push('--summary', summary);
    await this.exec(...args);
  }

  async proposeAppointment(input: {
    title: string;
    with?: string;
    start?: string;
    end?: string;
    location?: string;
    callId?: string;
  }): Promise<string | null> {
    const args = ['appointment', 'propose', '--title', input.title];
    if (input.with) args.push('--with', input.with);
    if (input.start) args.push('--start', input.start);
    if (input.end) args.push('--end', input.end);
    if (input.location) args.push('--location', input.location);
    if (input.callId) args.push('--call', input.callId);
    const result = await this.exec<{ appointment?: { id?: string } }>(...args);
    return result.data.appointment?.id ?? null;
  }

  async confirmAppointment(appointmentId: string, externalId?: string): Promise<boolean> {
    const args = ['appointment', 'confirm', appointmentId];
    if (externalId) args.push('--external-id', externalId);
    return (await this.exec(...args)).code === 0;
  }

  async cancelAppointment(appointmentId: string, reason?: string): Promise<boolean> {
    const args = ['appointment', 'cancel', appointmentId];
    if (reason) args.push('--reason', reason);
    return (await this.exec(...args)).code === 0;
  }

  async requestApproval(input: { subject: string; detail?: string; ref?: string; channel?: string }): Promise<string | null> {
    const args = ['approval', 'request', '--subject', input.subject];
    if (input.detail) args.push('--detail', input.detail);
    if (input.ref) args.push('--ref', input.ref);
    if (input.channel) args.push('--channel', input.channel);
    const result = await this.exec<{ approval?: { id?: string } }>(...args);
    return result.data.approval?.id ?? null;
  }

  async decideApproval(approvalId: string, decision: 'approve' | 'deny', via = 'phone', note?: string): Promise<boolean> {
    const args = ['approval', decision, approvalId, '--via', via];
    if (note) args.push('--note', note);
    return (await this.exec(...args)).code === 0;
  }

  /**
   * The gate. Exit code 0 means the owner said yes — anything else means no.
   * Deliberately reads the code and not the prose.
   */
  async isApproved(approvalId: string): Promise<boolean> {
    return (await this.exec('approval', 'check', approvalId)).code === 0;
  }

  async pendingApprovals(): Promise<Record<string, unknown>[]> {
    const result = await this.exec<{ approvals?: Record<string, unknown>[] }>('approval', 'list', '--pending');
    return result.data.approvals ?? [];
  }

  async addLead(input: { name: string; phone?: string; source?: string; need?: string; value?: string }): Promise<string | null> {
    const args = ['lead', 'add', '--name', input.name];
    if (input.phone) args.push('--phone', input.phone);
    if (input.source) args.push('--source', input.source);
    if (input.need) args.push('--need', input.need);
    if (input.value) args.push('--value', input.value);
    const result = await this.exec<{ lead?: { id?: string } }>(...args);
    return result.data.lead?.id ?? null;
  }

  async verify(): Promise<{ ok: boolean; problems: string[] }> {
    const result = await this.exec<{ ok?: boolean; problems?: string[] }>('verify');
    return { ok: result.code === 0, problems: result.data.problems ?? [] };
  }
}
