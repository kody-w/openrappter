import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const AUTHORITY = Object.freeze(readContract('rapp1-authority.json'));
export const ARTIFACT_POLICY = freezeJson(readContract('artifact-allowlist.json'));
export const MODES = Object.freeze(['production', 'development-unsigned']);

export function readContract(name) {
  return JSON.parse(readFileSync(new URL(`../../../contracts/${name}`, import.meta.url), 'utf8'));
}

function freezeJson(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

export function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  invariant(value && Object.getPrototypeOf(value) === Object.prototype, 'Expected a plain JSON object');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function digest(value) {
  return sha256(canonical(value));
}

export function exactKeys(value, keys, label) {
  invariant(value && Object.getPrototypeOf(value) === Object.prototype, `${label} must be a plain object`);
  invariant(Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'), `${label} has unexpected or missing fields`);
}

export function validateMode(mode) {
  invariant(MODES.includes(mode), 'Specify production or the explicit development-unsigned mode');
  return mode;
}

export function safeRelative(value) {
  invariant(typeof value === 'string' && value.length > 0 && !/[\\\u0000-\u001f\u007f]/u.test(value), 'Unsafe relative path');
  invariant(!path.posix.isAbsolute(value) && !/^[a-z]:/iu.test(value), 'Absolute paths are not allowed');
  invariant(value.split('/').every(part => part && part !== '.' && part !== '..'), 'Path traversal is not allowed');
  invariant(value === value.normalize('NFC'), 'Noncanonical Unicode path');
  return value;
}

export async function requireRealDirectory(directory) {
  const absolute = path.resolve(directory);
  invariant(!/[\u0000-\u001f\u007f]/u.test(absolute), 'Control characters are not allowed in filesystem roots');
  invariant((await lstat(absolute)).isDirectory(), `Not a real directory: ${absolute}`);
  invariant(await realpath(absolute) === absolute, `Symlinked directory is not allowed: ${absolute}`);
  return absolute;
}

export function validateHash(value, label = 'SHA-256') {
  invariant(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), `${label} is invalid`);
  return value;
}
