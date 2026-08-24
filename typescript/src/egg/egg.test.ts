import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, packRappEgg, readAndVerifyRappEgg, sha256 } from './archive.js';
import { LocalOrganismAdapter } from './inventory.js';
import { generateOrganismTheme, validateMidi } from './midi.js';
import { OrganismEggService } from './service.js';
import type {
  EggApplyReceipt,
  EggDiff,
  EggStateAdapter,
  ExportEggOptions,
  InventoryFile,
  InventoryResult,
} from './types.js';
import { XPeditionEggAdapter } from './xpedition.js';
import { withOrganismSnapshotFence } from '../infra/organism-maintenance.js';

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
    mode: 0o600,
    mtimeMs: 0,
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
  private generations = new Map<string, InventoryFile[]>();

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
      epoch: 'synthetic-epoch',
    };
  }

  async withSnapshotFence<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async validateStaged(): Promise<void> {}

  async apply(
    files: InventoryFile[],
    context: { expectedStateDigest: string },
  ): Promise<EggApplyReceipt> {
    this.applyCount += 1;
    const generation = `synthetic-${this.applyCount}`;
    this.generations.set(generation, this.files);
    this.files = files.map((entry) => ({ ...entry, bytes: Buffer.from(entry.bytes) }));
    return { generation, stateDigest: context.expectedStateDigest };
  }

  async commit(receipt: EggApplyReceipt): Promise<void> {
    this.generations.delete(receipt.generation);
  }

  async rollback(receipt: EggApplyReceipt): Promise<void> {
    const prior = this.generations.get(receipt.generation);
    if (!prior) throw new Error('synthetic rollback missing');
    this.files = prior;
    this.generations.delete(receipt.generation);
  }

  async healthProbe(): Promise<{ ok: boolean; detail: string }> {
    if (this.failNextHealth) {
      this.failNextHealth = false;
      return { ok: false, detail: 'synthetic contract failure' };
    }
    return { ok: true, detail: 'synthetic contracts healthy' };
  }
}

function approved(preview: EggDiff): Pick<
  import('./types.js').ImportEggOptions,
  'approval' | 'previewHandle' | 'nonce' | 'targetRappid'
