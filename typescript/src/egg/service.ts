import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openrappterHome } from '../infra/openrappter-home.js';
import { hardenPrivatePath, syncParentDirectory } from '../flight-recorder/permissions.js';
import {
  canonical,
  MAX_EGG_BYTES,
  packRappEgg,
  parsePublicHeader,
  readAndVerifyRappEgg,
  sealBytes,
  sha256,
  unsealBytes,
} from './archive.js';
import { LocalOrganismAdapter } from './inventory.js';
import { assertNoPortableSecrets } from './secrets.js';
import {
  ORGANISM_EGG_PROFILE,
  type EggDiff,
  type EggDiffEntry,
  type EggApplyReceipt,
  type EggInspection,
  type EggPublicHeader,
  type EggStateAdapter,
  type ExportEggOptions,
  type ImportEggOptions,
  type InventoryFile,
  type InventoryResult,
  type OrganismEggFile,
  type OrganismEggManifest,
} from './types.js';

const PROFILE_MIGRATION = 'openrappter-organism-egg/1.0';
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const IDENTITY_SEED_PATH =
  /(?:^|\/)(?:rappid\.tail|[^/]*(?:device|organism|private)[_-]?key(?:\.[^/]*)?)$/i;

function fixedUtc(value: Date): string {
  return value.toISOString();
}

function manifestFiles(files: InventoryFile[]): OrganismEggFile[] {
  return files.map((file) => ({
    path: file.path,
    size: file.bytes.length,
    sha256: sha256(file.bytes),
    mime: file.mime,
    dimension: file.dimension,
    privacy: file.privacy,
    provenance: file.provenance,
    mode: file.mode,
    mtimeMs: file.mtimeMs,
  })).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}

function rootDigest(files: OrganismEggFile[]): string {
  return sha256(canonical(files));
}

function stateDigest(files: InventoryFile[]): string {
  return rootDigest(manifestFiles(files));
}

