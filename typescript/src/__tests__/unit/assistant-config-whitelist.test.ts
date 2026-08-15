/**
 * Options a caller passes must survive the constructor. — #104
 *
 * `AssistantConfig` is copied field by field into `this.config`. An option that
 * is declared, documented, and simply not named in that copy is dropped however
 * the caller passed it — and the compiler cannot help, because the field is
 * legal on the interface.
 *
 * `useTwin` was in that state. Measured before the fix:
 *
 *   passed useTwin=true      -> this.config.useTwin = undefined
 *   passed useTwin=false     -> this.config.useTwin = undefined
 *   passed instance=scout    -> this.config.instance  = scout   (control)
 *
 * Its only reader is `const wanted = this.config.useTwin ?? !explicitPersona`,
 * so a permanently-undefined left side made both documented behaviours invert.
 * `useTwin: false` is a caller asking that the owner's personal twin vault stay
 * out of a prompt, and it was being ignored in silence.
 *
 * The same gap swallowed `instance` on the first attempt at #102: the change
 * looked complete and did nothing.
 *
 * So the last test here pins the WHITELIST rather than the fields someone
 * happened to remember, because the next option added to the interface will hit
 * exactly this, and a test that only checks today's fields will not notice.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Assistant } from '../../agents/Assistant.js';
import { TwinVault } from '../../twin/index.js';

type Peek = { config: Record<string, unknown> };

const dirs: string[] = [];
const priorHome = process.env.RAPP_TWIN_HOME;
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  if (priorHome === undefined) delete process.env.RAPP_TWIN_HOME;
  else process.env.RAPP_TWIN_HOME = priorHome;
});

/** A real vault, outside any git repo, that this test owns and deletes. */
function vaultWithMarker(marker: string): void {
  const home = mkdtempSync(join(tmpdir(), 'assistant-vault-'));
  dirs.push(home);
  process.env.RAPP_TWIN_HOME = join(home, 'twin');
  new TwinVault().init(marker);
}

function promptFor(config: Record<string, unknown>): string {
  const assistant = new Assistant(new Map(), {
    loadWorkspaceContext: false,
    loadMemoryContext: false,
    ...config,
  } as never);
  return (assistant as unknown as {
    buildBaseSystemPrompt(m?: string, w?: string): string;
  }).buildBaseSystemPrompt();
}

describe('AssistantConfig options survive the constructor', () => {
  it('keeps useTwin, whatever it was set to', () => {
    for (const value of [true, false]) {
      const assistant = new Assistant(new Map(), { useTwin: value });
      expect((assistant as unknown as Peek).config.useTwin).toBe(value);
    }
  });

  it('honours useTwin:false — the owner\'s vault stays out of the prompt', () => {
    const marker = 'ZZ-VAULT-MARKER-ZZ';
    vaultWithMarker(marker);
    expect(promptFor({ useTwin: false })).not.toContain(marker);
  });

  it('honours useTwin:true — the vault persona is reachable at all', () => {
    // Before #104 this was false for every caller: the only path to the vault
    // was `!explicitPersona`, and the constructor defaults name and description
    // so that expression can never be true. The persona was unreachable.
    const marker = 'ZZ-VAULT-MARKER-ZZ';
    vaultWithMarker(marker);
    expect(promptFor({ useTwin: true })).toContain(marker);
  });

  it('does not change what an install does by default', () => {
    // The default staying put is deliberate, not an oversight — see the note on
    // #104. Flipping it would make the owner's personal persona start speaking
    // to strangers on every install that ever ran `twin init`.
    const marker = 'ZZ-VAULT-MARKER-ZZ';
    vaultWithMarker(marker);
    expect(promptFor({})).not.toContain(marker);
  });

  it('retains a disabled ambient-credential policy across token updates', async () => {
    const priorToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ambient-policy-test';
    try {
      const assistant = new Assistant(new Map(), {
        allowAmbientCredentials: false,
      });

      assistant.setGithubToken(null);
      const provider = (assistant as unknown as {
        provider: { isAvailable(): Promise<boolean> };
      }).provider;
      expect(await provider.isAvailable()).toBe(false);
    } finally {
      if (priorToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = priorToken;
    }
  });

  it('does not let a global CLI preference bypass Desktop sign-out', async () => {
    const priorBackend = process.env.OPENRAPPTER_AI_BACKEND;
    process.env.OPENRAPPTER_AI_BACKEND = 'copilot-cli';
    try {
      const assistant = new Assistant(new Map(), {
        allowAmbientCredentials: false,
      });
      const provider = (assistant as unknown as {
        provider: { id: string; isAvailable(): Promise<boolean> };
      }).provider;
      expect(provider.id).toBe('copilot');
      expect(await provider.isAvailable()).toBe(false);
    } finally {
      if (priorBackend === undefined) delete process.env.OPENRAPPTER_AI_BACKEND;
      else process.env.OPENRAPPTER_AI_BACKEND = priorBackend;
    }
  });

  it('drops no declared option silently — pins the whitelist itself', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', '..', 'agents', 'Assistant.ts'), 'utf8');

    const declared = new Set(
      [...(source.match(/export interface AssistantConfig \{[\s\S]*?\n\}/) ?? [''])[0]
        .matchAll(/^ {2}(\w+)\?:/gm)].map((m) => m[1]),
    );
    const copied = new Set(
      [...(source.match(/this\.config = \{[\s\S]*?\n {4}\};/) ?? [''])[0]
        .matchAll(/^ {6}(\w+):/gm)].map((m) => m[1]),
    );

    // These are legitimately never copied: they are read straight off the
    // constructor argument, so they work without being in this.config.
    const readDirectly = new Set(['provider', 'workspaceDir']);

    const dropped = [...declared].filter((f) => !copied.has(f) && !readDirectly.has(f));
    expect(dropped).toEqual([]);
    // Guard the guard: if the interface stops being found, the check above
    // passes vacuously and would hide the very thing it exists to catch.
    expect(declared.size).toBeGreaterThan(5);
    expect(copied.has('useTwin')).toBe(true);
    expect(copied.has('instance')).toBe(true);
  });
});
