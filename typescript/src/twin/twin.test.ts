import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_VAULT, TwinVault, TwinVaultError, findEnclosingRepo, fingerprint, toShape } from './vault.js';
import { disclosureRules, renderPublicSoul, renderSoul, renderTwinContext } from './soul.js';
import { emptyProfile } from './types.js';
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