function atomicPrivateWrite(file: string, bytes: Uint8Array): void {
  const target = path.resolve(file);
  const parsed = path.parse(target);
  let cursor = parsed.root;
  for (const part of path.dirname(target).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Egg output contains an unsafe path component: ${cursor}`);
    }

  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    hardenPrivatePath(target);
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw new Error('Could not enforce restrictive private permissions for egg output', {
      cause: error,
    });
  }
  syncParentDirectory(path.dirname(target));
}

function assertOutputCapacity(file: string, bytes: number): void {
  let directory = path.dirname(path.resolve(file));
  while (!fs.existsSync(directory)) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Egg output has no existing filesystem ancestor');
    directory = parent;
  }
  const capacity = fs.statfsSync(directory);
  if (capacity.bavail * capacity.bsize < bytes * 2) {
    throw new Error('Insufficient free space for durable egg output');
  }
}

function safeReadEgg(file: string): Buffer {
  const target = path.resolve(file);
  const parsed = path.parse(target);
  let cursor = parsed.root;
  for (const part of target.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`Egg input contains a symlink: ${cursor}`);
  }
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fs.fstatSync(descriptor);
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.size > MAX_EGG_BYTES + 16 * 1024 * 1024
      || (
        process.platform !== 'win32'
        && before.size > 0
        && before.blocks * 512 < before.size
      )
    ) {
      throw new Error('Egg input is not a bounded regular file');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error('Egg input changed while being read');
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPortableHasNoSecrets(files: InventoryFile[]): void {
  for (const file of files) {
    assertNoPortableSecrets(file.path, file.bytes);
  }
}

function filesRecord(files: InventoryFile[]): Record<string, Uint8Array> {
  return Object.fromEntries(files.map((file) => [file.path, file.bytes]));
}

function publicHeader(manifest: OrganismEggManifest): Omit<EggPublicHeader, 'crypto'> {
  return {
    profile: ORGANISM_EGG_PROFILE,
    mode: manifest.mode,
    organismRappid: manifest.organismRappid,
    createdUtc: manifest.createdUtc,
    rootDigest: manifest.rootDigest,
    dimensions: manifest.dimensions,
    privacy: manifest.privacy,
  };
}

function buildManifest(
  inventory: InventoryResult,
  options: ExportEggOptions,
  createdUtc: string,
): OrganismEggManifest {
  const files = manifestFiles(inventory.files);
  return {
    profile: ORGANISM_EGG_PROFILE,
    profileVersion: '1.0',
    mode: options.mode,
    source: {
      version: options.sourceVersion,
      commit: options.sourceCommit,
      ring: options.sourceRing,
      platform: process.platform,
    },
    organismRappid: inventory.rappid,
    createdUtc,
    dimensions: {
      ...inventory.dimensions,
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0),
    },
    files,
    privacy: {
      default: 'private',
      includesHistory: options.includeHistory === true,
      includesMedia: options.includeMedia === true,
      exclusions: inventory.exclusions,
      reauthentication: inventory.reauthentication,
    },
    requiredMigrations: [PROFILE_MIGRATION],
    rootDigest: rootDigest(files),
  };
}

function verifyOrganism(
  rappid: string,
  files: Record<string, Uint8Array>,
  expectedHeader: EggPublicHeader,
): { manifest: OrganismEggManifest; inventoryFiles: InventoryFile[] } {
  const manifestBytes = files['organism/manifest.json'];
  if (!manifestBytes) throw new Error('Organism egg has no organism/manifest.json');
  let manifest: OrganismEggManifest;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8')) as OrganismEggManifest;
  } catch {
    throw new Error('Organism manifest is not JSON');
  }
  if (
    manifest.profile !== ORGANISM_EGG_PROFILE
    || manifest.profileVersion !== '1.0'
    || manifest.organismRappid !== rappid
    || manifest.organismRappid !== expectedHeader.organismRappid
    || manifest.rootDigest !== expectedHeader.rootDigest
    || manifest.createdUtc !== expectedHeader.createdUtc
    || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.requiredMigrations)
    || manifest.requiredMigrations.some((migration) => (
      typeof migration !== 'string'
      || !/^[a-z0-9][a-z0-9./-]{0,127}$/.test(migration)
    ))
  ) {
    throw new Error('Organism manifest is incompatible or does not match its RAPP/1 envelope');
  }
  if (canonical(manifest) !== Buffer.from(manifestBytes).toString('utf8')) {
    throw new Error('Organism manifest is not canonical');
  }
  const expectedPaths = manifest.files.map((file) => file.path);
  const actualPaths = Object.keys(files).filter((entry) => entry !== 'organism/manifest.json');
  if (JSON.stringify([...expectedPaths].sort()) !== JSON.stringify(actualPaths.sort())) {
    throw new Error('Organism manifest files do not match the egg payload');
  }
  for (const descriptor of manifest.files) {
    const bytes = files[descriptor.path];
    if (
      !bytes
      || bytes.length !== descriptor.size
      || sha256(bytes) !== descriptor.sha256
      || !Number.isInteger(descriptor.mode)
      || descriptor.mode < 0
      || descriptor.mode > 0o777
      || !Number.isFinite(descriptor.mtimeMs)
    ) {
      throw new Error(`Organism file size or SHA-256 mismatch: ${descriptor.path}`);
    }

  }
  if (rootDigest(manifest.files) !== manifest.rootDigest) {
    throw new Error('Organism root digest mismatch');
  }
  const inventoryFiles = manifest.files.map((descriptor) => ({
    path: descriptor.path,
    bytes: files[descriptor.path],
    mime: descriptor.mime,
    dimension: descriptor.dimension,
    privacy: descriptor.privacy,
    provenance: descriptor.provenance,
    mode: descriptor.mode,
    mtimeMs: descriptor.mtimeMs,
  }));
  return { manifest, inventoryFiles };
}

interface PreviewRecord {
  schema: 'openrappter-egg-preview/1';
  handle: string;
  nonce: string;
  createdUtc: string;
  expiresUtc: string;
  eggDigest: string;
  eggSize: number;
  targetRappid: string;
  sourceRappid: string;
  baseStateDigest: string;
  diffDigest: string;
  semantics: 'restore' | 'clone';
  mode: 'portable' | 'sealed-backup';
  approvalBinding: string;
  used: boolean;
}

const PROFILE_MIGRATIONS: Record<
  string,
  (files: InventoryFile[]) => Promise<InventoryFile[]>
> = {
  [PROFILE_MIGRATION]: async (files) => {
    const target = files.find((file) => file.path === 'state/openrappter.db');
    if (!target) return files;
    const [{ default: DatabaseModule }, { migrations }] = await Promise.all([
      import('better-sqlite3'),
      import('../storage/migrations.js'),
    ]);
    const Database = DatabaseModule as unknown as new (source: Buffer) => {
      exec(sql: string): void;
      prepare(sql: string): {
        all(): Array<{ id: number }>;
        run(...values: unknown[]): unknown;
      };
      transaction<T>(operation: () => T): () => T;
      serialize(): Buffer;
      close(): void;
    };
    const image = Buffer.from(target.bytes);
    if (image.length >= 20) {
      image[18] = 1;
      image[19] = 1;
    }
    const database = new Database(image);
    try {
      database.exec(`
        CREATE TABLE IF NOT EXISTS migrations (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      const applied = new Set(database.prepare('SELECT id FROM migrations').all().map((row) => row.id));
      for (const migration of migrations.filter((entry) => !applied.has(entry.id))) {
        database.transaction(() => {
          database.exec(migration.up);
          database.prepare(
            'INSERT INTO migrations (id, name, applied_at) VALUES (?, ?, ?)',
          ).run(migration.id, migration.name, fixedUtc(new Date()));
        })();
      }
      const bytes = database.serialize();
      return files.map((file) => (
        file === target ? { ...file, bytes } : file
      ));
    } finally {
      database.close();
    }
  },
};

