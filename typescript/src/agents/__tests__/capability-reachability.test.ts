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

/** Evidence that a capability is reachable, mirroring CAPABILITY_EVIDENCE. */
const EVIDENCE: Record<string, RegExp> = {
  'process-exec': /from\s+['"](?:node:)?child_process['"]/,
  'network':
    /from\s+['"](?:node:)?(?:http|https|net|dns|dns\/promises|tls)['"]|from\s+['"](?:axios|node-fetch|undici|ws)['"]|\bfetch\s*\(/,
  'filesystem-write':
    /\b(writeFile|writeFileSync|mkdir|mkdirSync|rmSync|unlink|unlinkSync|appendFile|appendFileSync|copyFile|rename|createWriteStream)\b/,
};

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
        const evidence = EVIDENCE[cap];
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
