import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * An agent must not advertise a parameter its implementation never reads.
 *
 * The sibling file `capability-reachability.test.ts` stops an agent declaring a
 * capability it cannot reach. This is the same failure one level down: a
 * parameter offered in `metadata.parameters.properties` that no code consumes.
 *
 * `DesktopControlAgent` advertised `query: 'Natural-language fallback.'` while
 * `perform` forwarded a fixed key allowlist that never contained it, so the key
 * was stripped, `action` fell through to its default, and the caller was handed
 * `status: "success"` for an instruction nobody carried out (#401). That fix
 * came with a parameter-contract test, but only for that one agent -- so this
 * sweep was run across both runtimes, and found four more:
 *
 *   - `DemoRecorder` (both runtimes) -- prose fell through to the `record_rar`
 *     default, so asking for some other demo produced a screen recording of the
 *     RAR walkthrough, on disk, reported as success.
 *   - `HNPipeline` -- `required: []`, so prose returned the default-keyword
 *     stories and reported success.
 *   - `DocScanner`, `NotesIntake` -- `required: ['path']`, so these failed
 *     safe with "path is required". A documentation lie, not a false success.
 *
 * All five advertised the same never-implemented `query`, copied from
 * `ShowAndTellAgent`, where `query` genuinely is read (`kwargs.note ??
 * kwargs.query`). A parameter that does not mean what it says cannot be used to
 * make a decision, and the two that defaulted an action turned that into work
 * the caller never asked for, reported as work the caller did ask for.
 *
 * SCOPE, deliberately permissive. "Reached" means the parameter's name appears
 * anywhere in the file outside the metadata block -- not that it is used
 * correctly. A parameter read into a variable that is then dropped still counts
 * here. The check is built to bias toward false negatives so it cannot redden
 * CI over a spelling it does not recognise; it is a floor, not a ceiling.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const TS_AGENTS_DIR = path.resolve(here, '..');
const PY_AGENTS_DIR = path.resolve(here, '../../../../python/openrappter/agents');

/**
 * Strip comments so prose *about* a parameter is not mistaken for a use of it.
 *
 * Only whole-line comments and block comments are removed. A trailing `//` is
 * deliberately left alone: stripping it means finding `//` inside string
 * literals and regular expressions (`/https:\/\//`), and mangling a line of
 * real code here would invent a missing parameter rather than find one.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('#') && !t.startsWith('*');
    })
    .join('\n');
}

/** Body and end offset of the `{...}` opening at `openIdx`. */
function blockAt(
  source: string,
  openIdx: number,
): { body: string; end: number } | null {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return { body: source.slice(openIdx + 1, i), end: i };
    }
  }
  return null;
}

/**
 * Keys at depth 0 of an object literal or dict body.
 *
 * Quoted and bare keys both count, so this reads TypeScript object literals and
 * Python dicts alike. The quoted form is checked before the string-open branch;
 * checking it after silently returns zero keys for every Python agent, which is
 * how the first draft of this sweep reported a clean Python runtime that had a
 * dead parameter sitting in it.
 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  const KEY = /^["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/;
  let depth = 0;
  let inString: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (depth === 0) {
      const prev = i === 0 ? ',' : body[i - 1];
      if (',{\n \t'.includes(prev)) {
        const m = KEY.exec(body.slice(i));
        if (m) {
          keys.push(m[1]);
          i += m[0].length - 1;
          continue;
        }
      }
    }
    if (c === '"' || c === "'" || c === '`') inString = c;
    else if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
  }
  return keys;
}

interface AgentScan {
  file: string;
  advertised: string[];
  dead: string[];
}

function scanAgent(file: string, source: string): AgentScan | null {
  const clean = stripComments(source);
  const paramsMatch = /["']?parameters["']?\s*:\s*\{/.exec(clean);
  if (!paramsMatch) return null;
  const params = blockAt(clean, paramsMatch.index + paramsMatch[0].length - 1);
  if (!params) return null;
  const propsMatch = /["']?properties["']?\s*:\s*\{/.exec(params.body);
  if (!propsMatch) return null;
  const props = blockAt(
    params.body,
    propsMatch.index + propsMatch[0].length - 1,
  );
  if (!props) return null;

  const advertised = topLevelKeys(props.body);
  // Everything except the metadata block is where a use could live.
  const rest =
    clean.slice(0, paramsMatch.index) + clean.slice(params.end + 1);
  const dead = advertised.filter(
    (name) => !new RegExp(`\\b${name}\\b`).test(rest),
  );
  return { file, advertised, dead };
}

function scanDir(dir: string, ext: string): AgentScan[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (f) =>
        f.endsWith(ext) &&
        !f.toLowerCase().includes('test') &&
        !f.startsWith('__'),
    )
    .map((f) => scanAgent(f, readFileSync(path.join(dir, f), 'utf8')))
    .filter((r): r is AgentScan => r !== null);
}

describe('agent parameter reachability', () => {
  const ts = scanDir(TS_AGENTS_DIR, '.ts');
  const py = scanDir(PY_AGENTS_DIR, '.py');

  it('extracts parameters from both runtimes', () => {
    // Anti-vacuity. Every assertion below is "no dead parameters found", which
    // an extractor returning nothing would satisfy perfectly. These floors are
    // set well under the real counts at the time of writing -- TypeScript 34
    // agents / 158 parameters, Python 21 / 126 -- so ordinary churn will not
    // trip them but a silently broken parser will.
    expect(ts.length).toBeGreaterThanOrEqual(30);
    expect(py.length).toBeGreaterThanOrEqual(18);
    expect(ts.reduce((n, a) => n + a.advertised.length, 0)).toBeGreaterThanOrEqual(140);
    expect(py.reduce((n, a) => n + a.advertised.length, 0)).toBeGreaterThanOrEqual(110);

    // The Python arm read zero keys from every file in the first draft, which
    // no count alone would have exposed, so pin one known Python agent.
    const pyDemo = py.find((a) => a.file === 'demo_recorder_agent.py');
    expect(pyDemo?.advertised).toContain('action');
    expect(pyDemo?.advertised).toContain('with_narration');

    const tsDesktop = ts.find((a) => a.file === 'DesktopControlAgent.ts');
    expect(tsDesktop?.advertised).toContain('view');
  });

  it('has no TypeScript agent advertising a parameter nothing reads', () => {
    const offenders = ts
      .filter((a) => a.dead.length > 0)
      .map((a) => `${a.file}: ${a.dead.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('has no Python agent advertising a parameter nothing reads', () => {
    const offenders = py
      .filter((a) => a.dead.length > 0)
      .map((a) => `${a.file}: ${a.dead.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('detects a dead parameter when one is introduced', () => {
    // The three assertions above are all "expected empty". This proves the
    // detector can actually go red, using the exact shape that was shipped for
    // months: advertised in metadata, referenced nowhere else.
    const withDeadParam = `
      const metadata = {
        name: 'Probe',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory to scan' },
            query: { type: 'string', description: 'Natural language query' },
          },
          required: ['path'],
        },
      };
      async perform(kwargs) { return kwargs.path; }
    `;
    const result = scanAgent('Probe.ts', withDeadParam);
    expect(result?.advertised).toEqual(['path', 'query']);
    expect(result?.dead).toEqual(['query']);
  });

  it('does not count a parameter mentioned only in a comment as read', () => {
    const commentOnly = `
      const metadata = {
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'q' } },
          required: [],
        },
      };
      // TODO: one day actually handle query here
      async perform(kwargs) { return '{}'; }
    `;
    expect(scanAgent('CommentOnly.ts', commentOnly)?.dead).toEqual(['query']);
  });
});