async function executeMigrations(
  manifest: OrganismEggManifest,
  files: InventoryFile[],
): Promise<InventoryFile[]> {
  let migrated = files;
  for (const name of manifest.requiredMigrations) {
    const migration = PROFILE_MIGRATIONS[name];
    if (!migration) throw new Error(`Unsupported organism migration ${name}`);
    migrated = await migration(migrated);
  }
  return migrated;
}

export class OrganismEggService {
  readonly adapter: EggStateAdapter;
  readonly runtimeDir: string;

  constructor(
    adapter: EggStateAdapter = new LocalOrganismAdapter(),
    runtimeDir = path.join(
      path.dirname(openrappterHome()),
      `.${path.basename(openrappterHome())}-egg-runtime`,
    ),
  ) {
    this.adapter = adapter;
    const requested = path.resolve(runtimeDir);
    if (adapter instanceof LocalOrganismAdapter) {
      const relative = path.relative(adapter.home, requested);
      this.runtimeDir = (
        !relative || (!relative.startsWith('..') && !path.isAbsolute(relative))
      ) ? path.join(path.dirname(adapter.home), `.${path.basename(adapter.home)}-egg-runtime`) : requested;
    } else {
      this.runtimeDir = requested;
    }
  }

  private encodeInventory(
    inventory: InventoryResult,
    options: ExportEggOptions,
  ): {
    bytes: Uint8Array;
    manifest: OrganismEggManifest;
  } {
    if (options.mode === 'portable') assertPortableHasNoSecrets(inventory.files);
    const createdUtc = options.createdUtc ?? fixedUtc(new Date());
    const manifest = buildManifest(inventory, options, createdUtc);
    const innerFiles = {
      ...filesRecord(inventory.files),
      'organism/manifest.json': Buffer.from(canonical(manifest), 'utf8'),
    };
    if (options.mode === 'portable') {
      if (Object.keys(innerFiles).some((file) => IDENTITY_SEED_PATH.test(file))) {
        throw new Error('Portable eggs may not contain an identity seed');
      }
      for (const [file, bytes] of Object.entries(innerFiles)) {
        assertNoPortableSecrets(file, bytes);
      }
    }
    const header = publicHeader(manifest);
    const inner = packRappEgg({
      rappid: inventory.rappid,
      createdUtc,
      files: innerFiles,
      payload: { profile: ORGANISM_EGG_PROFILE, header },
    });
    if (options.mode === 'portable') return { bytes: inner, manifest };
    if (!options.passphrase) throw new Error('Sealed backup export requires a passphrase');
    const sealed = sealBytes(inner, header, options.passphrase);
    return {
      manifest,
      bytes: packRappEgg({
        rappid: inventory.rappid,
        createdUtc,
        files: { 'organism/sealed.bin': sealed.ciphertext },
        payload: { profile: ORGANISM_EGG_PROFILE, header: sealed.header },
      }),
    };
  }

