import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { openrappterHome } from '../infra/openrappter-home.js';
import { generateOrganismTheme, validateMidi } from './midi.js';
import type {
  EggStateAdapter,
  InventoryFile,
  InventoryResult,
  PrivacyClass,
} from './types.js';

const MAX_STATE_FILE = 64 * 1024 * 1024;
const MAX_MEDIA_FILE = 64 * 1024 * 1024;
const SAFE_RESOURCE = /\.(?:json|jsonl|md|txt|yaml|yml|toml|py|js|mjs|ts|sh|card|tile)$/i;
const SOUND = /\.(?:wav|mp3|flac|ogg|m4a|aac)$/i;
const MIDI = /\.(?:mid|midi)$/i;
const SECRET_KEY = /(?:^|_)(?:api_?key|access_?token|refresh_?token|token|password|passwd|secret|credential|private_?key|authorization)(?:$|_)/i;
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

function safeRead(root: string, file: string, maximum = MAX_STATE_FILE): Buffer {
  assertSafeAncestors(root, file);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size > maximum) {
      throw new Error(`State path is not a supported regular file: ${file}`);
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || after.size !== bytes.length) {
      throw new Error(`State file changed while it was read: ${file}`);
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? '[REAUTHENTICATE]' : redactConfig(item);
  }
  return output;
}

function sanitizeConfig(bytes: Buffer, file: string): Buffer {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    return Buffer.from(`${JSON.stringify(redactConfig(parsed), null, 2)}\n`, 'utf8');
  } catch {
    if (file.endsWith('.json5')) {
      const lines = bytes.toString('utf8').split(/\r?\n/).map((line) => (
        SECRET_KEY.test(line.split(':', 1)[0] ?? '') ? '  // [REAUTHENTICATE]' : line
      ));
      return Buffer.from(lines.join('\n'), 'utf8');
    }
    throw new Error(`Configuration is not valid JSON: ${file}`);
  }
}

