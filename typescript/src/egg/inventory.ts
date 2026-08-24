import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import YAML from 'yaml';
import { openrappterHome } from '../infra/openrappter-home.js';
import { isGatewayRunning } from '../infra/gateway-lock.js';
import { withOrganismSnapshotFence } from '../infra/organism-maintenance.js';
import { hardenPrivatePath, syncParentDirectory } from '../flight-recorder/permissions.js';
import { isSecretKey } from '../security/secret-keys.js';
import { redactSecrets } from '../security/redact.js';
import { generateOrganismTheme, validateMidi } from './midi.js';
import { assertNoPortableSecrets, sanitizePortableStructured } from './secrets.js';
import type {
  EggApplyReceipt,
  EggStateAdapter,
  InventoryFile,
  InventoryResult,
  PrivacyClass,
} from './types.js';

const MAX_STATE_FILE = 64 * 1024 * 1024;
const MAX_MEDIA_FILE = 64 * 1024 * 1024;
const MAX_INVENTORY_FILES = 5_000;
const MAX_INVENTORY_BYTES = 1024 * 1024 * 1024;
const MAX_INVENTORY_DEPTH = 32;
const SAFE_RESOURCE = /\.(?:json|jsonl|md|txt|yaml|yml|toml|py|js|mjs|ts|sh|card|tile)$/i;
const SOUND = /\.(?:wav|mp3|flac|ogg|m4a|aac)$/i;
const MIDI = /\.(?:mid|midi)$/i;
const EXCLUDED_NAMES = new Set([
  'node_modules', 'dist', '.build', 'build', 'cache', 'caches', 'logs',
  'downloads', '__pycache__', '.git', 'backups', 'quarantine', 'staging',
]);
const REAUTH_FILES = /(?:^|\/)(?:\.env(?:\..*)?|auth-profiles\.json|credentials?(?:\.json)?|tokens?(?:\.json)?|.*\.pem|.*\.key)$/i;
const KNOWN_MEDIA_LICENSES = new Set([
  'cc0-1.0', 'cc-by-4.0', 'apache-2.0', 'mit', 'public-domain', 'original',
]);

