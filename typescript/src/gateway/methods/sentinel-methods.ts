/**
 * Sentinel RPC methods — the front door of OpenRappter.
 *
 * The pattern this exposes is deliberately narrow: a human supplies a
 * SITUATION and BOUNDARIES, never a task. The system decides what, if
 * anything, to do about it — including deciding to do nothing.
 *
 * That distinction is not decoration. When the same loop was handed explicit
 * tasks it produced exactly what it was told and nothing more; when it was
 * handed a situation it declined once, then found four defects in its own
 * supervisor that nobody had described to it. The API surface here refuses to
 * accept a task field for that reason.
 *
 * The runtime itself is the Python implementation in `rapp-sentinel`, which is
 * the version that has actually been run overnight and audited. Reimplementing
 * it here would trade a verified system for an unverified one.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

/** Freedom ladder. Each rung is what the system may do WITHOUT asking. */
export const FREEDOM = [
  { level: 0, id: 'observe', label: 'Observe',
    blurb: 'Watch and record. Never spends a model, never changes anything.' },
  { level: 1, id: 'alert', label: 'Alert',
    blurb: 'Tell you when something breaks. Still changes nothing.' },
  { level: 2, id: 'diagnose', label: 'Diagnose',
    blurb: 'Investigate a failure and explain the cause. Proposes, does not apply.' },
  { level: 3, id: 'repair', label: 'Repair',
    blurb: 'Fix what broke, then re-probe to prove the fix landed.' },
  { level: 4, id: 'evolve', label: 'Evolve',
    blurb: 'When nothing is broken, act on its own initiative. Declining is a valid outcome.' },
] as const;

export interface Direction {
  /** What matters. Plain language. NOT an instruction. */
  situation: string;
  /** What it must never do. The only hard limits. */
  boundaries: string[];
  /** What it is responsible for keeping healthy. */
  cares_about: string[];
  freedom: number;
  budgets: { repair_per_day: number; evolve_per_day: number };
  updated_at?: string;
}

export interface WatcherState {
  slug: string;
  role: string;
  frames: number;
  chain_ok: boolean;
  chain_detail: string;
  age_minutes: number | null;
  alive: boolean;
  /** From the external anchor, not from the chain itself. */
  truncated?: boolean;
  revised?: boolean;
}

export interface SentinelStatus {
  installed: boolean;
  home: string | null;
  status: 'healthy' | 'degraded' | 'critical' | 'unknown';
  summary: string;
  checks: Array<{ id: string; ok: boolean; severity: string; detail: string }>;
  watchers: WatcherState[];
  peers: Record<string, unknown>;
  direction: Direction | null;
  integrity: 'verified' | 'revised' | 'truncated' | 'unknown';
  last_tick: string | null;
}

const DEFAULT_HOME = join(homedir(), 'rapp-sentinel');
const UPSTREAM = 'https://github.com/kody-w/rapp-sentinel';

export const DEFAULT_DIRECTION: Direction = {
  situation:
    'Nothing has been described yet. Tell the sentinel what matters to you — ' +
    'not what to do about it.',
  boundaries: [
    'Never force-push or rewrite published history.',
    'Never touch anything outside the repositories named above.',
    'Never spend more than the budget allows, even to finish something.',
  ],
  cares_about: [],
  freedom: 1,
  budgets: { repair_per_day: 8, evolve_per_day: 2 },
};

function sentinelHome(): string | null {
  const configured = process.env.RAPP_SENTINEL_HOME;
  if (configured && existsSync(configured)) return configured;
  return existsSync(DEFAULT_HOME) ? DEFAULT_HOME : null;
}

/** Run a python entrypoint in the sentinel home and parse its JSON stdout. */
function runPy(home: string, args: string[], timeoutMs = 120_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', args, { cwd: home });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new Error(`sentinel ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      clearTimeout(timer);
      try {
        // Tolerate leading log lines: take from the first brace.
        const i = out.indexOf('{');
        resolve(i >= 0 ? JSON.parse(out.slice(i)) : {});
      } catch {
        reject(new Error(err.trim() || `unparseable output from ${args[0]}`));
      }
    });
    p.on('error', reject);
  });
}

function readDirection(home: string): Direction | null {
  const f = join(home, 'direction.json');
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf-8')) as Direction;
  } catch {
    return null;
  }
}

