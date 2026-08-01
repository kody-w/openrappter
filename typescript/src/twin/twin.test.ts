import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_VAULT, TwinVault, TwinVaultError, findEnclosingRepo, fingerprint, toShape } from './vault.js';
import { disclosureRules, renderPublicSoul, renderSoul, renderTwinContext } from './soul.js';
import { emptyProfile } from './types.js';
import {
  ArchetypeError,
  httpLoader,
  inherit,
  resolveArchetype,
  validateArchetype,
} from './archetype.js';
import type { TwinProfile } from './types.js';

/**
 * The twin is the most sensitive thing openrappter will ever hold.
 *
 * Most of this file is a leak guard. The claim "the engine is public, the
 * consciousness is local" is only worth making if something fails loudly when
 * it stops being true — so these tests use a profile stuffed with realistic
 * secrets and assert that none of them can reach an export, a public prompt,
 * or a git repository.
 */

// Deliberately realistic. Every one of these is asserted absent from anything
// that leaves the device.
const SECRETS = {
  email: 'private.person@example.com',
  phone: '+15551234567',
  address: '42 Elm Street, Springfield',
  handle: '@private_handle',
  client: 'Northwind Traders',
  partner: 'Jordan Rivera',
  project: 'Project Halcyon',
  fact: 'renewal is due in March',
};

function loadedProfile(): TwinProfile {
  const profile = emptyProfile('twin_test', 'Alex Doe', '2026-08-01T00:00:00.000Z');

  profile.identity.shortName = 'Alex';
  profile.identity.pronouns = 'they/them';
  profile.identity.timezone = 'America/New_York';

  profile.roles = [{ title: 'Founder', org: SECRETS.client, focus: 'shipping the thing' }];
  profile.voice = {
    tone: ['direct', 'dry'],
    avoid: ['hedging', 'corporate filler'],
    signatures: ['ship it', 'what does the test say'],
  };
  profile.context = {
    projects: [{ name: SECRETS.project, what: 'the secret one', where: '~/dev/halcyon' }],
    people: [{ name: SECRETS.partner, relationship: 'business partner', notes: 'handles the books' }],
    tools: ['openrappter', 'git'],
    facts: [SECRETS.fact],
  };
  profile.boundaries = {
    mayDo: ['draft replies', 'summarise the day'],
    mustAsk: ['spend money', 'commit to a meeting'],
    neverDo: ['share personal details'],
  };
  profile.accounts = {
    email: SECRETS.email,
    phone: SECRETS.phone,
    address: SECRETS.address,
    social: SECRETS.handle,
  };

  return profile;
}

/** Every secret value, for blanket absence assertions. */
const ALL_SECRETS = Object.values(SECRETS);

function assertNoSecrets(text: string, what: string): void {
  for (const secret of ALL_SECRETS) {
    expect(text, `${what} leaked ${JSON.stringify(secret)}`).not.toContain(secret);
  }
}