function mimeFor(file: string): string {
  const extension = path.extname(file).toLowerCase();
  return ({
    '.json': 'application/json',
    '.jsonl': 'application/x-ndjson',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml',
    '.toml': 'application/toml',
    '.py': 'text/x-python',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.ts': 'text/typescript',
    '.sh': 'text/x-shellscript',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.mid': 'audio/midi',
    '.midi': 'audio/midi',
    '.db': 'application/vnd.sqlite3',
    '.sqlite': 'application/vnd.sqlite3',
    '.sqlite3': 'application/vnd.sqlite3',
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

function portable(relative: string): string {
  return relative.split(path.sep).join('/').normalize('NFC');
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafeAncestors(root: string, candidate: string): void {
  if (!contained(root, candidate)) throw new Error(`State path escapes the organism home: ${candidate}`);
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  let cursor = path.resolve(root);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) break;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`State path contains a symlink: ${cursor}`);
  }
}

function safeRead(
  root: string,
  file: string,
  maximum = MAX_STATE_FILE,
): { bytes: Buffer; mode: number; mtimeMs: number } {
  assertSafeAncestors(root, file);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) {
      throw new Error(`State path is not a supported regular file: ${file}`);
    }
    if (
      process.platform !== 'win32'
      && before.size > 0
      && before.blocks * 512 < before.size
    ) {
      throw new Error(`State path is a sparse file: ${file}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.size !== bytes.length
      || after.nlink !== 1
    ) {
      throw new Error(`State file changed while it was read: ${file}`);
    }
    return {
      bytes,
      mode: before.mode & 0o777,
      mtimeMs: Math.floor(before.mtimeMs / 1000) * 1000,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sanitizeConfig(bytes: Buffer, file: string): Buffer {
  return Buffer.from(sanitizePortableStructured(file, mimeFor(file), bytes));
}

async function sqliteSnapshot(file: string, exact = false): Promise<Buffer> {
  const module = await import('better-sqlite3');
  const Database = module.default as unknown as new (
    filename: string | Buffer,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => {
    pragma(value: string): unknown;
    serialize(): Buffer;
    exec(sql: string): void;
    prepare(sql: string): {
      all(...values: unknown[]): Array<Record<string, unknown>>;
      run(...values: unknown[]): unknown;
    };
    close(): void;
  };
  const database = new Database(file, { readonly: true, fileMustExist: true });
  let snapshot: Buffer;
  try {
    database.pragma('query_only = ON');
    snapshot = database.serialize();
  } finally {
    database.close();
  }
  // A serialized WAL database keeps header read/write versions at 2. SQLite
  // cannot open that header as an anonymous in-memory database because there
  // is nowhere to create -wal/-shm sidecars. The checkpoint above folded all
  // visible pages into this byte image, so changing only those two documented
  // header bytes to rollback-journal mode makes the isolated sanitizer
  // queryable without touching the live database.
  const memoryImage = Buffer.from(snapshot);
  if (memoryImage.length >= 20) {
    memoryImage[18] = 1;
    memoryImage[19] = 1;
  }
  if (exact) return memoryImage;
  const sanitized = new Database(memoryImage);
  try {
    const tables = sanitized.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => String(row.name));
    for (const table of tables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`;
      if (isSecretKey(table)) {
        sanitized.exec(`DELETE FROM ${quotedTable}`);
        continue;
      }
      const columns = sanitized.prepare(`PRAGMA table_info(${quotedTable})`).all();
      for (const column of columns) {
        const name = String(column.name);
        const quotedColumn = `"${name.replaceAll('"', '""')}"`;
        if (isSecretKey(name)) {
          sanitized.exec(`UPDATE ${quotedTable} SET ${quotedColumn} = '***REDACTED***'`);
          continue;
        }
        const type = String(column.type ?? '').toUpperCase();
        if (type && !/(?:CHAR|CLOB|TEXT|JSON)/.test(type)) continue;
        let rows: Array<Record<string, unknown>>;
        try {
          rows = sanitized.prepare(
            `SELECT rowid AS _egg_rowid, ${quotedColumn} AS _egg_value FROM ${quotedTable}`,
          ).all();
        } catch {
          continue;
        }
        const update = sanitized.prepare(
          `UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE rowid = ?`,
        );
        for (const row of rows) {
          if (typeof row._egg_value !== 'string') continue;
          let replacement = row._egg_value;
          try {
            replacement = JSON.stringify(redactSecrets(JSON.parse(replacement)));
          } catch {
            if (
              /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(replacement)
              || /\bgh[opsu]_[A-Za-z0-9]{30,}\b/.test(replacement)
              || /\bsk-[A-Za-z0-9_-]{24,}\b/.test(replacement)
            ) replacement = '[REAUTHENTICATE]';
          }
          if (replacement !== row._egg_value) update.run(replacement, row._egg_rowid);
        }
      }
    }
    sanitized.exec('VACUUM');
    const output = sanitized.serialize();
    const finalTables = sanitized.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => String(row.name));
    for (const table of finalTables) {
      const quoted = `"${table.replaceAll('"', '""')}"`;
      for (const row of sanitized.prepare(`SELECT * FROM ${quoted}`).all()) {
        for (const [key, value] of Object.entries(row)) {
          if (isSecretKey(key) && value !== null && value !== '' && value !== '***REDACTED***') {
            throw new Error(`Sanitized SQLite still contains secret column ${table}.${key}`);
          }
          if (typeof value === 'string' || Buffer.isBuffer(value)) {
            assertNoPortableSecrets(`${file}:${table}.${key}`, Buffer.from(value));
          }
        }
      }
    }
    assertNoPortableSecrets(file, output);
    return output;
  } finally {
    sanitized.close();
  }
}

function mediaMetadata(file: string): {
  origin: string;
  license: string;
  owned: boolean;
} | null {
  const candidates = [`${file}.license.json`, path.join(path.dirname(file), '.license.json')];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const value = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Record<string, unknown>;
    return {
      origin: String(value.origin ?? 'local'),
      license: String(value.license ?? 'unknown').toLowerCase(),
      owned: value.owned === true,
    };
  }
  return null;
}

