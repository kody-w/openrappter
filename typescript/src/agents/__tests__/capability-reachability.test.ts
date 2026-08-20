import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * An agent must not declare a capability it cannot reach.
 *
 * `conformance.py` enforces this as R5 — "No agent over-declares a capability
 * it cannot reach" — but R5 walks `agent_files()`, which its own docstring
 * describes as "Python agents only". No TypeScript agent had ever been checked.
 *
 * Three were wrong, all the same way. `DocScannerAgent`, `NotesIntakeAgent`
 * and `WebAgent` declared `process-exec` while importing no `child_process` at
 * all; what they contain is regular-expression `.exec()` calls. The two
 * scanners additionally declared `filesystem-write` while importing only
 * `readdir`, `stat` and `readFile`. Read-only scanners held the two most
 * dangerous capabilities in the vocabulary.
 *
 * Over-declaration is the mirror of the under-declaration in #244, and it
 * costs the same thing: a capability that does not mean what it says cannot be
 * used to make a decision. A policy denying `process-exec` would refuse three
 * agents that only match text.
 *
 * SCOPE, deliberately narrow. Evidence is read from the agent's own file, so
 * this can only speak for agents whose imports are all Node builtins — an
 * agent that delegates through a local module may reach a capability this file
 * cannot see. Those are excluded from the assertion rather than guessed at,
 * and counted below so the exclusion cannot quietly grow to cover everything.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const agentsDir = path.resolve(here, '..');

/**
 * Evidence that a capability is reachable, mirroring CAPABILITY_EVIDENCE.
 *
 * These patterns are the security-critical core of this file, and until now
 * nothing tested them directly — they were only ever exercised against
 * whichever agents happened to exist, so a gap could sit here indefinitely
 * without a single test going red. Fourteen of fifteen realistic
 * `filesystem-write` forms were invisible, including `fs.rm(dir, {recursive:
 * true})`, the async twin of the `rmSync` the table already listed. The
 * `\b...\b` word boundary also meant `rename` did not match `renameSync` and
 * `copyFile` did not match `copyFileSync`, because the `S` that follows is a
 * word character. Those forms are used 71 times elsewhere in `typescript/src`;
 * it was luck, not design, that no self-contained agent had reached for one.
 *
 * The list is now built from verb + optional `Sync` so a twin cannot go
 * missing again, and the classifier has unit tests of its own below.
 *
 * `rm` and `cp` are matched only in call position, since two letters are too
 * little to spend a false positive on. Bare `link` is deliberately absent for
 * the same reason — it is far more likely to be a markup helper than
 * `fs.link`, and `symlink` covers the case that matters. A false positive here
 * would push someone to declare a capability they do not have, which is the
 * exact disease this file exists to treat.
 */
const FS_WRITE_VERBS = [
  'writeFile', 'appendFile', 'copyFile', 'rename', 'mkdir', 'rmdir', 'unlink',
  'truncate', 'ftruncate', 'symlink', 'chmod', 'chown', 'mkdtemp', 'writev',
  'createWriteStream',
];