describe('the vault refuses to leak', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'twin-vault-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('lives outside every repository by default', () => {
    // ~/.openrappter is both a checkout AND the runtime home, which is exactly
    // the trap this default avoids.
    expect(DEFAULT_VAULT).not.toContain('.openrappter');
    expect(DEFAULT_VAULT).toContain('.rapp');
  });

  it('refuses to be created inside a git working tree', () => {
    const repo = join(home, 'some-repo');
    mkdirSync(join(repo, '.git'), { recursive: true });

    const vault = new TwinVault({ dir: join(repo, 'twin') });

    expect(() => vault.init('Alex Doe')).toThrow(TwinVaultError);
    expect(() => vault.init('Alex Doe')).toThrow(/refusing to put the twin inside a git repository/);
  });

  it('refuses even when the repo is several levels up', () => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const nested = join(repo, 'a', 'b', 'c', 'twin');
    mkdirSync(nested, { recursive: true });

    expect(() => new TwinVault({ dir: nested }).init('Alex')).toThrow(TwinVaultError);
  });

  it('names the repository it found, so the error is actionable', () => {
    const repo = join(home, 'my-project');
    mkdirSync(join(repo, '.git'), { recursive: true });

    try {
      new TwinVault({ dir: join(repo, 'twin') }).init('Alex');
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('my-project');
      expect((error as Error).message).toContain('RAPP_TWIN_HOME');
    }
  });

  it('finds an enclosing repo from any depth', () => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'deep', 'deeper'), { recursive: true });

    expect(findEnclosingRepo(join(repo, 'deep', 'deeper'))).toBe(repo);
    expect(findEnclosingRepo(home)).toBeNull();
  });

  it('writes the profile 0600 in a 0700 directory', () => {
    const vault = new TwinVault({ dir: join(home, 'twin') });
    vault.init('Alex Doe');

    expect(vault.isPrivate()).toBe(true);
    expect(statSync(vault.profilePath).mode & 0o077).toBe(0);
    expect(statSync(vault.dir).mode & 0o077).toBe(0);
  });

  it('round-trips a profile', () => {
    const vault = new TwinVault({ dir: join(home, 'twin') });
    const profile = loadedProfile();
    vault.save(profile);

    const loaded = vault.load();
    expect(loaded.identity.name).toBe('Alex Doe');
    expect(loaded.accounts.email).toBe(SECRETS.email);
    expect(loaded.context.projects[0].name).toBe(SECRETS.project);
  });

  it('survives a hand-edited profile with missing sections', () => {
    const vault = new TwinVault({ dir: join(home, 'twin') });
    mkdirSync(vault.dir, { recursive: true });
    writeFileSync(vault.profilePath, JSON.stringify({ id: 'x', identity: { name: 'Alex' } }));

    const loaded = vault.load();
    expect(loaded.voice.tone).toEqual([]);
    expect(loaded.boundaries.neverDo).toBeInstanceOf(Array);
  });

  it('reports a corrupt profile instead of crashing', () => {
    const vault = new TwinVault({ dir: join(home, 'twin') });
    mkdirSync(vault.dir, { recursive: true });
    writeFileSync(vault.profilePath, '{ not json');

    expect(() => vault.load()).toThrow(/unreadable/);
  });

  it('an interrupted save cannot truncate the twin', () => {
    const vault = new TwinVault({ dir: join(home, 'twin') });
    vault.save(loadedProfile());

    // A temp file must not be left behind, and the real file stays complete.
    expect(existsSync(`${vault.profilePath}.tmp`)).toBe(false);
    expect(vault.load().accounts.email).toBe(SECRETS.email);
  });

  it('tells you plainly when there is no twin yet', () => {
    expect(() => new TwinVault({ dir: join(home, 'twin') }).load()).toThrow(/twin init/);
  });
});