  private async buildEggBytes(options: ExportEggOptions & { exact?: boolean }): Promise<{
    bytes: Uint8Array;
    manifest: OrganismEggManifest;
  }> {
    return this.adapter.withSnapshotFence(async () => {
      const inventory = await this.adapter.inventory({
        mode: options.mode,
        exact: options.exact === true,
        includeHistory: options.includeHistory === true,
        includeMedia: options.includeMedia === true,
        acknowledgeUnknownLicense: options.acknowledgeUnknownLicense === true,
        mediaPaths: options.mediaPaths,
      });
      return this.encodeInventory(inventory, options);
    });
  }

  async export(options: ExportEggOptions): Promise<{
    output: string;
    digest: string;
    manifest: OrganismEggManifest;
    permissions: '0600' | 'restricted-acl';
  }> {
    if (!options.output.toLowerCase().endsWith('.egg')) {
      throw new Error('Organism exports must use the .egg extension');
    }
    if (fs.existsSync(options.output)) throw new Error(`Refusing to overwrite ${options.output}`);
    const built = await this.buildEggBytes(options);
    assertOutputCapacity(options.output, built.bytes.length);
    atomicPrivateWrite(path.resolve(options.output), built.bytes);
    if (process.platform !== 'win32' && (fs.statSync(options.output).mode & 0o077) !== 0) {
      fs.rmSync(options.output, { force: true });
      throw new Error('Could not enforce private 0600 permissions on egg output');
    }
    return {
      output: path.resolve(options.output),
      digest: sha256(built.bytes),
      manifest: built.manifest,
      permissions: process.platform === 'win32' ? 'restricted-acl' : '0600',
    };
  }

  inspectBytes(blob: Uint8Array, passphrase?: string): EggInspection & {
    inventoryFiles?: InventoryFile[];
  } {
    const outer = readAndVerifyRappEgg(blob);
    const header = parsePublicHeader(outer.manifest.payload);
    if (outer.manifest.rappid !== header.organismRappid) {
      throw new Error('Organism header RAPPID does not match RAPP/1 envelope');
    }
    if (header.mode === 'sealed-backup') {
      const ciphertext = outer.files['organism/sealed.bin'];
      if (!ciphertext || Object.keys(outer.files).length !== 1) {
        throw new Error('Sealed organism egg must contain exactly organism/sealed.bin');
      }
      if (!passphrase) {
        return { valid: true, sealed: true, header, decrypted: false };
      }
      const innerBytes = unsealBytes(header, ciphertext, passphrase);
      const inner = readAndVerifyRappEgg(innerBytes);
      const verified = verifyOrganism(inner.manifest.rappid, inner.files, header);
      if (verified.manifest.mode !== 'sealed-backup') {
        throw new Error('Sealed envelope contains a non-backup organism manifest');
      }
      return {
        valid: true,
        sealed: true,
        header,
        manifest: verified.manifest,
        files: verified.manifest.files,
        inventoryFiles: verified.inventoryFiles,
        decrypted: true,
      };
    }
    const verified = verifyOrganism(outer.manifest.rappid, outer.files, header);
    if (verified.manifest.mode !== 'portable') {
      throw new Error('Portable envelope contains a non-portable organism manifest');
    }
    if (verified.inventoryFiles.some((file) => IDENTITY_SEED_PATH.test(file.path))) {
      throw new Error('Portable egg contains a forbidden identity seed');
    }
    assertPortableHasNoSecrets(verified.inventoryFiles);
    return {
      valid: true,
      sealed: false,
      header,
      manifest: verified.manifest,
      files: verified.manifest.files,
      inventoryFiles: verified.inventoryFiles,
      decrypted: true,
    };
  }