export function registerSentinelMethods(server: MethodRegistrar): void {
  server.registerMethod<Record<string, never>, SentinelStatus>(
    'sentinel.status',
    async () => {
      const home = sentinelHome();
      if (!home) {
        return {
          installed: false, home: null, status: 'unknown',
          summary: 'No sentinel is installed yet.',
          checks: [], watchers: [], peers: {},
          direction: null, integrity: 'unknown', last_tick: null,
        };
      }

      const [verdict, roll, anchors] = await Promise.all([
        runPy(home, ['health.py']).catch(() => null),
        runPy(home, ['neighborhood.py', 'roll-call']).catch(() => ({})),
        runPy(home, ['neighborhood.py', 'anchors']).catch(() => ({})),
      ]);

      const v = (verdict ?? {}) as Record<string, any>;
      const r = roll as Record<string, any>;
      const a = anchors as Record<string, any>;

      const watchers: WatcherState[] = Object.entries(r).map(([slug, w]: [string, any]) => ({
        slug,
        role: w.role ?? '',
        frames: w.frames ?? 0,
        chain_ok: !!w.chain_ok,
        chain_detail: w.chain_detail ?? '',
        age_minutes: w.age_minutes ?? null,
        alive: !!w.alive,
        truncated: a[slug]?.truncated ?? undefined,
        revised: a[slug]?.revised ?? undefined,
      }));

      // Integrity is reported from the EXTERNAL anchor, never from the chain
      // alone. A chain that verifies against itself proves only that its
      // writer was deterministic — an interior frame can be rewritten and
      // resealed and still pass every internal check.
      let integrity: SentinelStatus['integrity'] = 'verified';
      if (watchers.some((w) => w.truncated)) integrity = 'truncated';
      else if (watchers.some((w) => w.revised)) integrity = 'revised';
      else if (!watchers.length || watchers.some((w) => !w.chain_ok)) integrity = 'unknown';

      let last_tick: string | null = null;
      try {
        last_tick = JSON.parse(
          readFileSync(join(home, 'state', 'last_run.json'), 'utf-8'),
        ).at ?? null;
      } catch { /* first run */ }

      return {
        installed: true,
        home,
        status: (v.status ?? 'unknown') as SentinelStatus['status'],
        summary: v.summary ?? 'no verdict',
        checks: v.checks ?? [],
        watchers,
        peers: {},
        direction: readDirection(home),
        integrity,
        last_tick,
      };
    },
  );

  server.registerMethod<Partial<Direction>, { ok: boolean; direction: Direction }>(
    'sentinel.direction.set',
    async (params) => {
      const home = sentinelHome();
      if (!home) throw new Error('no sentinel installed');

      // A task is not accepted here, by design. If the caller supplies one we
      // drop it rather than quietly honouring it, because a system given a
      // procedure stops being able to tell you the procedure was wrong.
      const incoming = { ...params } as Record<string, unknown>;
      delete incoming.task;
      delete incoming.instructions;
      delete incoming.steps;

      const next: Direction = {
        ...DEFAULT_DIRECTION,
        ...(readDirection(home) ?? {}),
        ...(incoming as Partial<Direction>),
        updated_at: new Date().toISOString(),
      };
      next.freedom = Math.max(0, Math.min(4, Number(next.freedom) || 0));
      writeFileSync(join(home, 'direction.json'), JSON.stringify(next, null, 2) + '\n');
      return { ok: true, direction: next };
    },
  );

  server.registerMethod<{ limit?: number }, { frames: unknown[] }>(
    'sentinel.frames',
    async ({ limit = 60 }) => {
      const home = sentinelHome();
      if (!home) return { frames: [] };
      const base = join(home, 'neighborhood');
      if (!existsSync(base)) return { frames: [] };
      const frames: unknown[] = [];
      for (const slug of readdirSync(base)) {
        const chain = join(base, slug, 'chain.jsonl');
        if (!existsSync(chain)) continue;
        for (const line of readFileSync(chain, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            frames.push({ ...JSON.parse(line), watcher: slug });
          } catch { /* skip unparseable */ }
        }
      }
      frames.sort((x: any, y: any) => String(y.utc).localeCompare(String(x.utc)));
      return { frames: frames.slice(0, limit) };
    },
  );

  server.registerMethod<Record<string, never>, { ok: boolean; output: string }>(
    'sentinel.tick',
    async () => {
      const home = sentinelHome();
      if (!home) throw new Error('no sentinel installed');
      return new Promise((resolve) => {
        const p = spawn('bash', ['run.sh'], { cwd: home });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        p.on('close', (code) => resolve({ ok: code === 0, output: out.slice(-4000) }));
      });
    },
  );

  server.registerMethod<Record<string, never>, { levels: typeof FREEDOM }>(
    'sentinel.freedom',
    async () => ({ levels: FREEDOM }),
  );

  server.registerMethod<Record<string, never>, { ok: boolean; home: string; log: string }>(
    'sentinel.install',
    async () => {
      const existing = sentinelHome();
      if (existing) return { ok: true, home: existing, log: 'already installed' };
      return new Promise((resolve, reject) => {
        const p = spawn('git', ['clone', '--depth', '1', UPSTREAM, DEFAULT_HOME]);
        let log = '';
        p.stdout.on('data', (d) => (log += d));
        p.stderr.on('data', (d) => (log += d));
        p.on('close', (code) => {
          if (code !== 0) return reject(new Error(log.slice(-800)));
          writeFileSync(
            join(DEFAULT_HOME, 'direction.json'),
            JSON.stringify(DEFAULT_DIRECTION, null, 2) + '\n',
          );
          resolve({ ok: true, home: DEFAULT_HOME, log });
        });
        p.on('error', reject);
      });
    },
  );
}