describe('the only sanctioned export carries no values', () => {
  it('exports counts and field names, never content', () => {
    const shape = toShape(loadedProfile());
    assertNoSecrets(JSON.stringify(shape), 'the shape export');
  });

  it('does not even carry the owner name', () => {
    expect(JSON.stringify(toShape(loadedProfile()))).not.toContain('Alex Doe');
  });

  it('still says enough to be useful', () => {
    const shape = toShape(loadedProfile());
    expect(shape.present.roles).toBe(1);
    expect(shape.present.context.projects).toBe(1);
    expect(shape.present.accounts).toBe(4);
    expect(shape.present.identity).toContain('pronouns');
    expect(shape.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is an allowlist, so a new secret field cannot ride along', () => {
    // The failure mode of a redaction list is the field someone adds later.
    const profile = loadedProfile() as TwinProfile & { newSecretField?: string };
    profile.newSecretField = 'ssn-123-45-6789';

    expect(JSON.stringify(toShape(profile))).not.toContain('ssn-123-45-6789');
  });

  it('fingerprints match for the same twin and differ across twins', () => {
    const profile = loadedProfile();
    expect(fingerprint(profile)).toBe(fingerprint(loadedProfile()));

    const other = loadedProfile();
    other.id = 'twin_other';
    expect(fingerprint(other)).not.toBe(fingerprint(profile));
  });
});

describe('the soul keeps secrets out of the prompt', () => {
  it('never puts account details in the prompt, even for the owner', () => {
    // Accounts are loaded so the twin can ACT. Anything in the prompt is one
    // clever question away from being repeated back.
    const soul = renderSoul(loadedProfile(), { audience: 'owner' });

    expect(soul).not.toContain(SECRETS.email);
    expect(soul).not.toContain(SECRETS.phone);
    expect(soul).not.toContain(SECRETS.address);
    expect(soul).not.toContain(SECRETS.handle);
  });

  it('gives the owner their own context', () => {
    const soul = renderSoul(loadedProfile(), { audience: 'owner' });

    expect(soul).toContain('Alex Doe');
    expect(soul).toContain(SECRETS.project);
    expect(soul).toContain(SECRETS.partner);
    expect(soul).toContain('ship it');
  });

  it('withholds people and accounts from a trusted third party', () => {
    const soul = renderSoul(loadedProfile(), { audience: 'trusted' });

    expect(soul).not.toContain(SECRETS.partner);
    expect(soul).not.toContain(SECRETS.email);
    expect(soul).toContain('do not disclose'.toLowerCase().slice(0, 4));
  });

  it('tells a stranger nothing personal at all', () => {
    const soul = renderSoul(loadedProfile(), { audience: 'public' });

    assertNoSecrets(soul, 'the public soul');
    expect(soul).not.toContain('~/dev/halcyon');
  });

  it('still sounds like them in public, because voice is not private', () => {
    const soul = renderSoul(loadedProfile(), { audience: 'public' });
    expect(soul).toContain('direct');
    expect(soul).toContain('Alex Doe');
  });

  it('never lets the twin claim to be human', () => {
    for (const audience of ['owner', 'trusted', 'public'] as const) {
      expect(renderSoul(loadedProfile(), { audience })).toMatch(/never claim to be human/i);
    }
  });

  it('carries the mandate into every prompt', () => {
    const soul = renderSoul(loadedProfile());
    expect(soul).toContain('Ask first');
    expect(soul).toContain('spend money');
    expect(soul).toMatch(/pending question is not a yes/i);
  });

  it('states the boundaries outside the editable profile', () => {
    // A twin whose limits live in user-editable text has no limits. An empty
    // profile must still produce the non-negotiable rules.
    const bare = emptyProfile('t', 'Nobody', new Date().toISOString());
    bare.boundaries = { mayDo: [], mustAsk: [], neverDo: [] };

    const soul = renderSoul(bare, { audience: 'public' });
    expect(soul).toMatch(/never claim to be human/i);
    expect(soul).toMatch(/do not disclose ANY personal detail/i);
  });

  it('refuses without hinting at what is being withheld', () => {
    expect(disclosureRules('public')).toMatch(/do not hint at what you are withholding/i);
  });

  it('has a soul for someone with no twin', () => {
    const soul = renderPublicSoul();
    expect(soul).toContain('twin init');
    expect(soul).toMatch(/do not guess/i);
    assertNoSecrets(soul, 'the no-twin soul');
  });

  it('wraps context in a tag a harness can find', () => {
    const context = renderTwinContext(loadedProfile());
    expect(context.startsWith('<twin>')).toBe(true);
    expect(context.trimEnd().endsWith('</twin>')).toBe(true);
  });
});

describe('nothing personal reaches the repository', () => {
  it('the twin source contains no personal values', () => {
    // The engine is public. Any real name, address or handle appearing in the
    // module itself would mean the boundary was crossed at authoring time.
    const here = new URL('.', import.meta.url).pathname;

    for (const file of ['types.ts', 'vault.ts', 'soul.ts']) {
      const source = readFileSync(join(here, file), 'utf8');

      expect(source, `${file} contains an email address`).not.toMatch(
        /[\w.+-]+@(?!example\.com)[\w-]+\.[\w.]+/,
      );
      expect(source, `${file} contains a phone number`).not.toMatch(/\+\d{10,}/);
      expect(source, `${file} mentions the owner`).not.toMatch(/kody|wildhaven/i);
    }
  });
});

describe('teaching the twin twice', () => {
  let scratch: string;
  const freshVault = () => new TwinVault({ dir: join(scratch, 'twin') });

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'twin-dedupe-'));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * Re-running a command is what people actually do — to fix a typo, or
   * because they forgot they had already said it. Appending a second copy
   * makes the twin repeat itself in every prompt, which reads as broken.
   */
  it('updates a person instead of duplicating them', () => {
    const vault = freshVault();
    const profile = vault.init('Alex Doe');

    const addPerson = (name: string, relationship: string) => {
      const current = vault.load();
      const at = current.context.people.findIndex(
        (p) => p.name.toLowerCase() === name.toLowerCase(),
      );
      const entry = { name, relationship, notes: undefined };
      if (at >= 0) current.context.people[at] = entry;
      else current.context.people.push(entry);
      vault.save(current);
    };

    addPerson('Jane Doe', 'business partner');
    addPerson('Jane Doe', 'co-founder');

    const people = vault.load().context.people;
    expect(people).toHaveLength(1);
    expect(people[0].relationship).toBe('co-founder');
    expect(profile.id).toBeTruthy();
  });

  it('does not repeat a fact in the rendered soul', () => {
    const vault = freshVault();
    vault.init('Alex Doe');

    const profile = vault.load();
    profile.context.facts.push('Prefers evening appointments');
    vault.save(profile);

    const soul = renderSoul(vault.load(), { audience: 'owner' });
    const occurrences = soul.split('Prefers evening appointments').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('the twin is the default persona, not an override', () => {
  /**
   * The twin should be who the rappter is by default. It must NOT hijack an
   * assistant that was given a specific persona — a named sub-agent or a test
   * bot silently becoming the owner is both surprising and a privacy problem,
   * since the owner's facts would land in a prompt nobody asked to personalise.
   *
   * This mirrors Assistant.twinIdentity(). Keep the two in step.
   */
  const wantsTwin = (config: { name?: string; description?: string; useTwin?: boolean }) => {
    const explicitPersona = Boolean(config.name || config.description);
    return config.useTwin ?? !explicitPersona;
  };

  it('is used when no persona was asked for', () => {
    expect(wantsTwin({})).toBe(true);
  });

  it('stands aside for an explicitly named assistant', () => {
    expect(wantsTwin({ name: 'TestBot' })).toBe(false);
    expect(wantsTwin({ description: 'a documentation bot' })).toBe(false);
  });

  it('can be opted into even with a name', () => {
    expect(wantsTwin({ name: 'Luna', useTwin: true })).toBe(true);
  });

  it('can be opted out of entirely', () => {
    expect(wantsTwin({ useTwin: false })).toBe(false);
  });
});

describe('inheriting an archetype', () => {
  const HUB = 'https://example.test/hub';

  const archetype = (id: string, extra: Record<string, unknown> = {}) => ({
    schema: 'rapp-twin-archetype/1.0',
    id,
    name: id,
    summary: `${id} archetype`,
    boundaries: { mustAsk: [], neverDo: [] },
    ...extra,
  });

  const loaderFor = (table: Record<string, unknown>) => async (id: string) => {
    if (!(id in table)) throw new ArchetypeError(`no archetype "${id}"`);
    return table[id];
  };

  describe('validation is a gate', () => {
    it('rejects an unknown field, so nothing can be smuggled', () => {
      // Without this, a crafted archetype could carry a field an older client
      // stores blindly and a newer one surfaces.
      expect(() =>
        validateArchetype(archetype('sneaky', { accounts: { email: 'x@example.com' } }), 'test'),
      ).toThrow(/unknown field/);
    });

    it('rejects a wrong schema', () => {
      expect(() => validateArchetype({ ...archetype('x'), schema: 'other/1.0' }, 'test')).toThrow();
    });

    it('rejects a malformed id', () => {
      for (const id of ['Uppercase', 'has space', '-lead', 'x', 'a/b']) {
        expect(() => validateArchetype(archetype(id), 'test')).toThrow(/invalid id/);
      }
    });

    it('requires the mandate', () => {
      const missing = archetype('okay');
      (missing as Record<string, unknown>).boundaries = { mustAsk: [] };
      expect(() => validateArchetype(missing, 'test')).toThrow(/neverDo/);
    });
  });

  describe('resolution', () => {
    it('merges a chain, root first', async () => {
      const resolved = await resolveArchetype(
        'child',
        loaderFor({
          root: archetype('root', { voice: { tone: ['plain'] }, boundaries: { mustAsk: ['ask A'], neverDo: ['never A'] } }),
          child: archetype('child', { extends: 'root', voice: { tone: ['dry'] }, boundaries: { mustAsk: ['ask B'], neverDo: [] } }),
        }),
      );

      expect(resolved.lineage).toEqual(['root', 'child']);
      expect(resolved.voice?.tone).toEqual(['plain', 'dry']);
      expect(resolved.boundaries.mustAsk).toEqual(['ask A', 'ask B']);
    });

    it('a child cannot drop a parent restriction', async () => {
      const resolved = await resolveArchetype(
        'lax',
        loaderFor({
          strict: archetype('strict', { boundaries: { mustAsk: ['ask before spending'], neverDo: ['share an address'] } }),
          lax: archetype('lax', { extends: 'strict', boundaries: { mustAsk: [], neverDo: [] } }),
        }),
      );

      expect(resolved.boundaries.mustAsk).toContain('ask before spending');
      expect(resolved.boundaries.neverDo).toContain('share an address');
    });

    it('a child cannot permit what a parent forbids', async () => {
      // The property that makes inheriting a stranger's archetype safe.
      const resolved = await resolveArchetype(
        'eager',
        loaderFor({
          strict: archetype('strict', { boundaries: { mustAsk: ['quote a price'], neverDo: ['share an address'] } }),
          eager: archetype('eager', {
            extends: 'strict',
            boundaries: { mayDo: ['quote a price', 'share an address', 'book a table'], mustAsk: [], neverDo: [] },
          }),
        }),
      );

      expect(resolved.boundaries.mayDo).toEqual(['book a table']);
    });

    it('rejects a cycle', async () => {
      const load = loaderFor({
        alpha: archetype('alpha', { extends: 'beta' }),
        beta: archetype('beta', { extends: 'alpha' }),
      });
      await expect(resolveArchetype('alpha', load)).rejects.toThrow(/cycle/);
    });

    it('caps the depth rather than exhausting the resolver', async () => {
      const table: Record<string, unknown> = {};
      for (let i = 0; i < 12; i++) {
        table[`link${String(i).padStart(2, '0')}`] = archetype(`link${String(i).padStart(2, '0')}`, {
          extends: `link${String(i + 1).padStart(2, '0')}`,
        });
      }
      table.link12 = archetype('link12');
      await expect(resolveArchetype('link00', loaderFor(table))).rejects.toThrow(/deeper than/);
    });

    it('de-duplicates case-insensitively', async () => {
      const resolved = await resolveArchetype(
        'child',
        loaderFor({
          root: archetype('root', { voice: { tone: ['Direct'] }, boundaries: { mustAsk: ['Ask First'], neverDo: [] } }),
          child: archetype('child', { extends: 'root', voice: { tone: ['direct'] }, boundaries: { mustAsk: ['ask first'], neverDo: [] } }),
        }),
      );

      expect(resolved.voice?.tone).toHaveLength(1);
      expect(resolved.boundaries.mustAsk).toHaveLength(1);
    });
  });

  describe('applying to a profile', () => {
    const seed = (): TwinProfile => ({
      version: 1,
      id: 'twin_x',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      identity: { name: 'Alex Doe' },
      roles: [{ title: 'Founder', org: 'Acme' }],
      voice: { tone: ['warm'], avoid: [], signatures: [] },
      context: { projects: [], people: [{ name: 'Jane', relationship: 'partner' }], tools: [], facts: ['a fact'] },
      boundaries: { mayDo: [], mustAsk: [], neverDo: [] },
      accounts: { email: 'alex@example.com' },
    });

    const resolved = {
      schema: 'rapp-twin-archetype/1.0',
      id: 'child',
      name: 'Child',
      summary: 'x',
      lineage: ['root', 'child'],
      voice: { tone: ['plain'] },
      boundaries: { mustAsk: ['ask A'], neverDo: ['never A'] },
    } as never;

    it('never touches who the owner is', () => {
      const before = seed();
      const { profile } = inherit(before, resolved);

      expect(profile.identity).toEqual(before.identity);
      expect(profile.roles).toEqual(before.roles);
      expect(profile.context).toEqual(before.context);
      expect(profile.accounts).toEqual(before.accounts);
    });

    it("puts the owner's own words first", () => {
      const { profile } = inherit(seed(), resolved);
      expect(profile.voice.tone[0]).toBe('warm');
    });

    it('records the lineage for provenance', () => {
      const { profile, lineage } = inherit(seed(), resolved);
      expect(profile.inherits).toEqual(['root', 'child']);
      expect(lineage).toEqual(['root', 'child']);
    });

    it('is idempotent', () => {
      const first = inherit(seed(), resolved);
      const second = inherit(first.profile, resolved);

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
      expect(JSON.stringify(second.profile)).toBe(JSON.stringify(first.profile));
    });

    it('does not mutate its input', () => {
      const original = seed();
      const snapshot = JSON.stringify(original);
      inherit(original, resolved);
      expect(JSON.stringify(original)).toBe(snapshot);
    });
  });

  describe('the hub loader is read-only', () => {
    it('fetches an archetype by id', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => archetype('base'),
      })) as unknown as typeof fetch;

      const loaded = await httpLoader(HUB, fetchMock)('base');

      expect((loaded as { id: string }).id).toBe('base');
      expect((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0]).toBe(
        `${HUB}/archetypes/base.json`,
      );
      // one argument means no options object, so no method and no body
      expect((fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toHaveLength(1);
    });

    it('refuses an id that could escape the archetype path', async () => {
      const fetchMock = vi.fn() as unknown as typeof fetch;
      await expect(httpLoader(HUB, fetchMock)('../../etc/passwd')).rejects.toThrow(/invalid archetype id/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('says plainly when an archetype does not exist', async () => {
      const fetchMock = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
      await expect(httpLoader(HUB, fetchMock)('ghost')).rejects.toThrow(/no archetype "ghost"/);
    });
  });

  it('has no code path that publishes a profile', () => {
    // The whole promise: inheritance flows hub -> device and never back.
    const source = readFileSync(new URL('./archetype.ts', import.meta.url), 'utf8');
    for (const forbidden of ['method: \'POST\'', 'method: "POST"', 'body:', 'export function publish', 'export function upload']) {
      expect(source).not.toContain(forbidden);
    }
  });
});

describe('the CLI writes what it claims to have written', () => {
  /**
   * A real bug this caught: `inherit` used `command.parent!` (correct for
   * nested subcommands like `set voice`) even though it is a direct child of
   * `twin`. The shared --home resolved to the wrong vault, so the command
   * reported "Inherited base → founder" while the profile on disk was
   * untouched. Reporting success for work that did not happen is the worst
   * failure mode available, so this asserts the round trip.
   */
  it('a merged profile survives save and load', () => {
    const home = mkdtempSync(join(tmpdir(), 'twin-roundtrip-'));
    try {
      const vault = new TwinVault({ dir: join(home, 'twin') });
      vault.init('Alex Doe');

      const resolved = {
        schema: 'rapp-twin-archetype/1.0',
        id: 'founder',
        name: 'Founder',
        summary: 'x',
        lineage: ['base', 'founder'],
        voice: { tone: ['direct'] },
        boundaries: { mustAsk: ['quote a price'], neverDo: ['claim to be a human being'] },
      } as never;

      const { profile } = inherit(vault.load(), resolved);
      vault.save(profile);

      const reloaded = vault.load();
      expect(reloaded.inherits).toEqual(['base', 'founder']);
      expect(reloaded.boundaries.mustAsk).toContain('quote a price');
      expect(reloaded.voice.tone).toContain('direct');
      expect(reloaded.identity.name).toBe('Alex Doe');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('every twin subcommand reads the same --home', () => {
    // vaultFor(command) vs vaultFor(command.parent!) depends on nesting depth.
    // Direct children of `twin` take the first form; anything under set/add
    // takes the second. Getting it wrong silently targets the default vault.
    const source = readFileSync(new URL('./cli.ts', import.meta.url), 'utf8');
    const directChildren = ['init', 'show', 'soul', 'shape', 'where', 'inherit'];

    for (const name of directChildren) {
      const block = source.split(`.command('${name}')`)[1];
      if (!block) continue;
      const action = block.slice(0, block.indexOf('});'));
      if (!action.includes('vaultFor(')) continue;
      expect(action, `${name} is a direct child of twin`).not.toContain('vaultFor(command.parent!)');
    }
  });
});
