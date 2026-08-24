import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  ORGANISM_EGG_PROFILE,
  RAPP_EGG_SCHEMA,
  type EggPublicHeader,
} from './types.js';

export const MAX_EGG_FILES = 5_000;
export const MAX_EGG_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_EGG_BYTES = 1024 * 1024 * 1024;
export const MAX_EGG_DEPTH = 32;
const MAX_RATIO = 200;
const FIXED_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:(?:[0-5]\d)\.\d{3}Z$/;
const RAPPID =
  /^rappid:@[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*:[0-9a-f]{64}$/;
const SCRYPT = Object.freeze({ N: 1 << 15, r: 8, p: 1, keyBytes: 32 });

export function canonical(value: unknown): string {
  const visit = (item: unknown, depth: number): string => {
    if (depth > 64) throw new Error('Canonical JSON nesting exceeds 64');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) {
        throw new Error('Canonical JSON contains an invalid number');
      }
      return JSON.stringify(item);
    }
    if (typeof item === 'string') {
      if (item !== item.normalize('NFC')) throw new Error('Canonical JSON strings must be NFC');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) {
      return `[${item.map((entry) => visit(entry, depth + 1)).join(',')}]`;
    }
    if (typeof item === 'object') {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Canonical JSON requires plain objects');
      }
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => (
        `${visit(key, depth + 1)}:${visit(record[key], depth + 1)}`
      )).join(',')}}`;
    }
    throw new Error(`Canonical JSON cannot encode ${typeof item}`);
  };
  const output = visit(value, 0);
  if (Buffer.byteLength(output) > 1024 * 1024) {
    throw new Error('Canonical JSON exceeds the RAPP/1 1 MiB limit');
  }
  return output;
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function rappHash(space: string, bytes: Uint8Array): string {
  return createHash('sha256')
    .update(space, 'ascii')
    .update('\n', 'ascii')
    .update(bytes)
    .digest('hex');
}

export function assertEggPath(candidate: string): string {
  if (
    !candidate
    || candidate !== candidate.normalize('NFC')
    || candidate.includes('\\')
    || candidate.includes('\0')
    || candidate.startsWith('/')
    || /^[a-zA-Z]:/.test(candidate)
    || candidate.startsWith('//')
  ) {
    throw new Error(`Unsafe egg path: ${candidate}`);
  }
  const parts = candidate.split('/');
  if (
    parts.length > MAX_EGG_DEPTH
    || parts.some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe egg path: ${candidate}`);
  }
  return candidate;
}

function assertUniquePaths(paths: string[]): void {
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const raw of paths) {
    const candidate = assertEggPath(raw);
    const fold = candidate.toLocaleLowerCase('en-US');
    if (exact.has(candidate)) throw new Error(`Duplicate egg path: ${candidate}`);
    if (folded.has(fold)) throw new Error(`Case-colliding egg path: ${candidate}`);
    exact.add(candidate);
    folded.add(fold);
  }
}

interface ZipEntry {
  name: string;
  compressed: number;
  uncompressed: number;
  method: number;
  flags: number;
  externalAttributes: number;
}