  inspect(file: string, passphrase?: string): EggInspection {
    return this.inspectBytes(safeReadEgg(file), passphrase);
  }

  private stagePreview(
    blob: Uint8Array,
    record: Omit<PreviewRecord, 'schema' | 'handle' | 'nonce' | 'createdUtc' | 'expiresUtc' | 'approvalBinding' | 'used'>,
  ): PreviewRecord {
    const nonce = randomUUID();
    const handle = `${record.eggDigest}.${nonce}`;
    const previews = path.join(this.runtimeDir, 'previews');
    fs.mkdirSync(previews, { recursive: true, mode: 0o700 });
    hardenPrivatePath(previews, true);
    const available = fs.statfsSync(previews);
    if (available.bavail * available.bsize < blob.length * 2) {
      throw new Error('Insufficient private staging space for immutable egg preview');
    }
    const eggFile = path.join(previews, `${handle}.egg`);
    atomicPrivateWrite(eggFile, blob);
    const bindingInput = {
      action: 'openrappter.egg.import.apply',
      handle,
      nonce,
      eggDigest: record.eggDigest,
      eggSize: record.eggSize,
      targetRappid: record.targetRappid,
      sourceRappid: record.sourceRappid,
      baseStateDigest: record.baseStateDigest,
      diffDigest: record.diffDigest,
      semantics: record.semantics,
      mode: record.mode,
    };
    const preview: PreviewRecord = {
      schema: 'openrappter-egg-preview/1',
      handle,
      nonce,
      createdUtc: fixedUtc(new Date()),
      expiresUtc: fixedUtc(new Date(Date.now() + PREVIEW_TTL_MS)),
      ...record,
      approvalBinding: sha256(canonical(bindingInput)),
      used: false,
    };
    atomicPrivateWrite(
      path.join(previews, `${handle}.json`),
      Buffer.from(canonical(preview), 'utf8'),
    );
    return preview;
  }

  private readPreview(handle: string): {
    record: PreviewRecord;
    blob: Buffer;
    recordPath: string;
    eggPath: string;
  } {
    if (!/^[0-9a-f]{64}\.[0-9a-f-]{36}$/.test(handle)) {
      throw new Error('Invalid preview handle');
    }
    const previews = path.join(this.runtimeDir, 'previews');
    const recordPath = path.join(previews, `${handle}.json`);
    const eggPath = path.join(previews, `${handle}.egg`);
    const record = JSON.parse(safeReadEgg(recordPath).toString('utf8')) as PreviewRecord;
    const blob = safeReadEgg(eggPath);
    if (
      record.schema !== 'openrappter-egg-preview/1'
      || record.handle !== handle
      || record.used
      || Date.parse(record.expiresUtc) <= Date.now()
      || sha256(blob) !== record.eggDigest
      || blob.length !== record.eggSize
    ) {
      throw new Error('Preview handle is expired, consumed, or does not match immutable egg bytes');
    }
    return { record, blob, recordPath, eggPath };
  }

