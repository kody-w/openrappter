import fs from 'node:fs';
import path from 'node:path';
import { openrappterHome } from '../infra/openrappter-home.js';
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
import {
  ORGANISM_EGG_PROFILE,
  type EggDiff,
  type EggDiffEntry,
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
const SECRET_SHAPE = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[opsu]_[A-Za-z0-9]{30,}\b/,
  /\bsk-[A-Za-z0-9_-]{24,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*["']?[^\s"',}]{12,}/i,
];

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
  try { fs.chmodSync(target, 0o600); } catch { /* Windows permissions are best effort. */ }
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
    if (!before.isFile() || before.size > MAX_EGG_BYTES + 16 * 1024 * 1024) {
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
    if (
      file.mime.startsWith('audio/')
      || file.mime === 'application/vnd.sqlite3'
      || file.bytes.includes(0)
    ) continue;
    const text = Buffer.from(file.bytes).toString('utf8');
    for (const pattern of SECRET_SHAPE) {
      if (pattern.test(text)) {
        throw new Error(`Portable egg secret-shape scan rejected ${file.path}`);
      }
    }
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
    || manifest.requiredMigrations.some((migration) => migration !== PROFILE_MIGRATION)
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
  }));
  return { manifest, inventoryFiles };
}

export class OrganismEggService {
  readonly adapter: EggStateAdapter;
  readonly runtimeDir: string;

  constructor(
    adapter: EggStateAdapter = new LocalOrganismAdapter(),
    runtimeDir = openrappterHome(),
  ) {
    this.adapter = adapter;
    this.runtimeDir = path.resolve(runtimeDir);
  }