function scanZip(blob: Uint8Array): ZipEntry[] {
  const bytes = Buffer.from(blob);
  let eocd = -1;
  for (let index = Math.max(0, bytes.length - 65_557); index <= bytes.length - 22; index += 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) eocd = index;
  }
  if (eocd < 0) throw new Error('Egg is not a complete ZIP archive');
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk || centralDisk || count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('Multi-disk and ZIP64 eggs are not supported');
  }
  if (count < 1 || count > MAX_EGG_FILES + 1) throw new Error('Egg file-count limit exceeded');
  if (centralOffset + centralSize > eocd) throw new Error('Egg central directory is invalid');
  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Egg central directory entry is invalid');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const externalAttributes = bytes.readUInt32LE(offset + 38);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error('Egg central directory entry is truncated');
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
      );
    } catch {
      throw new Error('Egg path is not valid UTF-8');
    }
    if ((flags & 1) !== 0) throw new Error(`ZIP-level encryption is forbidden: ${name}`);
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP method for ${name}`);
    if (uncompressed > MAX_EGG_FILE_BYTES && name !== 'organism/sealed.bin') {
      throw new Error(`Egg entry exceeds the per-file limit: ${name}`);
    }
    if (compressed === 0 && uncompressed > 0) throw new Error(`Invalid compression ratio: ${name}`);
    if (compressed > 0 && uncompressed / compressed > MAX_RATIO) {
      throw new Error(`Egg entry exceeds the compression-ratio limit: ${name}`);
    }
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0o170000;
    if (fileType !== 0 && fileType !== 0o100000) {
      throw new Error(`Egg entry is not a regular file: ${name}`);
    }
    total += uncompressed;
    if (total > MAX_EGG_BYTES) throw new Error('Egg expanded-size limit exceeded');
    entries.push({ name, compressed, uncompressed, method, flags, externalAttributes });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new Error('Egg central directory size mismatch');
  assertUniquePaths(entries.map((entry) => entry.name));
  return entries;
}

interface RappManifest {
  schema: typeof RAPP_EGG_SCHEMA;
  variant: 'rapplication';
  rappid: string;
  created_utc: string;
  contents: Array<{ path: string; hash: string }>;
  payload: Record<string, unknown>;
  sig: null;
}

export function packRappEgg(input: {
  rappid: string;
  createdUtc: string;
  files: Record<string, Uint8Array>;
  payload: Record<string, unknown>;
}): Uint8Array {
  if (!RAPPID.test(input.rappid)) throw new Error('Invalid organism RAPPID');
  if (!FIXED_UTC.test(input.createdUtc)) throw new Error('createdUtc must be millisecond UTC');
  const paths = Object.keys(input.files).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  assertUniquePaths(paths);
  if (paths.length > MAX_EGG_FILES) throw new Error('Egg file-count limit exceeded');
  let total = 0;
  for (const entryPath of paths) {
    const size = input.files[entryPath].length;
    if (size > MAX_EGG_FILE_BYTES && entryPath !== 'organism/sealed.bin') {
      throw new Error(`Egg entry exceeds the per-file limit: ${entryPath}`);
    }
    total += size;
    if (total > MAX_EGG_BYTES) throw new Error('Egg expanded-size limit exceeded');
  }
  const contents = paths.map((entryPath) => ({
    path: entryPath,
    hash: rappHash('rapp/1:egg', input.files[entryPath]),
  }));
  const manifest: RappManifest = {
    schema: RAPP_EGG_SCHEMA,
    variant: 'rapplication',
    rappid: input.rappid,
    created_utc: input.createdUtc,
    contents,
    payload: input.payload,
    sig: null,
  };
  const options = { level: 0 as const, mtime: new Date(1980, 0, 1), os: 3, attrs: 0x1800000 };
  const entries: Record<string, [Uint8Array, typeof options]> = {
    'manifest.json': [strToU8(canonical(manifest)), options],
  };
  for (const entryPath of paths) entries[entryPath] = [input.files[entryPath], options];
  return zipSync(entries, { level: 0 });
}

export function readAndVerifyRappEgg(blob: Uint8Array): {
  manifest: RappManifest;
  files: Record<string, Uint8Array>;
} {
  const scanned = scanZip(blob);
  if (!scanned.some((entry) => entry.name === 'manifest.json')) {
    throw new Error('Egg has no manifest.json');
  }
  const unpacked = unzipSync(blob);
  const manifestBytes = unpacked['manifest.json'];
  if (!manifestBytes) throw new Error('Egg has no manifest.json');
  let manifest: RappManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as RappManifest;
  } catch {
    throw new Error('Egg manifest is not JSON');
  }
  const keys = Object.keys(manifest).sort();
  if (JSON.stringify(keys) !== JSON.stringify(
    ['contents', 'created_utc', 'payload', 'rappid', 'schema', 'sig', 'variant'],
  )) {
    throw new Error('RAPP/1 egg manifest must contain exactly seven members');
  }
  if (
    manifest.schema !== RAPP_EGG_SCHEMA
    || manifest.variant !== 'rapplication'
    || manifest.sig !== null
    || !RAPPID.test(manifest.rappid)
    || !FIXED_UTC.test(manifest.created_utc)
    || !Array.isArray(manifest.contents)
  ) {
    throw new Error('Invalid RAPP/1 egg manifest');
  }
  if (canonical(manifest) !== strFromU8(manifestBytes)) {
    throw new Error('RAPP/1 egg manifest is not canonical');
  }
  const files = { ...unpacked };
  delete files['manifest.json'];
  const paths = manifest.contents.map((entry) => entry.path);
  assertUniquePaths(paths);
  const sorted = [...paths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (JSON.stringify(paths) !== JSON.stringify(sorted)) throw new Error('Egg paths are not byte-sorted');
  if (JSON.stringify(Object.keys(files).sort()) !== JSON.stringify([...paths].sort())) {
    throw new Error('Egg entries do not match the manifest');
  }
  for (const entry of manifest.contents) {
    if (
      typeof entry?.path !== 'string'
      || typeof entry?.hash !== 'string'
      || rappHash('rapp/1:egg', files[entry.path]) !== entry.hash
    ) {
      throw new Error(`RAPP/1 content hash mismatch: ${entry?.path}`);
    }
  }
  return { manifest, files };
}

export function sealBytes(
  plaintext: Uint8Array,
  baseHeader: Omit<EggPublicHeader, 'crypto'>,
  passphrase: string,
): { header: EggPublicHeader; ciphertext: Uint8Array } {
  if (passphrase.length < 12) throw new Error('Sealed backups require a passphrase of at least 12 characters');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, SCRYPT.keyBytes, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 128 * 1024 * 1024,
  });
  const crypto = {
    algorithm: 'aes-256-gcm' as const,
    kdf: 'scrypt' as const,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: '',
    keyBytes: 32 as const,
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  };
  const aadHeader: EggPublicHeader = { ...baseHeader, crypto };
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(canonical(aadHeader), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  crypto.tag = cipher.getAuthTag().toString('base64');
  key.fill(0);
  return { header: { ...baseHeader, crypto }, ciphertext };
}

export function unsealBytes(
  header: EggPublicHeader,
  ciphertext: Uint8Array,
  passphrase: string,
): Uint8Array {
  const crypto = header.crypto;
  if (
    !crypto
    || crypto.algorithm !== 'aes-256-gcm'
    || crypto.kdf !== 'scrypt'
    || crypto.N !== SCRYPT.N
    || crypto.r !== SCRYPT.r
    || crypto.p !== SCRYPT.p
    || crypto.keyBytes !== SCRYPT.keyBytes
  ) {
    throw new Error('Unsupported sealed egg encryption parameters');
  }
  const salt = Buffer.from(crypto.salt, 'base64');
  const iv = Buffer.from(crypto.iv, 'base64');
  const tag = Buffer.from(crypto.tag, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid sealed egg encryption header');
  }
  const key = scryptSync(passphrase, salt, 32, {
    N: crypto.N,
    r: crypto.r,
    p: crypto.p,
    maxmem: 128 * 1024 * 1024,
  });
  const aadHeader: EggPublicHeader = {
    ...header,
    crypto: { ...crypto, tag: '' },
  };
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(canonical(aadHeader), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('Sealed egg authentication failed (wrong passphrase or tampering)');
  } finally {
    key.fill(0);
  }
}

export function parsePublicHeader(payload: Record<string, unknown>): EggPublicHeader {
  if (payload.profile !== ORGANISM_EGG_PROFILE || payload.header === null) {
    throw new Error(`Egg is not profile ${ORGANISM_EGG_PROFILE}`);
  }
  const header = payload.header as EggPublicHeader;
  if (
    !header
    || header.profile !== ORGANISM_EGG_PROFILE
    || (header.mode !== 'portable' && header.mode !== 'sealed-backup')
    || !RAPPID.test(header.organismRappid)
    || !FIXED_UTC.test(header.createdUtc)
    || !/^[0-9a-f]{64}$/.test(header.rootDigest)
  ) {
    throw new Error('Invalid organism egg public header');
  }
  return header;
}
