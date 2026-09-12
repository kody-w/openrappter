import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { invariant, requireRealDirectory, safeRelative, sha256 } from './common.mjs';

export async function inspectAsar(filename) {
  const bytes = await readFile(filename);
  invariant(bytes.length >= 16 && bytes.readUInt32LE(0) === 4, 'Invalid ASAR size header');
  const headerSize = bytes.readUInt32LE(4);
  const jsonSize = bytes.readUInt32LE(12);
  invariant(headerSize >= 8 && headerSize <= 64 * 1024 * 1024, 'Invalid ASAR header length');
  invariant(headerSize === 8 + Math.ceil(jsonSize / 4) * 4 && bytes.readUInt32LE(8) === headerSize - 4, 'Invalid ASAR pickle');
  const dataStart = 8 + headerSize;
  invariant(dataStart <= bytes.length && 16 + jsonSize <= dataStart, 'Truncated ASAR header');
  const header = JSON.parse(bytes.subarray(16, 16 + jsonSize).toString('utf8'));
  const entries = [];
  const ranges = [];
  const seen = new Set();
  async function walk(files, prefix = '') {
    invariant(files && typeof files === 'object' && !Array.isArray(files), 'Invalid ASAR directory');
    for (const name of Object.keys(files).sort()) {
      invariant(!name.includes('/') && !name.includes('\\'), 'Invalid ASAR filename');
      const relative = safeRelative(prefix ? `${prefix}/${name}` : name);
      invariant(!seen.has(relative.toLowerCase()), `Case-colliding ASAR path: ${relative}`);
      seen.add(relative.toLowerCase());
      const entry = files[name];
      invariant(entry && typeof entry === 'object', `Invalid ASAR entry: ${relative}`);
      invariant(!Object.hasOwn(entry, 'link'), `ASAR links are not permitted: ${relative}`);
      if (Object.hasOwn(entry, 'files')) {
        await walk(entry.files, relative);
      } else {
        invariant(Number.isSafeInteger(entry.size) && entry.size >= 0, `Invalid ASAR file size: ${relative}`);
        let content;
        if (entry.unpacked === true) {
          const unpackedRoot = await requireRealDirectory(`${filename}.unpacked`);
          const unpackedPath = path.join(unpackedRoot, relative);
          invariant(await realpath(path.dirname(unpackedPath)) === path.dirname(unpackedPath), `Symlinked ASAR unpacked parent: ${relative}`);
          const stat = await lstat(unpackedPath);
          invariant(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `Unsafe ASAR unpacked file: ${relative}`);
          content = await readFile(unpackedPath);
          invariant(content.length === entry.size, `ASAR unpacked size mismatch: ${relative}`);
        } else {
          invariant(typeof entry.offset === 'string' && /^(?:0|[1-9]\d*)$/u.test(entry.offset), `Invalid ASAR offset: ${relative}`);
          const offset = Number(entry.offset);
          invariant(Number.isSafeInteger(offset) && offset >= 0 && offset + entry.size <= bytes.length - dataStart, `ASAR entry out of bounds: ${relative}`);
          if (entry.size > 0) ranges.push([offset, offset + entry.size]);
          content = bytes.subarray(dataStart + offset, dataStart + offset + entry.size);
        }
        if (entry.integrity) {
          invariant(entry.integrity.algorithm === 'SHA256' && entry.integrity.hash === sha256(content), `ASAR integrity mismatch: ${relative}`);
        }
        entries.push({ path: relative, size: content.length, sha256: sha256(content), unpacked: entry.unpacked === true, bytes: content });
      }
    }
  }
  await walk(header.files);
  ranges.sort((a, b) => a[0] - b[0]);
  let end = 0;
  for (const [start, finish] of ranges) {
    invariant(start === end, 'ASAR has overlapping entries or unaccounted payload bytes');
    end = finish;
  }
  invariant(end === bytes.length - dataStart, 'ASAR has trailing unaccounted payload bytes');
  return entries;
}

export function machOArchitectures(bytes) {
  if (bytes.length < 4) return [];
  const magic = bytes.readUInt32BE(0);
  if (magic === 0x7f454c46) return ['unsupported-elf'];
  if (bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d) {
    const header = bytes.readUInt32LE(60);
    if (header >= 64 && header + 4 <= bytes.length && bytes.readUInt32LE(header) === 0x00004550) return ['unsupported-pe'];
  }
  const name = cpu => cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x86_64' : `unsupported-${cpu.toString(16)}`;
  if ([0xcffaedfe, 0xcefaedfe, 0xfeedfacf, 0xfeedface].includes(magic)) {
    invariant(bytes.length >= 28, 'Truncated Mach-O header');
    return [name(magic === 0xcffaedfe || magic === 0xcefaedfe ? bytes.readUInt32LE(4) : bytes.readUInt32BE(4))];
  }
  if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
    invariant(bytes.length >= 8, 'Truncated universal Mach-O header');
    const little = magic === 0xbebafeca || magic === 0xbfbafeca;
    const read = offset => little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
    const count = read(4);
    const width = magic === 0xcafebabf || magic === 0xbfbafeca ? 32 : 20;
    invariant(count > 0 && count < 32 && bytes.length >= 8 + count * width, 'Invalid universal Mach-O architecture table');
    return Array.from({ length: count }, (_, i) => name(read(8 + i * width)));
  }
  return [];
}