  private async buildEggBytes(options: ExportEggOptions): Promise<{
    bytes: Uint8Array;
    manifest: OrganismEggManifest;
  }> {
    const inventory = await this.adapter.inventory({
      mode: options.mode,
      includeHistory: options.includeHistory === true,
      includeMedia: options.includeMedia === true,
      acknowledgeUnknownLicense: options.acknowledgeUnknownLicense === true,
      mediaPaths: options.mediaPaths,
    });
    if (options.mode === 'portable') assertPortableHasNoSecrets(inventory.files);
    const createdUtc = options.createdUtc ?? fixedUtc(new Date());
    const manifest = buildManifest(inventory, options, createdUtc);
    const innerFiles = {
      ...filesRecord(inventory.files),
      'organism/manifest.json': Buffer.from(canonical(manifest), 'utf8'),
    };
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

  async export(options: ExportEggOptions): Promise<{
    output: string;
    digest: string;
    manifest: OrganismEggManifest;
    permissions: '0600' | 'platform-best-effort';
  }> {
    if (!options.output.toLowerCase().endsWith('.egg')) {
      throw new Error('Organism exports must use the .egg extension');
    }
    if (fs.existsSync(options.output)) throw new Error(`Refusing to overwrite ${options.output}`);
    const built = await this.buildEggBytes(options);
    atomicPrivateWrite(path.resolve(options.output), built.bytes);
    if (process.platform !== 'win32' && (fs.statSync(options.output).mode & 0o077) !== 0) {
      fs.rmSync(options.output, { force: true });
      throw new Error('Could not enforce private 0600 permissions on egg output');
    }
    return {
      output: path.resolve(options.output),
      digest: sha256(built.bytes),
      manifest: built.manifest,
      permissions: process.platform === 'win32' ? 'platform-best-effort' : '0600',
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

  async diff(
    eggPath: string,
    options: { passphrase?: string; semantics: 'restore' | 'clone' },
  ): Promise<EggDiff> {
    const blob = safeReadEgg(eggPath);
    const inspection = this.inspectBytes(blob, options.passphrase);
    if (!inspection.decrypted || !inspection.inventoryFiles || !inspection.manifest) {
      throw new Error('A passphrase is required to diff a sealed egg');
    }
    const current = await this.adapter.inventory({
      mode: inspection.manifest.mode,
      includeHistory: inspection.manifest.privacy.includesHistory,
      includeMedia: inspection.manifest.privacy.includesMedia,
      acknowledgeUnknownLicense: true,
    });
    const compatible = options.semantics === 'clone'
      || current.rappid === inspection.manifest.organismRappid;
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
    const bindingInput = {
      action: 'openrappter.egg.import.apply',
      eggDigest,
      targetRappid: current.rappid,
      sourceRappid: inspection.manifest.organismRappid,
      baseStateDigest,
      diffDigest: sha256(canonical(entries)),
      semantics: options.semantics,
    };
    return {
      eggDigest,
      targetRappid: current.rappid,
      baseStateDigest,
      semantics: options.semantics,
      compatible,
      reauthentication: inspection.manifest.privacy.reauthentication,
      entries,
      approvalBinding: sha256(canonical(bindingInput)),
    };
  }

  async import(options: ImportEggOptions): Promise<{
    preview: EggDiff;
    applied: boolean;
    rollbackEgg?: string;
    health?: string;
  }> {
    const preview = await this.diff(options.eggPath, {
      passphrase: options.passphrase,
      semantics: options.semantics,
    });
    if (!options.apply) return { preview, applied: false };
    if (!preview.compatible) {
      throw new Error('Restore RAPPID mismatch; choose explicit clone semantics instead of merging organisms');
    }
    if (options.approval !== preview.approvalBinding) {
      throw new Error('Apply requires the action-bound approval from this exact preview');
    }
    const rollbackPassphrase = options.rollbackPassphrase ?? options.passphrase;
    if (!rollbackPassphrase) throw new Error('Apply requires a passphrase for the rollback egg');

    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    const lockPath = path.join(this.runtimeDir, 'organism-egg.lock');
    const lock = fs.openSync(lockPath, 'wx', 0o600);
    const operation = `${Date.now()}-${preview.eggDigest.slice(0, 12)}`;
    const staging = path.join(this.runtimeDir, 'staging', operation);
    const quarantine = path.join(this.runtimeDir, 'quarantine');
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    let rollbackEgg = '';
    let rollbackFiles: InventoryFile[] = [];
    let currentRappid = preview.targetRappid;
    try {
      fs.writeFileSync(lock, canonical({
        pid: process.pid,
        eggDigest: preview.eggDigest,
        targetRappid: preview.targetRappid,
        baseStateDigest: preview.baseStateDigest,
      }));
      fs.fsyncSync(lock);
      const incomingBlob = safeReadEgg(options.eggPath);
      const incoming = this.inspectBytes(incomingBlob, options.passphrase);
      if (!incoming.inventoryFiles || !incoming.manifest) throw new Error('Import payload is still sealed');
      const current = await this.adapter.inventory({
        mode: incoming.manifest.mode,
        includeHistory: incoming.manifest.privacy.includesHistory,
        includeMedia: incoming.manifest.privacy.includesMedia,
        acknowledgeUnknownLicense: true,
      });
      currentRappid = current.rappid;
      if (stateDigest(current.files) !== preview.baseStateDigest) {
        throw new Error('Organism changed after preview; produce a new diff and human approval');
      }
      const rollbackInventory = (
        incoming.manifest.privacy.includesHistory
        && incoming.manifest.privacy.includesMedia
      ) ? current : await this.adapter.inventory({
        mode: 'sealed-backup',
        includeHistory: true,
        includeMedia: true,
        acknowledgeUnknownLicense: true,
      });
      rollbackFiles = rollbackInventory.files;
      const rollbackPath = path.join(
        this.runtimeDir,
        'backups',
        `rollback-${operation}.egg`,
      );
      const rollbackOptions: ExportEggOptions = {
        mode: 'sealed-backup',
        output: rollbackPath,
        passphrase: rollbackPassphrase,
        includeHistory: true,
        includeMedia: true,
        acknowledgeUnknownLicense: true,
        createdUtc: fixedUtc(new Date()),
        sourceVersion: 'rollback',
        sourceCommit: preview.baseStateDigest,
        sourceRing: 'local-rollback',
      };
      const rollbackBuilt = await this.buildEggBytes(rollbackOptions);
      atomicPrivateWrite(rollbackPath, rollbackBuilt.bytes);
      rollbackEgg = rollbackPath;

      await this.adapter.apply(incoming.inventoryFiles, {
        semantics: options.semantics,
        sourceRappid: incoming.manifest.organismRappid,
        mode: incoming.manifest.mode,
        includesHistory: incoming.manifest.privacy.includesHistory,
        includesMedia: incoming.manifest.privacy.includesMedia,
      });
      const health = await this.adapter.healthProbe();
      if (!health.ok) throw new Error(`Post-import health probe failed: ${health.detail}`);
      fs.rmSync(staging, { recursive: true, force: true });
      return { preview, applied: true, rollbackEgg, health: health.detail };
    } catch (error) {
      if (rollbackFiles.length) {
        try {
          await this.adapter.apply(rollbackFiles, {
            semantics: 'restore',
            sourceRappid: currentRappid,
            mode: 'sealed-backup',
            includesHistory: true,
            includesMedia: true,
          });
        } catch (rollbackError) {
          throw new Error(
            `Import failed and rollback failed: ${String(error)}; rollback: ${String(rollbackError)}`,
          );
        }
      }
      fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
      const quarantinePath = path.join(quarantine, `${operation}.egg`);
      if (!fs.existsSync(quarantinePath)) atomicPrivateWrite(quarantinePath, safeReadEgg(options.eggPath));
      fs.writeFileSync(path.join(staging, 'failure.json'), canonical({
        eggDigest: preview.eggDigest,
        failedUtc: fixedUtc(new Date()),
        error: error instanceof Error ? error.message : String(error),
        quarantine: quarantinePath,
        rollbackEgg,
      }), { mode: 0o600 });
      throw error;
    } finally {
      fs.closeSync(lock);
      fs.rmSync(lockPath, { force: true });
    }
  }
}