async function sqliteSnapshot(file: string): Promise<Buffer> {
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
  const database = new Database(file, { fileMustExist: true });
  let snapshot: Buffer;
  try {
    database.pragma('wal_checkpoint(PASSIVE)');
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
  const sanitized = new Database(memoryImage);
  try {
    const tables = sanitized.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all().map((row) => String(row.name));
    for (const table of tables) {
      const quotedTable = `"${table.replaceAll('"', '""')}"`;
      if (/(?:auth|credential|token|secret|private.?key)/i.test(table)) {
        sanitized.exec(`DELETE FROM ${quotedTable}`);
        continue;
      }
      const columns = sanitized.prepare(`PRAGMA table_info(${quotedTable})`).all();
      for (const column of columns) {
        const name = String(column.name);
        const quotedColumn = `"${name.replaceAll('"', '""')}"`;
        if (SECRET_KEY.test(name)) {
          sanitized.exec(`UPDATE ${quotedTable} SET ${quotedColumn} = '[REAUTHENTICATE]'`);
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
            replacement = JSON.stringify(redactConfig(JSON.parse(replacement)));
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
    return sanitized.serialize();
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
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (EXCLUDED_NAMES.has(entry.name) || entry.name.startsWith('.')) continue;
      const diskPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(diskPath);
      if (stat.isSymbolicLink()) throw new Error(`Managed state contains a symlink: ${diskPath}`);
      if (stat.isDirectory()) visit(diskPath);
      else if (stat.isFile() && accepts(diskPath)) output.push(diskPath);
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

export class LocalOrganismAdapter implements EggStateAdapter {
  readonly home: string;

  constructor(home = openrappterHome()) {
    this.home = path.resolve(home);
  }

  private candidates(includeHistory: boolean, includeIdentitySeed = false): Candidate[] {
    const values: Candidate[] = [];
    const add = (
      relative: string,
      dimension: string,
      options: Partial<Candidate> = {},
    ): void => {
      const diskPath = path.join(this.home, relative);
      if (!fs.existsSync(diskPath)) return;
      if (REAUTH_FILES.test(portable(relative))) return;
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
    for (const name of [
      'memory.json', 'cron.json', 'jobs.json', 'preferences.json', 'drafts.json',
      'release-ring.json', 'release-receipts.json', 'clever-girl.json',
      'flight-lineage.jsonl',
    ]) add(name, name.includes('memory') ? 'memory' : 'state');
    for (const name of ['openrappter.db', 'memory.db']) add(name, 'storage', { sqlite: true });
    if (includeHistory) {
      for (const name of ['sessions.db', 'messages.db', 'flight-recorder.db']) {
        add(name, 'sessions', { sqlite: true });
      }
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
      walk(root, (file) => SAFE_RESOURCE.test(file), files);
      for (const diskPath of files) {
        if (REAUTH_FILES.test(portable(path.relative(this.home, diskPath)))) continue;
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
    includeHistory: boolean;
    includeMedia: boolean;
    acknowledgeUnknownLicense: boolean;
    mediaPaths?: string[];
  }): Promise<InventoryResult> {
    const tailPath = path.join(this.home, 'rappid.tail');
    const tail = safeRead(this.home, tailPath, 1024).toString('utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(tail)) {
      throw new Error('This organism has no valid rappid.tail; export is read-only and will not mint one');
    }
    const digest = createHash('sha256').update('rapp/1:rappid\n').update(tail).digest('hex');
    const rappid = `rappid:@openrappter/organism:${digest}`;
    const files: InventoryFile[] = [];
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
    )) {
      assertSafeAncestors(this.home, candidate.diskPath);
      const bytes = candidate.sqlite
        ? await sqliteSnapshot(candidate.diskPath)
        : safeRead(this.home, candidate.diskPath);
      files.push({
        path: candidate.eggPath,
        bytes: candidate.config ? sanitizeConfig(bytes, candidate.diskPath) : bytes,
        mime: candidate.sqlite ? 'application/vnd.sqlite3' : mimeFor(candidate.diskPath),
        dimension: candidate.dimension,
        privacy: candidate.privacy,
        provenance: {
          origin: portable(path.relative(this.home, candidate.diskPath)),
          license: 'user-owned-state',
          owned: true,
        },
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
        const bytes = safeRead(this.home, diskPath, MAX_MEDIA_FILE);
        if (MIDI.test(diskPath)) validateMidi(bytes);
        const relative = portable(path.relative(this.home, diskPath));
        files.push({
          path: `media/${relative}`,
          bytes,
          mime: mimeFor(diskPath),
          dimension: MIDI.test(diskPath) ? 'midi' : 'media',
          privacy: 'private',
          provenance: {
            origin: metadata?.origin ?? relative,
            license: metadata?.license ?? 'unknown-acknowledged',
            owned: metadata?.owned ?? true,
          },
          destination: diskPath,
        });
      }
    }
    const theme = generateOrganismTheme(rappid);
    validateMidi(theme);
    files.push({
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

  async apply(
    files: InventoryFile[],
    context: {
      semantics: 'restore' | 'clone';
      sourceRappid: string;
      mode?: 'portable' | 'sealed-backup';
      includesHistory?: boolean;
      includesMedia?: boolean;
    },
  ): Promise<void> {
    const incoming = new Map(files.map((file) => [this.destination(file.path), file]));
    if (context.semantics === 'clone') {
      incoming.delete(path.join(this.home, 'rappid.tail'));
    }
    const current = this.candidates(
      context.includesHistory === true,
      context.mode === 'sealed-backup' && context.semantics === 'restore',
    ).map((candidate) => candidate.diskPath);
    if (context.includesMedia) {
      for (const mediaRoot of [path.join(this.home, 'media'), path.join(this.home, 'sounds')]) {
        walk(mediaRoot, (file) => SOUND.test(file) || MIDI.test(file), current);
      }
    }
    const touched = new Set([...incoming.keys(), ...current]);
    const snapshots = new Map<string, { bytes: Buffer; mode: number } | null>();
    for (const destination of touched) {
      if (!fs.existsSync(destination)) {
        snapshots.set(destination, null);
        continue;
      }
      const stat = fs.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe import destination: ${destination}`);
      snapshots.set(destination, { bytes: fs.readFileSync(destination), mode: stat.mode & 0o777 });
    }
    const writeAtomic = (destination: string, bytes: Uint8Array): void => {
      assertSafeAncestors(this.home, destination);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      const temporary = `${destination}.egg-${process.pid}-${Date.now()}`;
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      fs.renameSync(temporary, destination);
      try { fs.chmodSync(destination, 0o600); } catch { /* Windows ACLs are best effort. */ }
      try {
        const directory = fs.openSync(path.dirname(destination), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } catch { /* Some Windows filesystems cannot fsync directories. */ }
    };
    try {
      for (const [destination, file] of incoming) writeAtomic(destination, file.bytes);
      for (const destination of current) {
        if (!incoming.has(destination)) fs.rmSync(destination, { force: true });
      }
    } catch (error) {
      for (const [destination, snapshot] of snapshots) {
        if (snapshot === null) fs.rmSync(destination, { force: true });
        else {
          writeAtomic(destination, snapshot.bytes);
          try { fs.chmodSync(destination, snapshot.mode); } catch { /* Windows */ }
        }
      }
      throw error;
    }
  }

  async healthProbe(): Promise<{ ok: boolean; detail: string }> {
    try {
      const tail = safeRead(this.home, path.join(this.home, 'rappid.tail'), 1024)
        .toString('utf8').trim();
      return /^[0-9a-f]{64}$/.test(tail)
        ? { ok: true, detail: 'RAPPID and managed state are readable' }
        : { ok: false, detail: 'RAPPID tail is invalid after import' };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