const EVIDENCE: Record<string, RegExp> = {
  'process-exec': /from\s+['"](?:node:)?child_process['"]/,
  'network':
    /from\s+['"](?:node:)?(?:http|https|http2|net|dgram|dns|dns\/promises|tls)['"]|from\s+['"](?:axios|node-fetch|undici|ws)['"]|\bfetch\s*\(|\bnew\s+WebSocket\s*\(/,
  'filesystem-write': new RegExp(
    `\\b(?:${FS_WRITE_VERBS.join('|')})(?:Sync)?\\b|\\b(?:rm|cp)(?:Sync)?\\s*\\(`,
  ),
  // Any environment read, deliberately — matching the Python table, which
  // counts `os.environ` in every position. Neither side can tell
  // `OPENRAPPTER_PYTHON` from `OPENAI_API_KEY`; both are one subscript away
  // from each other, and a table that tried to guess which names are secret
  // would be wrong the first time someone invented a new one. Python already
  // paid this false-positive cost -- `pokemon_agent.py` declares
  // credential-access for `os.environ.get("OPENRAPPTER_POKEMON_ROM")`, a ROM
  // path. Until now the TypeScript twin of that read declared nothing, so the
  // same code got two verdicts depending on which language it was written in.
  'credential-access':
    /\bprocess\.env\b|from\s+['"]keytar['"]|\bfind-generic-password\b/,
  // `import(` only when the specifier is computed: a literal `import('./x.js')`
  // is an ordinary dependency, while a computed one runs code chosen at
  // runtime.
  'dynamic-code':
    /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.runIn|from\s+['"](?:node:)?vm['"]|\bimport\s*\((?!\s*['"])/,
};

/**
 * Capabilities that may not be reported as over-declared.
 *
 * Under-declaration and over-declaration are not mirror images, and treating
 * them as one cost a correct declaration. Evidence in the file proves an agent
 * *reaches* a capability; the absence of evidence does not prove it does not,
 * because reaching it can be delegated. `PythonAgent.ts` is the live proof: it
 * declares `dynamic-code` because `spawn('python3', [runner.py, ...])` loads
 * an arbitrary `.py` file by path and calls into it. Nothing in the agent's own
 * source can show that, so a regex would have called a true declaration false
 * and pushed someone to delete it -- the permissive direction, and the one
 * failure this file must never cause.
 *
 * The other capabilities stay in both directions because their evidence cannot
 * be delegated out of the file: an import or a call is either written here or
 * it is not.
 */
const NO_ABSENCE_PROOF = new Set(['dynamic-code']);

function agentFiles(): string[] {
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith('Agent.ts') && f !== 'BasicAgent.ts');
}

/**
 * An agent whose every import is a Node builtin, `./BasicAgent.js` or a type.
 * `BasicAgent` itself performs no disk or process I/O, so for these files the
 * source is the whole story.
 *
 * Dynamic imports count. This used to read static `import ... from` lines only,
 * which meant `await import('../infra/gateway-lock.js')` was invisible to it —
 * the very same specifier that disqualifies a file when written statically.
 * Three of the thirteen agents this asserted against reached deep internals
 * that way (`CronAgent` into `../cron/service.js`, `TTSAgent` into
 * `../voice/tts.js`, and `NeighborAgent` into nine modules under `../infra`
 * and `../twin`), so the file claimed "the source is the whole story" about
 * files whose story continued somewhere it never looked. No live
 * mis-declaration was hiding there — each one calls a pure helper — but the
 * assertions were resting on a premise that was not true, which is the kind of
 * thing that holds until it suddenly doesn't.
 *
 * A dynamic import with a computed specifier is excluded outright: if the
 * target is only known at runtime, nothing here can say what it reaches. No
 * agent in this directory does that today, but `morning_brief_agent.js` loads
 * siblings by `import(path.join(...))`, so the shape is not hypothetical.
 */
function isSelfContained(source: string): boolean {
  const isDeep = (spec: string) =>
    spec.startsWith('../') || /^\.\/(?!BasicAgent|types)/.test(spec);

  const staticImports = [...source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1]);
  if (!staticImports.every((spec) => !isDeep(spec))) return false;

  const literalDynamic = [...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
    .map((m) => m[1]);
  if (!literalDynamic.every((spec) => !isDeep(spec))) return false;

  const everyDynamic = source.match(/\bimport\s*\(/g)?.length ?? 0;
  return everyDynamic === literalDynamic.length;
}

describe('agents do not declare capabilities they cannot reach', () => {
  it('checks a meaningful number of agents', () => {
    // Anti-vacuity: if the self-contained set shrank to nothing, every
    // assertion below would pass without examining anything. The floor sits at
    // the true current count rather than comfortably below it, because the
    // failure this guards against is the set eroding one agent at a time —
    // teaching an agent to reach a deep module through a dynamic import now
    // drops it out of these assertions, and that should require saying so here
    // rather than happening quietly.
    const selfContained = agentFiles().filter((f) =>
      isSelfContained(readFileSync(path.join(agentsDir, f), 'utf8')),
    );
    expect(selfContained.length).toBeGreaterThanOrEqual(10);
  });

  describe('the self-contained rule sees past static imports', () => {
    const builtinOnly = "import fs from 'node:fs';\nimport { BasicAgent } from './BasicAgent.js';\n";

    it('accepts builtins and BasicAgent', () => {
      expect(isSelfContained(builtinOnly)).toBe(true);
    });

    it('rejects a deep static import', () => {
      expect(isSelfContained(`${builtinOnly}import { x } from '../infra/roster.js';\n`)).toBe(false);
    });

    it('rejects a deep dynamic import — the case that was invisible', () => {
      expect(isSelfContained(`${builtinOnly}const m = await import('../infra/gateway-lock.js');`))
        .toBe(false);
    });

    it('rejects a computed dynamic import, whose target it cannot know', () => {
      expect(isSelfContained(`${builtinOnly}const m = await import(path.join(dir, name));`))
        .toBe(false);
    });

    it('still accepts a dynamic import of a builtin', () => {
      expect(isSelfContained(`${builtinOnly}const m = await import('node:os');`)).toBe(true);
    });
  });

  describe('the evidence patterns see the forms this codebase actually uses', () => {
    // These patterns decide whether an agent is holding an undeclared
    // capability, and nothing tested them until now — they were only ever run
    // against whichever agents existed, so a missing form failed silently.
    // Every case below was measured as invisible to the previous table.
    const fsWrite = EVIDENCE['filesystem-write'];

    it.each([
      ['await fs.rm(dir, { recursive: true, force: true });', 'recursive delete'],
      ['fs.rmSync(dir, { recursive: true });', 'rmSync'],
      ['await fs.rmdir(dir);', 'rmdir'],
      ['fs.rmdirSync(dir);', 'rmdirSync'],
      ['fs.renameSync(a, b);', 'renameSync — the word boundary hid this'],
      ['fs.copyFileSync(a, b);', 'copyFileSync — likewise'],
      ['await fs.cp(src, dst, { recursive: true });', 'cp'],
      ['fs.cpSync(src, dst);', 'cpSync'],
      ['await fs.truncate(p, 0);', 'truncate erases a file'],
      ['await fs.symlink(target, linkPath);', 'symlink'],
      ['await fs.chmod(p, 0o777);', 'chmod'],
      ['await fs.mkdtemp(prefix);', 'mkdtemp creates a directory'],
      ['await fsp.writeFile(p, data);', 'writeFile, which always worked'],
    ])('sees %s (%s)', (source) => {
      expect(fsWrite.test(source)).toBe(true);
    });

    it('does not fire on ordinary prose or unrelated calls', () => {
      // A false positive here would push someone to declare a capability they
      // do not hold, which is the failure this file exists to prevent.
      for (const benign of [
        'const url = link(label, href);',
        '// remove the item from the array',
        'const form = new FormData();',
        'return items.map((i) => i.id);',
      ]) {
        expect(fsWrite.test(benign)).toBe(false);
      }
    });

    it('sees any environment read, secret-looking or not', () => {
      const cred = EVIDENCE['credential-access'];
      expect(cred.test("const k = process.env.OPENAI_API_KEY;")).toBe(true);
      expect(cred.test("const p = process.env.OPENRAPPTER_PYTHON ?? 'python3';"))
        .toBe(true);
      expect(cred.test('const { HOME } = process.env;')).toBe(true);
      expect(cred.test("import keytar from 'keytar';")).toBe(true);
      // Not an environment read. `env` as an ordinary word must not fire, or
      // agents get pushed into declaring a capability they do not hold.
      expect(cred.test('const env = buildEnvironment(opts);')).toBe(false);
      expect(cred.test('// pass the environment through to the child')).toBe(false);
    });

    it('sees code chosen at runtime, but not an ordinary import', () => {
      const dyn = EVIDENCE['dynamic-code'];
      expect(dyn.test('const out = eval(expr);')).toBe(true);
      expect(dyn.test('const f = new Function("return 1");')).toBe(true);
      expect(dyn.test("import vm from 'node:vm';")).toBe(true);
      expect(dyn.test('vm.runInNewContext(src);')).toBe(true);
      expect(dyn.test('const mod = await import(specifier);')).toBe(true);
      // A literal specifier is a dependency, not dynamic code. Every
      // self-contained agent uses this form to reach BasicAgent.
      expect(dyn.test("const mod = await import('./BasicAgent.js');")).toBe(false);
      expect(dyn.test("import { spawn } from 'child_process';")).toBe(false);
    });

    it('every capability the contract knows has evidence here', () => {
      // The Python table is the contract's other half. It had five entries
      // while this one had three, so `credential-access` and `dynamic-code`
      // could not be reported in TypeScript at all -- and R4 said in its own
      // success message that TypeScript was covered by this file.
      for (const cap of [
        'process-exec', 'network', 'filesystem-write',
        'credential-access', 'dynamic-code',
      ]) {
        expect(Object.keys(EVIDENCE)).toContain(cap);
      }
    });

    it('nothing is exempted from over-declaration that is not a capability', () => {
      for (const cap of NO_ABSENCE_PROOF) {
        expect(Object.keys(EVIDENCE)).toContain(cap);
      }
    });

    it('sees network transports beyond http', () => {
      const net = EVIDENCE['network'];
      expect(net.test("import dgram from 'node:dgram';")).toBe(true);
      expect(net.test("import http2 from 'node:http2';")).toBe(true);
      expect(net.test('const s = new WebSocket(url);')).toBe(true);
      expect(net.test("import path from 'node:path';")).toBe(false);
    });
  });

  it('no self-contained agent declares an unreachable capability', async () => {
    const over: string[] = [];
    for (const file of agentFiles()) {
      const source = readFileSync(path.join(agentsDir, file), 'utf8');
      if (!isSelfContained(source)) continue;
      const mod = (await import(path.join(agentsDir, file))) as Record<
        string,
        { capabilities?: readonly string[] } | undefined
      >;
      for (const cap of mod.__manifest__?.capabilities ?? []) {
        const evidence = NO_ABSENCE_PROOF.has(cap) ? undefined : EVIDENCE[cap];
        if (evidence && !evidence.test(source)) {
          over.push(`${file} declares ${cap} with nothing in the file that reaches it`);
        }
      }
    }
    expect(over).toEqual([]);
  });

  it('no self-contained agent reaches a capability it did not declare', async () => {
    const under: string[] = [];
    for (const file of agentFiles()) {
      const source = readFileSync(path.join(agentsDir, file), 'utf8');
      if (!isSelfContained(source)) continue;
      const mod = (await import(path.join(agentsDir, file))) as Record<
        string,
        { capabilities?: readonly string[] } | undefined
      >;
      const declared = new Set(mod.__manifest__?.capabilities ?? []);
      for (const [cap, evidence] of Object.entries(EVIDENCE)) {
        if (!declared.has(cap) && evidence.test(source)) {
          under.push(`${file} reaches ${cap} without declaring it`);
        }
      }
    }
    expect(under).toEqual([]);
  });
});
