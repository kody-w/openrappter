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
 */
function isSelfContained(source: string): boolean {
  const imports = [...source.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)]
    .map((m) => m[1]);
  return imports.every(
    (spec) => !spec.startsWith('../') && !/^\.\/(?!BasicAgent|types)/.test(spec),
  );
}

describe('agents do not declare capabilities they cannot reach', () => {
  it('checks a meaningful number of agents', () => {
    // Anti-vacuity: if the self-contained set shrank to nothing, every
    // assertion below would pass without examining anything.
    const selfContained = agentFiles().filter((f) =>
      isSelfContained(readFileSync(path.join(agentsDir, f), 'utf8')),
    );
    expect(selfContained.length).toBeGreaterThanOrEqual(8);
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