> {
  return {
    approval: preview.approvalBinding,
    previewHandle: preview.previewHandle,
    nonce: preview.nonce,
    targetRappid: preview.targetRappid,
  };
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
      semantics: 'clone',
      apply: false,
    });
    expect(preview.applied).toBe(false);
    expect(adapter.applyCount).toBe(0);
    expect(Buffer.from(adapter.files[0].bytes).equals(beforePreview)).toBe(true);
    if (process.platform !== 'win32') {
      expect(
        fs.statSync(path.join(
          service.runtimeDir,
          'previews',
          `${preview.preview.previewHandle}.egg`,
        )).mode & 0o077,
      ).toBe(0);
    }

    await expect(service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      approval: 'b'.repeat(64),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/does not match preview/);
    expect(adapter.applyCount).toBe(0);

    const applied = await service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
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
      semantics: 'clone',
      apply: false,
    });
    adapter.failNextHealth = true;

    await expect(service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
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
      semantics: 'clone',
      apply: false,
    });
    adapter.files[0] = file('agents/helper_agent.js', 'changed after preview\n', 'agents', 'text/javascript');
    await expect(service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/changed after preview/);
    expect(adapter.applyCount).toBe(0);
    await expect(service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/ENOENT|consumed|preview/i);

    const link = path.join(ROOT, 'linked.egg');
    fs.symlinkSync(exported.output, link);
    expect(() => service.inspect(link)).toThrow(/symlink/);
    const hardlink = path.join(ROOT, 'hardlinked.egg');
    fs.linkSync(exported.output, hardlink);
    expect(() => service.inspect(hardlink)).toThrow(/bounded regular file/);
  });

  it('pins immutable preview bytes, target and nonce, then consumes approval once', async () => {
    const adapter = new SyntheticAdapter();
    const service = new OrganismEggService(adapter, path.join(ROOT, 'runtime'));
    const first = await service.export(options(path.join(ROOT, 'pinned.egg'), 'portable'));
    adapter.files[0] = file('agents/helper_agent.js', 'live changed\n', 'agents', 'text/javascript');
    const preview = await service.import({
      eggPath: first.output,
      semantics: 'clone',
      apply: false,
    });
    const originalDigest = preview.preview.eggDigest;
    fs.writeFileSync(first.output, Buffer.from('path swapped after preview'));

    await expect(service.import({
      eggPath: first.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      targetRappid: `${RAPPID.slice(0, -1)}b`,
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/does not match preview/);

    const applied = await service.import({
      eggPath: first.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      rollbackPassphrase: PASSPHRASE,
    });
    expect(applied.preview.eggDigest).toBe(originalDigest);
    expect(Buffer.from(adapter.files[0].bytes).toString()).toContain('inert = true');
    await expect(service.import({
      eggPath: first.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/ENOENT|consumed|preview/i);
  });

  it('makes portable eggs clone-only and keeps identity seeds sealed', async () => {
    const home = path.join(ROOT, 'identity-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'rappid.tail'), `${'8'.repeat(64)}\n`);
    fs.writeFileSync(path.join(home, 'rappid.body.json'), '{"traits":["safe"]}\n');
    const service = new OrganismEggService(new LocalOrganismAdapter(home), path.join(ROOT, 'identity-runtime'));
    const portable = await service.export(options(path.join(ROOT, 'identity-portable.egg'), 'portable'));
    const portableInspection = service.inspect(portable.output);
    expect(portableInspection.files?.some((entry) => entry.path === 'state/rappid.tail')).toBe(false);
    const restorePreview = await service.import({
      eggPath: portable.output,
      semantics: 'restore',
      apply: false,
    });
    expect(restorePreview.preview.compatible).toBe(false);
    await expect(service.import({
      eggPath: portable.output,
      semantics: 'restore',
      apply: true,
      ...approved(restorePreview.preview),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/clone-only/);

    const sealed = await service.export(options(path.join(ROOT, 'identity-sealed.egg'), 'sealed-backup'));
    expect(service.inspect(sealed.output, PASSPHRASE).files).toContainEqual(
      expect.objectContaining({ path: 'state/rappid.tail', privacy: 'sensitive-encrypted' }),
    );
    fs.writeFileSync(path.join(home, 'rappid.body.json'), '{"traits":["changed"]}\n');
    const sealedPreview = await service.import({
      eggPath: sealed.output,
      passphrase: PASSPHRASE,
      semantics: 'restore',
      apply: false,
    });
    expect(sealedPreview.preview.compatible).toBe(true);
    await service.import({
      eggPath: sealed.output,
      passphrase: PASSPHRASE,
      semantics: 'restore',
      apply: true,
      ...approved(sealedPreview.preview),
      rollbackPassphrase: PASSPHRASE,
    });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'rappid.body.json'), 'utf8'))).toEqual({
      traits: ['safe'],
    });

    const unsafe = new SyntheticAdapter();
    unsafe.files.push(file('resources/device-key.json', '{"public":"still identity-bound"}\n'));
    await expect(new OrganismEggService(unsafe, path.join(ROOT, 'unsafe-identity-runtime')).export(
      options(path.join(ROOT, 'unsafe-identity.egg'), 'portable'),
    )).rejects.toThrow(/identity seed/);
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
      semantics: 'clone',
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
    const shapedSecret = `${['access', 'token'].join('_')}=${[
      'ghp',
      'abcdefghijklmnopqrstuvwxyz1234567890',
    ].join('_')}`;
    adapter.files.push(file('state/leak.txt', shapedSecret, 'state', 'text/plain'));
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
    const databaseSecret = [
      'ghp',
      'abcdefghijklmnopqrstuvwxyz1234567890',
    ].join('_');
    database.exec(`
      CREATE TABLE facts(value TEXT);
      INSERT INTO facts VALUES ('wal-visible');
      CREATE TABLE credentials(token TEXT);
      INSERT INTO credentials VALUES ('${databaseSecret}');
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

  it('structurally redacts camelCase secrets across JSON5, YAML and TOML and fails closed on SQLite blobs', async () => {
    const home = path.join(ROOT, 'structured-secret-home');
    fs.mkdirSync(path.join(home, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(home, 'rappid.tail'), `${'9'.repeat(64)}\n`);
    const secret = ['fixture', 'credential', 'value', 'long'].join('-');
    fs.writeFileSync(path.join(home, 'config.json5'), `{ channels: { botToken: "${secret}" } }`);
    fs.writeFileSync(path.join(home, 'config.yaml'), `provider:\n  appPassword: ${secret}\n`);
    fs.writeFileSync(path.join(home, 'resources', 'client.toml'), `clientSecret = "${secret}"\n`);
    const adapter = new LocalOrganismAdapter(home);
    const inventory = await adapter.inventory({
      mode: 'portable',
      includeHistory: false,
      includeMedia: false,
      acknowledgeUnknownLicense: false,
    });
    for (const file of inventory.files.filter((entry) => /config|client/.test(entry.path))) {
      expect(Buffer.from(file.bytes).toString('utf8')).not.toContain(secret);
    }

    const module = await import('better-sqlite3');
    const Database = module.default as unknown as new (file: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(value: Buffer): unknown };
      close(): void;
    };
    const database = new Database(path.join(home, 'openrappter.db'));
    database.exec('CREATE TABLE payloads(value BLOB)');
    database.prepare('INSERT INTO payloads VALUES (?)').run(
      Buffer.from(`${['access', 'token'].join('_')}=${secret}`),
    );
    database.close();
    await expect(adapter.inventory({
      mode: 'portable',
      includeHistory: false,
      includeMedia: false,
      acknowledgeUnknownLicense: false,
    })).rejects.toThrow(/secret-shape scan/);
  });

  it('rejects hardlinks and sparse files before buffering an inventory', async () => {
    const hardlinkHome = path.join(ROOT, 'hardlink-home');
    fs.mkdirSync(path.join(hardlinkHome, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(hardlinkHome, 'rappid.tail'), `${'3'.repeat(64)}\n`);
    const source = path.join(hardlinkHome, 'agents', 'source.py');
    fs.writeFileSync(source, 'print("fixture")\n');
    fs.linkSync(source, path.join(hardlinkHome, 'agents', 'linked.py'));
    await expect(new LocalOrganismAdapter(hardlinkHome).inventory({
      mode: 'portable',
      includeHistory: false,
      includeMedia: false,
      acknowledgeUnknownLicense: false,
    })).rejects.toThrow(/hardlink/);

    const sparseHome = path.join(ROOT, 'sparse-home');
    fs.mkdirSync(path.join(sparseHome, 'sounds'), { recursive: true });
    fs.writeFileSync(path.join(sparseHome, 'rappid.tail'), `${'4'.repeat(64)}\n`);
    const sparse = path.join(sparseHome, 'sounds', 'sparse.wav');
    fs.writeFileSync(sparse, '');
    fs.truncateSync(sparse, 1024 * 1024);
    fs.writeFileSync(`${sparse}.license.json`, JSON.stringify({
      origin: 'synthetic sparse fixture',
      license: 'CC0-1.0',
      owned: true,
    }));
    await expect(new LocalOrganismAdapter(sparseHome).inventory({
      mode: 'portable',
      includeHistory: false,
      includeMedia: true,
      acknowledgeUnknownLicense: false,
    })).rejects.toThrow(/sparse file/);
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
      semantics: 'clone',
      apply: false,
    });
    await service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      rollbackPassphrase: PASSPHRASE,
    });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'memory.json'), 'utf8'))).toEqual({ version: 1 });
    expect(fs.existsSync(path.join(home, 'agents', 'extra_agent.js'))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'rappid.tail'), 'utf8')).toBe(`${'7'.repeat(64)}\n`);
  });

  it('uses an unsanitized sealed rollback generation and verifies exact recovery', async () => {
    class OneShotFailingAdapter extends LocalOrganismAdapter {
      private fail = true;
      override async healthProbe(): Promise<{ ok: boolean; detail: string }> {
        if (this.fail) {
          this.fail = false;
          return { ok: false, detail: 'synthetic staged health failure' };
        }
        return super.healthProbe();
      }
    }
    const home = path.join(ROOT, 'exact-rollback-home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'rappid.tail'), `${'6'.repeat(64)}\n`);
    fs.writeFileSync(path.join(home, 'memory.json'), '{"before":true}\n');
    const envValue = `${['client', 'secret'].join('_')}=synthetic-private-rollback-value\n`;
    fs.writeFileSync(path.join(home, '.env'), envValue, { mode: 0o600 });
    const service = new OrganismEggService(
      new OneShotFailingAdapter(home),
      path.join(ROOT, 'exact-rollback-runtime'),
    );
    const exported = await service.export(options(path.join(ROOT, 'rollback-source.egg'), 'portable'));
    fs.writeFileSync(path.join(home, 'memory.json'), '{"before":"changed"}\n');
    const preview = await service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: false,
    });
    await expect(service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/health probe/);
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe(envValue);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'memory.json'), 'utf8'))).toEqual({
      before: 'changed',
    });
    const rollbackName = fs.readdirSync(path.join(service.runtimeDir, 'backups'))
      .find((name) => name.endsWith('.egg'));
    const rollback = service.inspect(
      path.join(service.runtimeDir, 'backups', rollbackName ?? ''),
      PASSPHRASE,
    );
    expect(rollback.files).toContainEqual(expect.objectContaining({ path: 'state/.env' }));
  });

  it('executes migration functions and quarantines unsupported migration failures', async () => {
    const adapter = new SyntheticAdapter();
    const service = new OrganismEggService(adapter, path.join(ROOT, 'migration-runtime'));
    const exported = await service.export(options(path.join(ROOT, 'migration-source.egg'), 'portable'));
    const parsed = readAndVerifyRappEgg(fs.readFileSync(exported.output));
    const manifest = JSON.parse(
      Buffer.from(parsed.files['organism/manifest.json']).toString('utf8'),
    ) as Record<string, unknown>;
    manifest.requiredMigrations = ['openrappter-organism-egg/future-9'];
    parsed.files['organism/manifest.json'] = Buffer.from(canonical(manifest));
    const futureEgg = packRappEgg({
      rappid: parsed.manifest.rappid,
      createdUtc: parsed.manifest.created_utc,
      files: parsed.files,
      payload: parsed.manifest.payload,
    });
    const futurePath = path.join(ROOT, 'future-migration.egg');
    fs.writeFileSync(futurePath, futureEgg, { mode: 0o600 });
    const preview = await service.import({
      eggPath: futurePath,
      semantics: 'clone',
      apply: false,
    });
    await expect(service.import({
      eggPath: futurePath,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/Unsupported organism migration/);
    expect(fs.readdirSync(path.join(service.runtimeDir, 'quarantine'))).toHaveLength(1);
  });

  it('persists recovery-needed evidence and quarantine even when rollback fails', async () => {
    class BrokenRollbackAdapter extends SyntheticAdapter {
      override async rollback(): Promise<void> {
        throw new Error('synthetic rollback failure');
      }
    }
    const adapter = new BrokenRollbackAdapter();
    const service = new OrganismEggService(adapter, path.join(ROOT, 'broken-rollback-runtime'));
    const exported = await service.export(options(path.join(ROOT, 'broken-rollback.egg'), 'portable'));
    adapter.files[0] = file('agents/helper_agent.js', 'changed\n', 'agents', 'text/javascript');
    const preview = await service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: false,
    });
    adapter.failNextHealth = true;
    await expect(service.import({
      eggPath: exported.output,
      semantics: 'clone',
      apply: true,
      ...approved(preview.preview),
      rollbackPassphrase: PASSPHRASE,
    })).rejects.toThrow(/FATAL.*recovery evidence/);
    expect(fs.readdirSync(service.runtimeDir).some((name) => name.startsWith('RECOVERY-NEEDED-'))).toBe(true);
    expect(fs.readdirSync(path.join(service.runtimeDir, 'quarantine'))).toHaveLength(1);
  });

  it('wires query-only snapshots, gateway maintenance fencing, generation swaps and restrictive ACLs', () => {
    const inventorySource = fs.readFileSync(new URL('./inventory.ts', import.meta.url), 'utf8');
    const serviceSource = fs.readFileSync(new URL('./service.ts', import.meta.url), 'utf8');
    const gatewaySource = fs.readFileSync(new URL('../gateway/server.ts', import.meta.url), 'utf8');
    expect(inventorySource).toContain("database.pragma('query_only = ON')");
    expect(inventorySource).not.toContain('wal_checkpoint');
    expect(inventorySource).toContain('fs.renameSync(this.home, prior)');
    expect(inventorySource).toContain('validateGenerationTree(staged)');
    expect(gatewaySource).toContain('withOrganismWriteAccessSync');
    expect(serviceSource).toContain('hardenPrivatePath(target)');
    expect(serviceSource).not.toContain('platform-best-effort');
  });

  it('waits for authoritative writers before entering the organism snapshot epoch', async () => {
    const home = path.join(ROOT, 'maintenance-home');
    const maintenance = path.join(
      path.dirname(home),
      `.${path.basename(home)}.maintenance`,
    );
    fs.mkdirSync(maintenance, { recursive: true });
    const writer = path.join(maintenance, 'writer-synthetic');
    fs.writeFileSync(writer, '');
    setTimeout(() => fs.rmSync(writer, { force: true }), 40);
    const started = Date.now();
    await withOrganismSnapshotFence(home, async () => {
      expect(fs.existsSync(writer)).toBe(false);
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });
});