  async diff(
    eggPath: string,
    options: { passphrase?: string; semantics: 'restore' | 'clone' },
  ): Promise<EggDiff> {
    const blob = safeReadEgg(eggPath);
    const inspection = this.inspectBytes(blob, options.passphrase);
    if (!inspection.decrypted || !inspection.inventoryFiles || !inspection.manifest) {
      throw new Error('A passphrase is required to diff a sealed egg');
    }
    const current = await this.adapter.withSnapshotFence(() => this.adapter.inventory({
      mode: inspection.manifest!.mode,
      includeHistory: inspection.manifest!.privacy.includesHistory,
      includeMedia: inspection.manifest!.privacy.includesMedia,
      acknowledgeUnknownLicense: true,
    }));
    const compatible = inspection.manifest.mode === 'portable'
      ? options.semantics === 'clone'
      : options.semantics === 'clone' || current.rappid === inspection.manifest.organismRappid;
    const before = new Map(manifestFiles(current.files).map((file) => [file.path, file]));
    const after = new Map(inspection.manifest.files.map((file) => [file.path, file]));
    const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
    const entries: EggDiffEntry[] = paths.map((entryPath) => {
      const old = before.get(entryPath);
      const next = after.get(entryPath);
      const change: EggDiffEntry['change'] = !old ? 'add' : !next ? 'remove'
        : old.sha256 === next.sha256 ? 'unchanged' : 'replace';
      return {
        path: entryPath,
        change,
        ...(old ? { beforeSha256: old.sha256 } : {}),
        ...(next ? { afterSha256: next.sha256 } : {}),
        sizeDelta: (next?.size ?? 0) - (old?.size ?? 0),
      };
    });
    const baseStateDigest = stateDigest(current.files);
    const eggDigest = sha256(blob);
    const diffDigest = sha256(canonical(entries));
    const staged = this.stagePreview(blob, {
      eggDigest,
      eggSize: blob.length,
      targetRappid: current.rappid,
      sourceRappid: inspection.manifest.organismRappid,
      baseStateDigest,
      diffDigest,
      semantics: options.semantics,
      mode: inspection.manifest.mode,
    });
    return {
      eggDigest,
      targetRappid: current.rappid,
      baseStateDigest,
      semantics: options.semantics,
      compatible,
      reauthentication: inspection.manifest.privacy.reauthentication,
      entries,
      diffDigest,
      eggSize: blob.length,
      nonce: staged.nonce,
      previewHandle: staged.handle,
      approvalBinding: staged.approvalBinding,
    };
  }

