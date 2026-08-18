import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every capability a TypeScript agent declares must be a real capability.
 *
 * `conformance.py` defines the vocabulary and enforces it for Python agents:
 * R4 and R5 read capabilities out of the AST and fail both under- and
 * over-declaration. TypeScript has no equivalent — no schema, no validation,
 * nothing — so an agent could declare anything at all and no check would care.
 *
 * It did. `PhoneAgent` declared `network-access`, which is not a capability;
 * the vocabulary word is `network`, used by eight other agents. The agent that
 * places real phone calls on the owner's behalf was therefore invisible to any
 * filter selecting on `network`, and under-declared the one capability that
 * matters most about it. That is precisely the hazard #122 describes: a rule
 * that can only be applied through a vocabulary nobody validates.
 *
 * The canonical list is read from `conformance.py` rather than copied, so the
 * two runtimes cannot drift apart the way the two halves of every other defect
 * this session did.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const agentsDir = path.resolve(here, '../../agents');

/**
 * Capabilities that exist only in the TypeScript runtime.
 *
 * Listing one here is a deliberate statement that it has no Python counterpart,
 * not a way to silence this test. `ui-control` is real: `DesktopControlAgent`
 * drives the desktop, and Python ships no agent that does.
 */
const TYPESCRIPT_ONLY_CAPABILITIES = new Set(['ui-control']);

/** The vocabulary as `conformance.py` defines it. */
function canonicalCapabilities(): Set<string> {
  const source = fs.readFileSync(path.join(repoRoot, 'conformance.py'), 'utf8');
  const block = /CAPABILITY_EVIDENCE = \{([\s\S]*?)\n\}/.exec(source);
  if (!block) throw new Error('CAPABILITY_EVIDENCE not found in conformance.py');
  return new Set(
    [...block[1].matchAll(/^ {4}"([a-z-]+)":/gm)].map((m) => m[1]),
  );
}

function agentFiles(): string[] {
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.endsWith('Agent.ts'))
    .filter((f) => !f.endsWith('.test.ts'))
    .filter((f) => f !== 'BasicAgent.ts');
}

/** Capabilities declared in a file's `__manifest__`. */
function declaredCapabilities(file: string): string[] {
  const source = fs.readFileSync(path.join(agentsDir, file), 'utf8');
  const match = /capabilities:\s*\[([\s\S]*?)\]/.exec(source);
  if (!match) return [];
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('agent capability vocabulary', () => {
  it('reads a non-empty vocabulary from conformance.py', () => {
    // Anti-vacuity: a parse that silently returned nothing would make every
    // declaration below valid by comparing against an empty set.
    const canonical = canonicalCapabilities();
    expect(canonical.size).toBeGreaterThanOrEqual(5);
    expect(canonical).toContain('network');
  });

  it('finds a non-trivial number of agents to check', () => {
    expect(agentFiles().length).toBeGreaterThan(25);
  });

  it('every declared capability is a real one', () => {
    const allowed = new Set([
      ...canonicalCapabilities(),
      ...TYPESCRIPT_ONLY_CAPABILITIES,
    ]);

    const offenders: string[] = [];
    for (const file of agentFiles()) {
      for (const capability of declaredCapabilities(file)) {
        if (!allowed.has(capability)) {
          offenders.push(`${file}: ${capability}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the agent that can phone a person declares that it reaches the network', () => {
    // Named explicitly rather than left to the sweep above, because this is
    // the declaration whose absence had consequences: a twin filter selecting
    // on `network` skipped the agent that dials real people (#122).
    expect(declaredCapabilities('PhoneAgent.ts')).toContain('network');
  });

  it('would notice an invented capability (control)', () => {
    // Proves the sweep discriminates rather than accepting whatever it reads.
    const allowed = new Set([
      ...canonicalCapabilities(),
      ...TYPESCRIPT_ONLY_CAPABILITIES,
    ]);
    expect(allowed.has('network-access')).toBe(false);
    expect(allowed.has('network')).toBe(true);
  });

  it('every TypeScript-only capability is actually in use', () => {
    // Stops the escape hatch becoming a dumping ground: a term listed here and
    // used by nobody is a stale exception, not a runtime difference.
    const declared = new Set(agentFiles().flatMap(declaredCapabilities));
    const unused = [...TYPESCRIPT_ONLY_CAPABILITIES].filter((c) => !declared.has(c));
    expect(unused).toEqual([]);
  });
});

/**
 * The check above reads capabilities out of the *source text*. That is enough
 * to catch a misspelt capability, but not enough to notice that the manifest
 * is not a manifest.
 *
 * `ComputerUseAgent` carried a generated `__manifest__` block inserted at a
 * byte offset that landed inside the Python source string used for OCR. The
 * regex above matched it and passed, while the module exported no manifest at
 * all and the OCR script was a syntax error. A declaration the runtime never
 * evaluates is not a declaration.
 */
describe('agent manifests are real exports, not just matching text', () => {
  it('every agent actually exports __manifest__ at runtime', async () => {
    const missing: string[] = [];
    for (const file of agentFiles()) {
      const mod = (await import(
        /* @vite-ignore */ path.join(agentsDir, file)
      )) as Record<string, unknown>;
      if (typeof mod.__manifest__ === 'undefined') missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  it('the exported capabilities are the ones the source text advertises', async () => {
    // Anti-drift: if these two ever disagree, the text-based check above is
    // reading something the product does not.
    for (const file of agentFiles()) {
      const mod = (await import(
        /* @vite-ignore */ path.join(agentsDir, file)
      )) as Record<string, { capabilities?: readonly string[] } | undefined>;
      const exported = [...(mod.__manifest__?.capabilities ?? [])].sort();
      const fromText = [...declaredCapabilities(file)].sort();
      expect(exported, `${file} manifest text and export disagree`).toEqual(fromText);
    }
  });
});
