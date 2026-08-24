import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packRappEgg, readAndVerifyRappEgg, sha256 } from './archive.js';
import { LocalOrganismAdapter } from './inventory.js';
import { generateOrganismTheme, validateMidi } from './midi.js';
import { OrganismEggService } from './service.js';
import type {
  EggStateAdapter,
  ExportEggOptions,
  InventoryFile,
  InventoryResult,
} from './types.js';
import { XPeditionEggAdapter } from './xpedition.js';

const ROOT = path.resolve('.test-output', 'organism-egg');
const CREATED = '2026-08-23T20:00:00.000Z';
const RAPPID = `rappid:@openrappter/organism:${'a'.repeat(64)}`;
const PASSPHRASE = 'synthetic-only-passphrase';

function file(
  filePath: string,
  value: string | Uint8Array,
  dimension = 'state',
  mime = 'application/json',
): InventoryFile {
  return {
    path: filePath,
    bytes: typeof value === 'string' ? Buffer.from(value) : value,
    mime,
    dimension,
    privacy: 'private',
    provenance: { origin: 'synthetic-fixture', license: 'Apache-2.0', owned: true },
  };
}

function syntheticFiles(): InventoryFile[] {
  return [
    file('agents/helper_agent.js', 'export const inert = true;\n', 'agents', 'text/javascript'),
    file('agents/lineage.jsonl', '{"generation":2,"parent":"fixture"}\n', 'agents', 'application/x-ndjson'),
    file('skills/example/SKILL.md', '# Synthetic skill\n', 'skills', 'text/markdown'),
    file('state/memory.json', '{"facts":["synthetic"]}\n', 'memory'),
    file('state/cron.json', '{"jobs":[{"id":"synthetic"}]}\n', 'state'),
    file('state/sessions.db', Buffer.from('synthetic session fixture'), 'sessions', 'application/vnd.sqlite3'),
    file('media/sounds/ping.wav', Buffer.from('RIFFsynthetic'), 'media', 'audio/wav'),
    file('media/generated/existing.mid', generateOrganismTheme(`${RAPPID}:existing`), 'midi', 'audio/midi'),
    file('media/generated/organism-theme.mid', generateOrganismTheme(RAPPID), 'midi', 'audio/midi'),
  ];
}

class SyntheticAdapter implements EggStateAdapter {
  files = syntheticFiles();
  rappid = RAPPID;
  applyCount = 0;
  failNextHealth = false;

  async inventory(): Promise<InventoryResult> {
    return {
      rappid: this.rappid,
      files: this.files.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) })),
      dimensions: {
        agents: 2,
        skills: 1,
        memories: 1,
        cronJobs: 1,
        sessions: 1,
        media: 1,
        midi: 2,
      },
      exclusions: ['credentials and external mailbox contents'],
      reauthentication: ['GitHub Copilot'],
    };
  }

  async apply(files: InventoryFile[]): Promise<void> {
    this.applyCount += 1;
    this.files = files.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) }));
  }

  async healthProbe(): Promise<{ ok: boolean; detail: string }> {
    if (this.failNextHealth) {
      this.failNextHealth = false;
      return { ok: false, detail: 'synthetic contract failure' };
    }
    return { ok: true, detail: 'synthetic contracts healthy' };
  }
}

function options(output: string, mode: 'portable' | 'sealed-backup'): ExportEggOptions {
  return {
    mode,
    output,
    ...(mode === 'sealed-backup' ? { passphrase: PASSPHRASE } : {}),
    includeHistory: true,
    includeMedia: true,
    createdUtc: CREATED,
    sourceVersion: '1.13.0-test',
    sourceCommit: 'a'.repeat(40),
    sourceRing: 'synthetic',
  };
}