function walk(
  root: string,
  accepts: (file: string) => boolean,
  output: string[],
): void {
  if (!fs.existsSync(root)) return;
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Managed state root must be a real directory: ${root}`);
  }
  const visit = (directory: string, depth = 0): void => {
    if (depth > MAX_INVENTORY_DEPTH) {
      throw new Error(`Managed state exceeds depth ${MAX_INVENTORY_DEPTH}: ${directory}`);
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (EXCLUDED_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      const diskPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(diskPath);
      if (stat.isSymbolicLink()) throw new Error(`Managed state contains a symlink: ${diskPath}`);
      if (stat.isDirectory()) visit(diskPath, depth + 1);
      else if (stat.isFile() && accepts(diskPath)) {
        if (stat.nlink !== 1) throw new Error(`Managed state contains a hardlink: ${diskPath}`);
        if (output.length >= MAX_INVENTORY_FILES) {
          throw new Error(`Managed state exceeds ${MAX_INVENTORY_FILES} files`);
        }
        output.push(diskPath);
      }
      else if (!stat.isFile()) throw new Error(`Managed state contains a special device: ${diskPath}`);
    }
  };
  visit(root);
}

interface Candidate {
  diskPath: string;
  eggPath: string;
  dimension: string;
  privacy: PrivacyClass;
  config?: boolean;
  sqlite?: boolean;
}

async function validateSqliteBytes(label: string, bytes: Uint8Array): Promise<void> {
  const module = await import('better-sqlite3');
  const Database = module.default as unknown as new (source: Buffer) => {
    pragma(value: string, options?: { simple?: boolean }): unknown;
    close(): void;
  };
  const image = Buffer.from(bytes);
  if (image.length >= 20) {
    image[18] = 1;
    image[19] = 1;
  }
  const database = new Database(image);
  try {
    database.pragma('query_only = ON');
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`${label} failed SQLite integrity_check: ${String(integrity)}`);
    const foreignKeys = database.pragma('foreign_key_check') as unknown[];
    if (Array.isArray(foreignKeys) && foreignKeys.length) {
      throw new Error(`${label} failed SQLite foreign_key_check`);
    }
  } finally {
    database.close();
  }
}

function clonePrivateTree(source: string, target: string): void {
  let files = 0;
  let bytes = 0;
  const available = fs.statfsSync(path.dirname(target));
  const freeBytes = available.bavail * available.bsize;
  const visit = (from: string, to: string, depth: number): void => {
    if (depth > MAX_INVENTORY_DEPTH) throw new Error('Organism generation exceeds depth limit');
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (EXCLUDED_NAMES.has(entry.name) || entry.name === '.organism-maintenance.lock') continue;
      const input = path.join(from, entry.name);
      const output = path.join(to, entry.name);
      const stat = fs.lstatSync(input);
      if (stat.isSymbolicLink()) throw new Error(`Generation staging refuses symlink ${input}`);
      if (stat.isDirectory()) {
        fs.mkdirSync(output, { mode: stat.mode & 0o777 });
        visit(input, output, depth + 1);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`Generation staging refuses hardlink ${input}`);
        if (
          process.platform !== 'win32'
          && stat.size > 0
          && stat.blocks * 512 < stat.size
        ) {
          throw new Error(`Generation staging refuses sparse file ${input}`);
        }
        files += 1;
        bytes += stat.size;
        if (files > MAX_INVENTORY_FILES || bytes > MAX_INVENTORY_BYTES || bytes > freeBytes) {
          throw new Error('Insufficient bounded capacity for complete organism generation');
        }
        const read = safeRead(source, input, MAX_MEDIA_FILE);
        fs.writeFileSync(output, read.bytes, { flag: 'wx', mode: read.mode });
        hardenPrivatePath(output);
        if (process.platform !== 'win32') fs.chmodSync(output, read.mode);
        if (read.mtimeMs > 0) fs.utimesSync(output, read.mtimeMs / 1000, read.mtimeMs / 1000);
      } else {
        throw new Error(`Generation staging refuses special file ${input}`);
      }
    }
  };
  visit(source, target, 0);
}

async function validateGenerationTree(root: string): Promise<void> {
  const files: string[] = [];
  walk(root, () => true, files);
  const agentNames = new Set<string>();
  for (const file of files) {
    const stat = fs.lstatSync(file);
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
      throw new Error(`Staged state is group/world writable: ${file}`);
    }
    if (/\.(?:db|sqlite|sqlite3)$/i.test(file)) {
      await validateSqliteBytes(file, safeRead(root, file).bytes);
    } else if (/config\.json5$/i.test(file)) {
      JSON5.parse(safeRead(root, file).bytes.toString('utf8'));
    } else if (/config\.json$/i.test(file)) {
      JSON.parse(safeRead(root, file).bytes.toString('utf8'));
    } else if (/config\.ya?ml$/i.test(file)) {
      YAML.parse(safeRead(root, file).bytes.toString('utf8'));
    } else if (MIDI.test(file)) {
      validateMidi(safeRead(root, file, MAX_MEDIA_FILE).bytes);
    }
    const relative = portable(path.relative(root, file));
    if (relative === 'rappid.body.json') {
      const body = JSON.parse(safeRead(root, file).bytes.toString('utf8')) as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('RAPPID body must be a JSON object');
      }
    }
    if (relative.startsWith('agents/') && /\.(?:py|js|mjs|ts)$/i.test(relative)) {
      if (stat.size === 0) throw new Error(`Agent contract is empty: ${relative}`);
      const folded = path.basename(relative).toLocaleLowerCase('en-US');
      if (agentNames.has(folded)) throw new Error(`Agent registry collision: ${relative}`);
      agentNames.add(folded);
    }
    if (relative.endsWith('/SKILL.md') && stat.size === 0) {
      throw new Error(`Skill contract is empty: ${relative}`);
    }
  }
}

export class LocalOrganismAdapter implements EggStateAdapter {
  readonly home: string;

  constructor(home = openrappterHome()) {
    this.home = path.resolve(home);
  }

  private candidates(
    includeHistory: boolean,
    includeIdentitySeed = false,
    exact = false,
  ): Candidate[] {
    const values: Candidate[] = [];
    const add = (
      relative: string,
      dimension: string,
      options: Partial<Candidate> = {},
    ): void => {
      const diskPath = path.join(this.home, relative);
      if (!fs.existsSync(diskPath)) return;
      if (!exact && REAUTH_FILES.test(portable(relative))) return;
      values.push({
        diskPath,
        eggPath: `state/${portable(relative)}`,
        dimension,
        privacy: 'private',
        ...options,
      });
    };
    for (const name of ['SOUL.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) add(name, 'identity');
    for (const name of ['rappid.body.json', 'traits.json', 'dimensions.json']) add(name, 'rappid');
    if (includeIdentitySeed) add('rappid.tail', 'rappid', { privacy: 'sensitive-encrypted' });
    add('config.json', 'channels-config', { config: true });
    add('config.json5', 'channels-config', { config: true });
    add('config.yaml', 'channels-config', { config: true });
    add('config.yml', 'channels-config', { config: true });
    if (exact) {
      for (const name of ['.env', 'auth-profiles.json', 'credentials.json', 'tokens.json']) {
        add(name, 'reauthentication', { privacy: 'sensitive-encrypted' });
      }
    }
    for (const name of [
      'memory.json', 'cron.json', 'jobs.json', 'preferences.json', 'drafts.json',
      'release-ring.json', 'release-receipts.json', 'clever-girl.json',
      'flight-lineage.jsonl',
    ]) add(name, name.includes('memory') ? 'memory' : 'state');
    for (const name of [
      'openrappter.db',
      'memory.db',
      'show-and-tell.db',
      path.join('state', 'imessage.sqlite'),
    ]) add(name, 'storage', { sqlite: true });
    if (includeHistory) {
      add('sessions.json', 'sessions');
      for (const name of ['sessions.db', 'messages.db', 'flight-recorder.db']) add(name, 'sessions', { sqlite: true });
    }
    const managedDirectories: Array<[string, string]> = [
      ['agents', 'agents'],
      ['skills', 'skills'],
      ['xpedition', 'xpedition'],
      ['living-company', 'living-company'],
      ['clever-girl', 'clever-girl'],
      ['release', 'release'],
      ['resources', 'resources'],
    ];
    for (const [relative, dimension] of managedDirectories) {
      const root = path.join(this.home, relative);
      const files: string[] = [];
      walk(
        root,
        (file) => exact
          ? !/(?:^|[/\\])(?:node_modules|dist|build|logs?|cache|downloads?)(?:[/\\]|$)/i.test(file)
          : SAFE_RESOURCE.test(file),
        files,
      );
      for (const diskPath of files) {
        if (!exact && REAUTH_FILES.test(portable(path.relative(this.home, diskPath)))) continue;
        values.push({
          diskPath,
          eggPath: `${dimension}/${portable(path.relative(root, diskPath))}`,
          dimension,
          privacy: 'private',
        });
      }
    }
    return values.sort((left, right) => left.eggPath.localeCompare(right.eggPath));
  }

  async inventory(options: {
    mode?: 'portable' | 'sealed-backup';
    exact?: boolean;
    includeHistory: boolean;
    includeMedia: boolean;
    acknowledgeUnknownLicense: boolean;
    mediaPaths?: string[];
  }): Promise<InventoryResult> {
    const tailPath = path.join(this.home, 'rappid.tail');
    const tail = safeRead(this.home, tailPath, 1024).bytes.toString('utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(tail)) {
      throw new Error('This organism has no valid rappid.tail; export is read-only and will not mint one');
    }
    const digest = createHash('sha256').update('rapp/1:rappid\n').update(tail).digest('hex');
    const rappid = `rappid:@openrappter/organism:${digest}`;
    const files: InventoryFile[] = [];
    let totalBytes = 0;
    const pushBounded = (file: InventoryFile): void => {
      if (files.length >= MAX_INVENTORY_FILES) {
        throw new Error(`Organism inventory exceeds ${MAX_INVENTORY_FILES} files`);
      }
      totalBytes += file.bytes.length;
      if (totalBytes > MAX_INVENTORY_BYTES) {
        throw new Error(`Organism inventory exceeds ${MAX_INVENTORY_BYTES} bytes`);
      }
      files.push(file);
    };
    const exclusions = [
      'credentials, tokens, auth profiles, private keys, and OS/Keychain secrets',
      'logs, caches, downloads, sockets, PIDs, lock files, node_modules, and build output',
      ...(options.includeHistory ? [] : ['sessions, message history, and Flight event history']),
    ];
    const reauthentication = [
      'GitHub Copilot',
      'configured channels and external providers',
      'device-bound credentials',
    ];
    for (const candidate of this.candidates(
      options.includeHistory,
      options.mode === 'sealed-backup',
      options.exact === true,
    )) {
      assertSafeAncestors(this.home, candidate.diskPath);
      const candidateStat = fs.lstatSync(candidate.diskPath);
      if (totalBytes + candidateStat.size > MAX_INVENTORY_BYTES) {
        throw new Error(`Organism inventory exceeds ${MAX_INVENTORY_BYTES} bytes before read`);
      }
      const read = candidate.sqlite
        ? {
            bytes: await sqliteSnapshot(candidate.diskPath, options.exact === true),
            ...(() => {
              const stat = fs.lstatSync(candidate.diskPath);
              return {
                mode: stat.mode & 0o777,
                mtimeMs: Math.floor(stat.mtimeMs / 1000) * 1000,
              };
            })(),
          }
        : safeRead(this.home, candidate.diskPath);
      const bytes = (
        !options.exact && (candidate.config || /\.(?:json|json5|jsonl|ya?ml|toml)$/i.test(candidate.diskPath))
      ) ? sanitizeConfig(read.bytes, candidate.diskPath) : read.bytes;
      pushBounded({
        path: candidate.eggPath,
        bytes,
        mime: candidate.sqlite ? 'application/vnd.sqlite3' : mimeFor(candidate.diskPath),
        dimension: candidate.dimension,
        privacy: candidate.privacy,
        provenance: {
          origin: portable(path.relative(this.home, candidate.diskPath)),
          license: 'user-owned-state',
          owned: true,
        },
        mode: read.mode,
        mtimeMs: read.mtimeMs,
        destination: candidate.diskPath,
      });
    }

    if (options.includeMedia) {
      const roots = options.mediaPaths?.length
        ? options.mediaPaths.map((value) => path.resolve(value))
        : [path.join(this.home, 'media'), path.join(this.home, 'sounds')];
      const mediaFiles: string[] = [];
      for (const root of roots) {
        if (!contained(this.home, root)) throw new Error(`Media path is outside organism home: ${root}`);
        if (!fs.existsSync(root)) continue;
        const stat = fs.lstatSync(root);
        if (stat.isSymbolicLink()) throw new Error(`Media path is a symlink: ${root}`);
        if (stat.isFile()) mediaFiles.push(root);
        else if (stat.isDirectory()) walk(root, (file) => SOUND.test(file) || MIDI.test(file), mediaFiles);
        else throw new Error(`Media path is not a regular file or directory: ${root}`);
      }
      for (const diskPath of [...new Set(mediaFiles)].sort()) {
        if (
          portable(path.relative(this.home, diskPath))
          === 'media/generated/organism-theme.mid'
        ) continue;
        const metadata = mediaMetadata(diskPath);
        if (
          !metadata
          || !metadata.owned
          || !KNOWN_MEDIA_LICENSES.has(metadata.license)
        ) {
          if (!options.acknowledgeUnknownLicense) {
            exclusions.push(`media excluded (license not acknowledged): ${path.basename(diskPath)}`);
            continue;
          }
        }
        const mediaStat = fs.lstatSync(diskPath);
        if (totalBytes + mediaStat.size > MAX_INVENTORY_BYTES) {
          throw new Error(`Organism inventory exceeds ${MAX_INVENTORY_BYTES} bytes before media read`);
        }
        const read = safeRead(this.home, diskPath, MAX_MEDIA_FILE);
        if (MIDI.test(diskPath)) validateMidi(read.bytes);
        const relative = portable(path.relative(this.home, diskPath));
        pushBounded({
          path: `media/${relative}`,
          bytes: read.bytes,
          mime: mimeFor(diskPath),
          dimension: MIDI.test(diskPath) ? 'midi' : 'media',
          privacy: 'private',
          provenance: {
            origin: metadata?.origin ?? relative,
            license: metadata?.license ?? 'unknown-acknowledged',
            owned: metadata?.owned ?? true,
          },
          mode: read.mode,
          mtimeMs: read.mtimeMs,
          destination: diskPath,
        });
      }
    }
    const theme = generateOrganismTheme(rappid);
    validateMidi(theme);
    pushBounded({
      path: 'media/media/generated/organism-theme.mid',
      bytes: theme,
      mime: 'audio/midi',
      dimension: 'midi',
      privacy: 'private',
      provenance: {
        origin: 'organism RAPPID digest',
        license: 'CC0-1.0',
        owned: true,
        generated: true,
        generator: 'openrappter-organism-theme/1',
      },
      mode: 0o600,
      mtimeMs: 0,
      destination: path.join(this.home, 'media', 'generated', 'organism-theme.mid'),
    });

    const count = (dimension: string): number => files.filter((file) => file.dimension === dimension).length;
    return {
      rappid,
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      dimensions: {
        agents: count('agents'),
        skills: count('skills'),
        memories: count('memory'),
        cronJobs: files.filter((file) => /(?:cron|jobs)/.test(file.path)).length,
        sessions: count('sessions'),
        media: count('media'),
        midi: count('midi'),
      },
      exclusions,
      reauthentication,
      epoch: createHash('sha256').update(files.map((file) => (
        `${file.path}\0${file.bytes.length}\0${file.mode}\0${file.mtimeMs}\0`
      )).join('')).digest('hex'),
    };
  }

  private destination(eggPath: string): string {
    const parts = eggPath.split('/');
    let relative: string;
    if (parts[0] === 'state') relative = parts.slice(1).join('/');
    else if (['agents', 'skills', 'xpedition', 'living-company', 'clever-girl', 'release', 'resources'].includes(parts[0])) {
      relative = parts.join('/');
    } else if (parts[0] === 'media') {
      relative = parts.slice(1).join('/');
    } else {
      throw new Error(`Egg path has no authoritative state adapter: ${eggPath}`);
    }
    const destination = path.resolve(this.home, ...relative.split('/'));
    assertSafeAncestors(this.home, destination);
    return destination;
  }

  async withSnapshotFence<T>(operation: () => Promise<T>): Promise<T> {
    if (
      this.home === path.resolve(openrappterHome())
      && isGatewayRunning()
      && process.env.OPENRAPPTER_EGG_GATEWAY_MAINTENANCE !== '1'
    ) {
      throw new Error(
        'The gateway owns live organism state. Stop it or invoke the gateway maintenance snapshot API.',
      );
    }
    return withOrganismSnapshotFence(this.home, operation);
  }

  async validateStaged(
    files: InventoryFile[],
    context: {
      semantics: 'restore' | 'clone';
      sourceRappid: string;
      targetRappid: string;
      mode: 'portable' | 'sealed-backup';
    },
  ): Promise<void> {
    if (context.mode === 'portable' && context.semantics !== 'clone') {
      throw new Error('Portable eggs are clone-only and cannot restore identity');
    }
    const identityPaths = files.filter((file) => (
      /(?:^|\/)(?:rappid\.tail|.*private.*key|device.*key|organism.*key)$/i.test(file.path)
    ));
    if (context.mode === 'portable' && identityPaths.length) {
      throw new Error(`Portable egg contains identity seed ${identityPaths[0].path}`);
    }
    if (context.mode === 'sealed-backup' && context.semantics === 'restore') {
      const tailFile = files.find((file) => file.path === 'state/rappid.tail');
      if (!tailFile) throw new Error('Sealed identity restore requires state/rappid.tail');
      const tail = Buffer.from(tailFile.bytes).toString('utf8').trim();
      const digest = createHash('sha256').update('rapp/1:rappid\n').update(tail).digest('hex');
      if (`rappid:@openrappter/organism:${digest}` !== context.sourceRappid) {
        throw new Error('Sealed identity seed does not match the source RAPPID');
      }
      if (context.targetRappid !== context.sourceRappid) {
        throw new Error('Sealed restore target confirmation does not match the source RAPPID');
      }
    }
    const agentNames = new Set<string>();
    for (const file of files) {
      if (file.mime === 'application/vnd.sqlite3') {
        await validateSqliteBytes(file.path, file.bytes);
      } else if (file.mime === 'audio/midi') {
        validateMidi(file.bytes);
      } else if (/config\.(?:json|json5|ya?ml)$/i.test(file.path)) {
        const text = Buffer.from(file.bytes).toString('utf8');
        if (/\.json$/i.test(file.path)) JSON.parse(text);
        else if (/\.json5$/i.test(file.path)) JSON5.parse(text);
        else YAML.parse(text);
      }
      if (file.dimension === 'agents') {
        const folded = path.basename(file.path).toLocaleLowerCase('en-US');
        if (agentNames.has(folded)) throw new Error(`Agent registry collision: ${file.path}`);
        agentNames.add(folded);
      }
    }
  }

  async apply(
    files: InventoryFile[],
    context: {
      semantics: 'restore' | 'clone';
      sourceRappid: string;
      mode?: 'portable' | 'sealed-backup';
      includesHistory?: boolean;
      includesMedia?: boolean;
      targetRappid: string;
      expectedStateDigest: string;
    },
  ): Promise<EggApplyReceipt> {
    await this.validateStaged(files, {
      semantics: context.semantics,
      sourceRappid: context.sourceRappid,
      targetRappid: context.targetRappid,
      mode: context.mode ?? 'portable',
    });
    const stagedFiles = files;
    const generation = `${Date.now()}-${createHash('sha256')
      .update(stagedFiles.map((file) => `${file.path}\0${file.bytes.length}`).join(''))
      .digest('hex').slice(0, 12)}`;
    const parent = path.dirname(this.home);
    const base = path.basename(this.home);
    const staged = path.join(parent, `.${base}.egg-stage-${generation}`);
    const prior = path.join(parent, `.${base}.egg-prior-${generation}`);
    const journal = path.join(parent, `.${base}.egg-recovery.json`);
    if (fs.existsSync(staged) || fs.existsSync(prior) || fs.existsSync(journal)) {
      throw new Error('An organism generation recovery is already pending');
    }
    fs.mkdirSync(staged, { recursive: false, mode: 0o700 });
    hardenPrivatePath(staged, true);
    clonePrivateTree(this.home, staged);

    const managed = this.candidates(
      context.includesHistory === true,
      context.mode === 'sealed-backup' && context.semantics === 'restore',
    );
    for (const candidate of managed) {
      fs.rmSync(path.join(staged, path.relative(this.home, candidate.diskPath)), { force: true });
    }
    if (context.includesMedia) {
      for (const root of ['media', 'sounds']) {
        fs.rmSync(path.join(staged, root), { recursive: true, force: true });
      }
    }
    for (const file of stagedFiles) {
      if (context.semantics === 'clone' && file.path === 'state/rappid.tail') continue;
      const liveDestination = this.destination(file.path);
      const destination = path.join(staged, path.relative(this.home, liveDestination));
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(destination, 'wx', file.mode || 0o600);
      try {
        fs.writeFileSync(descriptor, file.bytes);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      hardenPrivatePath(destination);
      if (process.platform !== 'win32') fs.chmodSync(destination, file.mode || 0o600);
      if (file.mtimeMs > 0) fs.utimesSync(destination, file.mtimeMs / 1000, file.mtimeMs / 1000);
    }
    await validateGenerationTree(staged);
    fs.writeFileSync(journal, JSON.stringify({
      schema: 'openrappter-egg-recovery/1',
      status: 'prepared',
      home: this.home,
      staged,
      prior,
      generation,
    }), { flag: 'wx', mode: 0o600 });
    hardenPrivatePath(journal);
    fs.renameSync(this.home, prior);
    try {
      fs.renameSync(staged, this.home);
      syncParentDirectory(parent);
      fs.writeFileSync(journal, JSON.stringify({
        schema: 'openrappter-egg-recovery/1',
        status: 'swapped',
        home: this.home,
        prior,
        generation,
      }), { mode: 0o600 });
    } catch (error) {
      fs.renameSync(prior, this.home);
      throw error;
    }
    return {
      generation,
      priorGeneration: prior,
      stateDigest: context.expectedStateDigest,
    };
  }

  async commit(receipt: EggApplyReceipt): Promise<void> {
    if (receipt.priorGeneration) {
      fs.rmSync(receipt.priorGeneration, { recursive: true, force: true });
    }
    fs.rmSync(path.join(path.dirname(this.home), `.${path.basename(this.home)}.egg-recovery.json`), { force: true });
  }

  async rollback(receipt: EggApplyReceipt): Promise<void> {
    if (!receipt.priorGeneration || !fs.existsSync(receipt.priorGeneration)) {
      throw new Error('Exact prior organism generation is unavailable');
    }
    const parent = path.dirname(this.home);
    const failed = path.join(parent, `.${path.basename(this.home)}.egg-failed-${receipt.generation}`);
    fs.renameSync(this.home, failed);
    try {
      fs.renameSync(receipt.priorGeneration, this.home);
      syncParentDirectory(parent);
      await validateGenerationTree(this.home);
      fs.rmSync(failed, { recursive: true, force: true });
      fs.rmSync(path.join(parent, `.${path.basename(this.home)}.egg-recovery.json`), { force: true });
    } catch (error) {
      if (!fs.existsSync(this.home) && fs.existsSync(failed)) fs.renameSync(failed, this.home);
      throw error;
    }
  }

  async healthProbe(): Promise<{ ok: boolean; detail: string }> {
    try {
      await validateGenerationTree(this.home);
      const tail = safeRead(this.home, path.join(this.home, 'rappid.tail'), 1024)
        .bytes.toString('utf8').trim();
      return /^[0-9a-f]{64}$/.test(tail)
        ? { ok: true, detail: 'RAPPID, SQLite, config, registry, skills, media, and gateway state are healthy' }
        : { ok: false, detail: 'RAPPID tail is invalid after import' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
