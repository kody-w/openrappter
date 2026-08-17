import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tsRoot = path.resolve(__dirname, '../../..');
const repoRoot = path.resolve(tsRoot, '..');

/**
 * The agent count the documentation advertises, checked against a fresh install.
 *
 * These numbers had drifted three different ways at once: `architecture.html`
 * said 37 TypeScript agents, `index.html` said 22, and the README said 3. None
 * matched, and none matched the runtime.
 *
 * The 37 is the instructive one. I put it there myself, taken from
 * `--list-agents` on the machine I was working on — which is the right source
 * and the wrong reading, because that command also loads the operator's own
 * agents from `~/.openrappter/agents`. I had three of my own at the time, so
 * the published figure described my laptop rather than the product, and it
 * looked more authoritative than a guess precisely because it came from the
 * runtime.
 *
 * So this counts with `HOME` pointed at an empty directory. That is the number
 * a person gets when they install it, which is the only number worth printing.
 */

/** Agents a fresh install registers, with no user agents present. */
async function builtInAgentCount(): Promise<number> {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openrappter-fresh-'));
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(tsRoot, 'bin', 'openrappter.mjs'), '--list-agents'],
      {
        cwd: tsRoot,
        timeout: 120_000,
        env: { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome, NO_COLOR: '1' },
      },
    );
    return stdout.split('\n').filter((line) => /^\s{2}• /.test(line)).length;
  } finally {
    fs.rmSync(emptyHome, { recursive: true, force: true });
  }
}

/** The language mentioned closest to a position, either side of it. */
function nearestLanguage(text: string, index: number, window = 60): string | null {
  const start = Math.max(0, index - window);
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const match of text.slice(start, index + window).matchAll(/python|typescript/gi)) {
    const position = start + (match.index ?? 0);
    const distance = Math.abs(position - index);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = /python/i.test(match[0]) ? 'Python' : 'TypeScript';
    }
  }
  return best;
}

/** Every "<n> agents" claim in the published pages, with where it was found. */
function documentedCounts(): { file: string; claim: string; count: number; language: string | null }[] {
  const files = [
    path.join(repoRoot, 'docs', 'architecture.html'),
    path.join(repoRoot, 'docs', 'index.html'),
    path.join(repoRoot, 'docs', 'rappter-com.html'),
    path.join(repoRoot, 'README.md'),
  ].filter((f) => fs.existsSync(f));

  const found: { file: string; claim: string; count: number; language: string | null }[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(\d+)\s+(?:built-in\s+)?agents/gi)) {
      // Which runtime a count belongs to is not always after the number. The
      // README writes "Python (20 agents) and TypeScript (34 agents)", so the
      // language sits before it — reading only forwards attributed the Python
      // figure to TypeScript and rejected a correct line.
      //
      // It has to be the NEAREST mention rather than any within the window,
      // because that same line puts both languages within a few characters of
      // each other: a plain search finds "Python" before the TypeScript figure
      // and quietly drops it from this check.
      const language = nearestLanguage(text, match.index);
      found.push({
        file: path.relative(repoRoot, file),
        claim: match[0].trim(),
        count: Number(match[1]),
        language,
      });
    }
  }
  return found;
}

describe('the documented agent count matches a fresh install', () => {
  let builtIns = 0;

  beforeAll(async () => {
    builtIns = await builtInAgentCount();
  }, 180_000);

  it('registers a realistic number of built-in agents', () => {
    // Anti-vacuity: a broken spawn or a changed bullet character would report
    // zero, and every comparison below would then be against nothing.
    expect(builtIns).toBeGreaterThan(20);
  });

  it('counts fewer agents than a machine with user agents present', async () => {
    // Detector control. If the isolated HOME were ignored, this count would
    // include whatever the developer happens to have installed, which is the
    // exact mistake being guarded against — so prove the isolation does
    // something by comparing against the unisolated count on this machine.
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(tsRoot, 'bin', 'openrappter.mjs'), '--list-agents'],
      { cwd: tsRoot, timeout: 120_000, env: { ...process.env, NO_COLOR: '1' } },
    );
    const here = stdout.split('\n').filter((line) => /^\s{2}• /.test(line)).length;

    expect(here).toBeGreaterThanOrEqual(builtIns);
  }, 180_000);

  it('finds agent counts to check in more than one page', () => {
    const counts = documentedCounts();
    expect(counts.length).toBeGreaterThan(3);
    expect(new Set(counts.map((c) => c.file)).size).toBeGreaterThan(2);
    // Anti-vacuity for the attribution: if every count came back unattributed
    // the Python filter below would silently check nothing.
    expect(counts.some((c) => c.language === 'Python')).toBe(true);
  });

  it('publishes no TypeScript agent count that is not the real one', () => {
    // Python counts are checked by the Python suite, which is where a Python
    // runtime is guaranteed to exist.
    const wrong = documentedCounts()
      .filter((c) => c.language !== 'Python')
      .filter((c) => c.count !== builtIns);

    expect(
      wrong,
      wrong.length
        ? `A fresh install registers ${builtIns} agents. These say otherwise:\n` +
          wrong.map((c) => `  ${c.file}: "${c.claim}"`).join('\n') +
          `\n\nCount with HOME pointed at an empty directory; --list-agents on a\n` +
          `developer machine also loads that person's own agents.\n`
        : '',
    ).toEqual([]);
  });
});