describe('OpenRappter organism eggs', () => {
  beforeEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
  });

  it('exports byte-deterministic portable RAPP/1 eggs with exact root/file digests', async () => {
    const adapter = new SyntheticAdapter();
    const service = new OrganismEggService(adapter, path.join(ROOT, 'runtime'));
    const first = await service.export(options(path.join(ROOT, 'first.egg'), 'portable'));
    const second = await service.export(options(path.join(ROOT, 'second.egg'), 'portable'));
    const firstBytes = fs.readFileSync(first.output);
    const secondBytes = fs.readFileSync(second.output);

    expect(firstBytes.equals(secondBytes)).toBe(true);
    expect(first.digest).toBe(sha256(firstBytes));
    expect(first.manifest.profile).toBe('openrappter-organism-egg/1.0');
    expect(first.manifest.files).toHaveLength(9);
    expect(first.manifest.dimensions.midi).toBe(2);
    expect(fs.statSync(first.output).mode & 0o077).toBe(0);
    expect(readAndVerifyRappEgg(firstBytes).manifest.schema).toBe('rapp/1-egg');
  });

  it('round-trips sealed eggs and refuses wrong passphrases and tampering', async () => {
    const service = new OrganismEggService(new SyntheticAdapter(), path.join(ROOT, 'runtime'));
    const result = await service.export(options(path.join(ROOT, 'sealed.egg'), 'sealed-backup'));

    const opaque = service.inspect(result.output);
    expect(opaque.sealed).toBe(true);
    expect(opaque.decrypted).toBe(false);
    expect(opaque.manifest).toBeUndefined();
    expect(() => service.inspect(result.output, 'wrong-passphrase-value')).toThrow(/authentication failed/);
    expect(service.inspect(result.output, PASSPHRASE).files).toHaveLength(9);

    const tampered = fs.readFileSync(result.output);
    tampered[Math.floor(tampered.length / 2)] ^= 0x01;
    expect(() => service.inspectBytes(tampered, PASSPHRASE)).toThrow();
  });

  it('diffs and previews without mutation, then applies only an exact human approval', async () => {
    const adapter = new SyntheticAdapter();
    const service = new OrganismEggService(adapter, path.join(ROOT, 'runtime'));
    const exported = await service.export(options(path.join(ROOT, 'restore.egg'), 'portable'));
    adapter.files[0] = file('agents/helper_agent.js', 'changed\n', 'agents', 'text/javascript');
    const beforePreview = Buffer.from(adapter.files[0].bytes);

    const preview = await service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: false,
    });
    expect(preview.applied).toBe(false);
    expect(adapter.applyCount).toBe(0);
    expect(Buffer.from(adapter.files[0].bytes).equals(beforePreview)).toBe(true);

    await expect(service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: true,
      approval: 'b'.repeat(64),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/action-bound approval/);
    expect(adapter.applyCount).toBe(0);

    const applied = await service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: true,
      approval: preview.preview.approvalBinding,
      rollbackPassphrase: PASSPHRASE,
    });
    expect(applied.applied).toBe(true);
    expect(Buffer.from(adapter.files[0].bytes).toString()).toContain('inert = true');
    expect(applied.rollbackEgg).toMatch(/rollback-.*\.egg$/);
  });

  it('rolls back exact prior state and quarantines an egg when a health contract fails', async () => {
    const adapter = new SyntheticAdapter();
    const service = new OrganismEggService(adapter, path.join(ROOT, 'runtime'));
    const exported = await service.export(options(path.join(ROOT, 'failure.egg'), 'portable'));
    adapter.files = [file('state/memory.json', '{"before":"exact"}\n', 'memory')];
    const before = adapter.files.map((entry) => Buffer.from(entry.bytes).toString('hex'));
    const preview = await service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: false,
    });
    adapter.failNextHealth = true;

    await expect(service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: true,
      approval: preview.preview.approvalBinding,
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/health probe/);
    expect(adapter.files.map((entry) => Buffer.from(entry.bytes).toString('hex'))).toEqual(before);
    expect(fs.readdirSync(path.join(ROOT, 'runtime', 'quarantine'))).toHaveLength(1);
  });

  it('refuses stale approvals after base state changes and rejects symlink egg inputs', async () => {
    const adapter = new SyntheticAdapter();
    const service = new OrganismEggService(adapter, path.join(ROOT, 'runtime'));
    const exported = await service.export(options(path.join(ROOT, 'approval.egg'), 'portable'));
    adapter.files[0] = file('agents/helper_agent.js', 'first change\n', 'agents', 'text/javascript');
    const preview = await service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: false,
    });
    adapter.files[0] = file('agents/helper_agent.js', 'changed after preview\n', 'agents', 'text/javascript');
    await expect(service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: true,
      approval: preview.preview.approvalBinding,
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/action-bound approval/);
    expect(adapter.applyCount).toBe(0);

    const link = path.join(ROOT, 'linked.egg');
    fs.symlinkSync(exported.output, link);
    expect(() => service.inspect(link)).toThrow(/symlink/);
  });

  it('keeps imported code inert and blocks semantic-control apply', async () => {
    (globalThis as Record<string, unknown>).eggExecuted = false;
    const adapter = new SyntheticAdapter();
    adapter.files[0] = file(
      'agents/hostile_agent.js',
      'globalThis.eggExecuted = true; throw new Error("executed");\n',
      'agents',
      'text/javascript',
    );
    const service = new OrganismEggService(adapter, path.join(ROOT, 'runtime'));
    const exported = await service.export(options(path.join(ROOT, 'inert.egg'), 'portable'));
    expect(service.inspect(exported.output).valid).toBe(true);
    expect((globalThis as Record<string, unknown>).eggExecuted).toBe(false);
    const seam = new XPeditionEggAdapter(service);
    await expect(seam.apply({
      eggPath: exported.output,
      semantics: 'restore',
      apply: true,
      approval: 'irrelevant',
      rollbackPassphrase: PASSPHRASE,
    }, 'semantic-control')).rejects.toThrow(/cannot approve or apply/);
  });

  it('generates deterministic valid royalty-free MIDI from the RAPPID', () => {
    const first = generateOrganismTheme(RAPPID, { temperament: 'curious' });
    const second = generateOrganismTheme(RAPPID, { temperament: 'curious' });
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    expect(() => validateMidi(first)).not.toThrow();
    expect(Buffer.from(first).subarray(0, 4).toString('ascii')).toBe('MThd');
  });

  it('refuses path, Unicode/case collisions, duplicate floods, and portable secret shapes', async () => {
    expect(() => packRappEgg({
      rappid: RAPPID,
      createdUtc: CREATED,
      files: { '../escape': Buffer.from('x') },
      payload: {},
    })).toThrow(/Unsafe egg path/);
    expect(() => packRappEgg({
      rappid: RAPPID,
      createdUtc: CREATED,
      files: { 'State/File': Buffer.from('x'), 'state/file': Buffer.from('y') },
      payload: {},
    })).toThrow(/Case-colliding/);
    expect(() => packRappEgg({
      rappid: RAPPID,
      createdUtc: CREATED,
      files: Object.fromEntries(Array.from({ length: 5_001 }, (_, index) => [`files/${index}`, Buffer.from('x')])),
      payload: {},
    })).toThrow(/file-count/);

    const adapter = new SyntheticAdapter();
    adapter.files.push(file('state/leak.txt', 'access_token=ghp_abcdefghijklmnopqrstuvwxyz1234567890', 'state', 'text/plain'));
    await expect(new OrganismEggService(adapter).export(
      options(path.join(ROOT, 'leak.egg'), 'portable'),
    )).rejects.toThrow(/secret-shape scan/);
  });

  it('takes a live SQLite WAL snapshot and inventories lineage while excluding unknown-license media', async () => {
    const module = await import('better-sqlite3');
    const Database = module.default as unknown as new (
      filename: string,
      options?: { readonly?: boolean },
    ) => {
      pragma(value: string): unknown;
      exec(value: string): void;
      prepare(value: string): { pluck(): { get(): unknown } };
      close(): void;
    };
    const home = path.join(ROOT, 'home');
    fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(home, 'sounds'), { recursive: true });
    fs.writeFileSync(path.join(home, 'rappid.tail'), `${'1'.repeat(64)}\n`);
    fs.writeFileSync(path.join(home, 'agents', 'lineage.jsonl'), '{"generation":1}\n');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      channels: { slack: { token: 'not-exported', enabled: true } },
    }));
    fs.writeFileSync(path.join(home, 'sounds', 'unknown.wav'), 'RIFFfixture');
    const existingMidi = generateOrganismTheme(`${RAPPID}:local-existing`);
    fs.writeFileSync(path.join(home, 'sounds', 'existing.mid'), existingMidi);
    fs.writeFileSync(path.join(home, 'sounds', 'existing.mid.license.json'), JSON.stringify({
      origin: 'synthetic generator',
      license: 'CC0-1.0',
      owned: true,
    }));
    const databasePath = path.join(home, 'openrappter.db');
    const database = new Database(databasePath);
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE facts(value TEXT);
      INSERT INTO facts VALUES ('wal-visible');
      CREATE TABLE credentials(token TEXT);
      INSERT INTO credentials VALUES ('ghp_abcdefghijklmnopqrstuvwxyz1234567890');
    `);

    const adapter = new LocalOrganismAdapter(home);
    const inventory = await adapter.inventory({
      includeHistory: false,
      includeMedia: true,
      acknowledgeUnknownLicense: false,
    });
    database.close();

    expect(inventory.files.some((entry) => entry.path === 'agents/lineage.jsonl')).toBe(true);
    expect(inventory.files.some((entry) => entry.path.endsWith('unknown.wav'))).toBe(false);
    const includedMidi = inventory.files.find((entry) => entry.path.endsWith('existing.mid'));
    expect(Buffer.from(includedMidi?.bytes ?? new Uint8Array()).equals(Buffer.from(existingMidi))).toBe(true);
    expect(inventory.exclusions.join(' ')).toContain('license not acknowledged');
    const config = inventory.files.find((entry) => entry.path === 'state/config.json');
    expect(Buffer.from(config?.bytes ?? []).toString()).not.toContain('not-exported');
    const snapshot = inventory.files.find((entry) => entry.path === 'state/openrappter.db');
    expect(snapshot?.bytes.length).toBeGreaterThan(0);
    const snapshotPath = path.join(ROOT, 'snapshot.db');
    fs.writeFileSync(snapshotPath, snapshot?.bytes ?? new Uint8Array());
    const copied = new Database(snapshotPath, { readonly: true });
    expect(copied.prepare('SELECT value FROM facts').pluck().get()).toBe('wal-visible');
    expect(copied.prepare('SELECT count(*) FROM credentials').pluck().get()).toBe(0);
    copied.close();

    const acknowledged = await adapter.inventory({
      includeHistory: false,
      includeMedia: true,
      acknowledgeUnknownLicense: true,
    });
    expect(acknowledged.files.some((entry) => entry.path.endsWith('unknown.wav'))).toBe(true);

    const oversized = path.join(home, 'sounds', 'oversized.wav');
    fs.writeFileSync(oversized, '');
    fs.truncateSync(oversized, 64 * 1024 * 1024 + 1);
    fs.writeFileSync(`${oversized}.license.json`, JSON.stringify({
      origin: 'synthetic sparse fixture',
      license: 'CC0-1.0',
      owned: true,
    }));
    await expect(adapter.inventory({
      includeHistory: false,
      includeMedia: true,
      acknowledgeUnknownLicense: true,
    })).rejects.toThrow(/not a supported regular file/);
  });

  it('restores a synthetic local organism exactly without replacing its identity seed', async () => {
    const home = path.join(ROOT, 'restore-home');
    fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'rappid.tail'), `${'7'.repeat(64)}\n`);
    fs.writeFileSync(path.join(home, 'memory.json'), '{"version":1}\n');
    fs.writeFileSync(path.join(home, 'agents', 'lineage.jsonl'), '{"generation":1}\n');
    const service = new OrganismEggService(
      new LocalOrganismAdapter(home),
      path.join(home, 'egg-runtime'),
    );
    const exported = await service.export(options(path.join(ROOT, 'local-restore.egg'), 'portable'));
    fs.writeFileSync(path.join(home, 'memory.json'), '{"version":2}\n');
    fs.writeFileSync(path.join(home, 'agents', 'extra_agent.js'), 'export const extra = true;\n');
    const preview = await service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: false,
    });
    await service.import({
      eggPath: exported.output,
      semantics: 'restore',
      apply: true,
      approval: preview.preview.approvalBinding,
      rollbackPassphrase: PASSPHRASE,
    });
    expect(fs.readFileSync(path.join(home, 'memory.json'), 'utf8')).toBe('{"version":1}\n');
    expect(fs.existsSync(path.join(home, 'agents', 'extra_agent.js'))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'rappid.tail'), 'utf8')).toBe(`${'7'.repeat(64)}\n`);
  });
});