  async import(options: ImportEggOptions): Promise<{
    preview: EggDiff;
    applied: boolean;
    rollbackEgg?: string;
    health?: string;
  }> {
    if (!options.apply) {
      const preview = await this.diff(options.eggPath, {
        passphrase: options.passphrase,
        semantics: options.semantics,
      });
      return { preview, applied: false };
    }
    if (!options.previewHandle || !options.nonce || !options.targetRappid) {
      throw new Error('Apply requires preview handle, one-time nonce, and target RAPPID confirmation');
    }
    const rollbackPassphrase = options.rollbackPassphrase ?? options.passphrase;
    if (!rollbackPassphrase) throw new Error('Apply requires a passphrase for the rollback egg');

    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    hardenPrivatePath(this.runtimeDir, true);
    const lockPath = path.join(this.runtimeDir, 'organism-egg.lock');
    const lock = fs.openSync(lockPath, 'wx', 0o600);
    hardenPrivatePath(lockPath);
    const operation = `${Date.now()}-${options.previewHandle.slice(0, 12)}`;
    const staging = path.join(this.runtimeDir, 'staging', operation);
    const quarantine = path.join(this.runtimeDir, 'quarantine');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    hardenPrivatePath(staging, true);
    let rollbackEgg = '';
    let receipt: EggApplyReceipt | undefined;
    let stagedBlob: Buffer | undefined;
    let stagedRecord: PreviewRecord | undefined;
    let usedRecordPath = '';
    let rollbackFailure: unknown;
    let rollbackStateDigest = '';
    let expectedStateFiles: InventoryFile[] = [];
    try {
      const staged = this.readPreview(options.previewHandle);
      stagedBlob = staged.blob;
      stagedRecord = staged.record;
      if (
        staged.record.nonce !== options.nonce
        || staged.record.approvalBinding !== options.approval
        || staged.record.targetRappid !== options.targetRappid
        || staged.record.semantics !== options.semantics
      ) {
        throw new Error('Apply approval does not match preview nonce, target, semantics, or digest');
      }
      if (staged.record.mode === 'portable' && options.semantics !== 'clone') {
        throw new Error('Portable eggs are clone-only');
      }
      fs.writeFileSync(lock, canonical({
        pid: process.pid,
        previewHandle: staged.record.handle,
        nonce: staged.record.nonce,
        eggDigest: staged.record.eggDigest,
        targetRappid: staged.record.targetRappid,
        baseStateDigest: staged.record.baseStateDigest,
      }));
      fs.fsyncSync(lock);
      usedRecordPath = `${staged.recordPath}.used`;
      fs.renameSync(staged.recordPath, usedRecordPath);
      fs.writeFileSync(usedRecordPath, canonical({ ...staged.record, used: true }), { mode: 0o600 });
      hardenPrivatePath(usedRecordPath);

      const incoming = this.inspectBytes(staged.blob, options.passphrase);
      if (!incoming.inventoryFiles || !incoming.manifest) throw new Error('Import payload is still sealed');
      if (
        incoming.manifest.organismRappid !== staged.record.sourceRappid
        || incoming.manifest.mode !== staged.record.mode
      ) {
        throw new Error('Immutable preview identity no longer matches the verified egg');
      }
      await this.adapter.withSnapshotFence(async () => {
        const current = await this.adapter.inventory({
          mode: incoming.manifest!.mode,
          includeHistory: incoming.manifest!.privacy.includesHistory,
          includeMedia: incoming.manifest!.privacy.includesMedia,
          acknowledgeUnknownLicense: true,
        });
        if (
          current.rappid !== staged.record.targetRappid
          || stateDigest(current.files) !== staged.record.baseStateDigest
        ) {
          throw new Error('Organism changed after preview; produce a new diff and human approval');
        }
        const rollbackInventory = await this.adapter.inventory({
          mode: 'sealed-backup',
          exact: true,
          includeHistory: true,
          includeMedia: true,
          acknowledgeUnknownLicense: true,
        });
        rollbackStateDigest = stateDigest(rollbackInventory.files);
        const rollbackPath = path.join(this.runtimeDir, 'backups', `rollback-${operation}.egg`);
        const rollbackBuilt = this.encodeInventory(rollbackInventory, {
          mode: 'sealed-backup',
          output: rollbackPath,
          passphrase: rollbackPassphrase,
          includeHistory: true,
          includeMedia: true,
          acknowledgeUnknownLicense: true,
          createdUtc: fixedUtc(new Date()),
          sourceVersion: 'exact-rollback',
          sourceCommit: staged.record.baseStateDigest,
          sourceRing: 'local-recovery',
        });
        atomicPrivateWrite(rollbackPath, rollbackBuilt.bytes);
        rollbackEgg = rollbackPath;

        const migrated = await executeMigrations(incoming.manifest!, incoming.inventoryFiles!);
        expectedStateFiles = migrated;
        await this.adapter.validateStaged(migrated, {
          semantics: options.semantics,
          sourceRappid: incoming.manifest!.organismRappid,
          targetRappid: staged.record.targetRappid,
          mode: incoming.manifest!.mode,
        });
        receipt = await this.adapter.apply(migrated, {
          semantics: options.semantics,
          sourceRappid: incoming.manifest!.organismRappid,
          targetRappid: staged.record.targetRappid,
          mode: incoming.manifest!.mode,
          includesHistory: incoming.manifest!.privacy.includesHistory,
          includesMedia: incoming.manifest!.privacy.includesMedia,
          expectedStateDigest: stateDigest(migrated),
        });
      });
      const health = await this.adapter.healthProbe();
      if (!health.ok) throw new Error(`Post-import health probe failed: ${health.detail}`);
      if (!receipt) throw new Error('Import did not produce a durable generation receipt');
      const committedState = await this.adapter.withSnapshotFence(() => this.adapter.inventory({
        mode: incoming.manifest!.mode,
        includeHistory: incoming.manifest!.privacy.includesHistory,
        includeMedia: incoming.manifest!.privacy.includesMedia,
        acknowledgeUnknownLicense: true,
      }));
      const committedDigest = stateDigest(committedState.files);
      if (committedDigest !== receipt.stateDigest) {
        const expected = new Map(manifestFiles(expectedStateFiles).map((file) => [file.path, file]));
        const actual = new Map(manifestFiles(committedState.files).map((file) => [file.path, file]));
        const mismatch = [...new Set([...expected.keys(), ...actual.keys()])].find((file) => (
          canonical(expected.get(file) ?? null) !== canonical(actual.get(file) ?? null)
        ));
        throw new Error(
          `Staged generation state digest does not match after swap`
          + ` (expected ${receipt.stateDigest}, actual ${committedDigest}, first mismatch ${mismatch ?? 'unknown'}`
          + `${mismatch ? `; expected=${canonical(expected.get(mismatch) ?? null)}; actual=${canonical(actual.get(mismatch) ?? null)}` : ''})`,
        );
      }
      await this.adapter.commit(receipt);
      fs.rmSync(staged.eggPath, { force: true });
      fs.rmSync(usedRecordPath, { force: true });
      fs.rmSync(staging, { recursive: true, force: true });
      const preview: EggDiff = {
        eggDigest: staged.record.eggDigest,
        eggSize: staged.record.eggSize,
        targetRappid: staged.record.targetRappid,
        baseStateDigest: staged.record.baseStateDigest,
        semantics: staged.record.semantics,
        compatible: true,
        reauthentication: incoming.manifest.privacy.reauthentication,
        entries: [],
        diffDigest: staged.record.diffDigest,
        nonce: staged.record.nonce,
        previewHandle: staged.record.handle,
        approvalBinding: staged.record.approvalBinding,
      };
      return { preview, applied: true, rollbackEgg, health: health.detail };
    } catch (error) {
      if (receipt) {
        try {
          await this.adapter.rollback(receipt);
          const restored = await this.adapter.withSnapshotFence(() => this.adapter.inventory({
            mode: 'sealed-backup',
            exact: true,
            includeHistory: true,
            includeMedia: true,
            acknowledgeUnknownLicense: true,
          }));
          if (stateDigest(restored.files) !== rollbackStateDigest) {
            throw new Error('Restored generation hash does not match the exact rollback snapshot');
          }
          const rollbackHealth = await this.adapter.healthProbe();
          if (!rollbackHealth.ok) {
            throw new Error(`Restored generation health failed: ${rollbackHealth.detail}`);
          }
        } catch (rollbackError) {
          rollbackFailure = rollbackError;
        }
      }
      fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
      hardenPrivatePath(quarantine, true);
      const quarantinePath = path.join(quarantine, `${operation}.egg`);
      if (stagedBlob && !fs.existsSync(quarantinePath)) atomicPrivateWrite(quarantinePath, stagedBlob);
      const evidencePath = path.join(
        this.runtimeDir,
        rollbackFailure ? `RECOVERY-NEEDED-${operation}.json` : `failure-${operation}.json`,
      );
      fs.writeFileSync(evidencePath, canonical({
        eggDigest: stagedRecord?.eggDigest ?? null,
        failedUtc: fixedUtc(new Date()),
        error: error instanceof Error ? error.message : String(error),
        quarantine: quarantinePath,
        rollbackEgg,
        rollbackFailure: rollbackFailure instanceof Error
          ? rollbackFailure.message
          : rollbackFailure ? String(rollbackFailure) : null,
      }), { mode: 0o600 });
      hardenPrivatePath(evidencePath);
      if (rollbackFailure) {
        throw new Error(
          `FATAL: import failed and exact generation rollback failed; recovery evidence: ${evidencePath}`,
          { cause: rollbackFailure },
        );
      }
      throw error;
    } finally {
      fs.closeSync(lock);
      fs.rmSync(lockPath, { force: true });
    }
  }
}
