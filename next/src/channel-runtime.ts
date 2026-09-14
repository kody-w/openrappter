import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, contentHash, isBodyStream, parseJson, sha256, type JsonObject } from './canonical.js';
import { label, object, text } from './contract.js';
import { requireThat } from './errors.js';

export interface PrivateChannelMaterial extends JsonObject {
  contactRef: string;
  permissionRef: string;
  shortcut: string | null;
  credential: string | null;
}
interface BindingFile extends JsonObject {
  schema: 'rapp-work.private-channel-runtime/1';
  profile: string;
  root: string;
  bindingId: string;
  operationId: string;
  material: PrivateChannelMaterial;
}
async function realAncestors(directory: string): Promise<void> {
  let cursor = path.parse(directory).root;
  for (const piece of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, piece);
    const stat = await lstat(cursor);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink(), 'channel-runtime-path', 'Runtime ancestors must be real directories.');
  }
}
function material(value: unknown): PrivateChannelMaterial {
  const m = object(value, ['contactRef', 'permissionRef', 'shortcut', 'credential']);
  text(m.contactRef, 300); text(m.permissionRef, 300);
  if (m.shortcut !== null) text(m.shortcut, 120);
  if (m.credential !== null) text(m.credential, 512);
  return m as PrivateChannelMaterial;
}

/** Transport custody only. No conversation, queue, policy or outcome is stored here. */
export class PrivateChannelBindings {
  readonly directory: string;
  readonly #profile: string;
  constructor(canonicalDirectory: string) {
    const canonical = path.resolve(canonicalDirectory);
    this.directory = path.join(path.dirname(canonical), `${path.basename(canonical)}.runtime`);
    this.#profile = sha256(canonical);
  }
  async #directory(create = false): Promise<void> {
    await realAncestors(path.dirname(this.directory));
    if (create) await mkdir(this.directory, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const stat = await lstat(this.directory);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700
      && process.getuid !== undefined && stat.uid === process.getuid(), 'channel-runtime-private',
    'The private runtime sibling must be same-user and exactly 0700; existing permissions are never repaired.');
    const entries = await readdir(this.directory);
    requireThat(entries.length <= 64 && entries.every(name => /^[0-9a-f]{64}\.json$/u.test(name)),
      'channel-runtime-private', 'Only bounded private binding files belong in this runtime sibling.');
  }
  async #read(filename: string): Promise<BindingFile> {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      requireThat(stat.isFile() && stat.nlink === 1 && stat.size <= 4_096 && (stat.mode & 0o777) === 0o600
        && process.getuid !== undefined && stat.uid === process.getuid(), 'channel-runtime-private',
      'Private binding files must be bounded same-user non-linked 0600 files.');
      const b = object(parseJson(await handle.readFile()), ['schema', 'profile', 'root', 'bindingId', 'operationId', 'material']);
      requireThat(b.schema === 'rapp-work.private-channel-runtime/1' && b.profile === this.#profile && isBodyStream(b.root)
        && b.bindingId === contentHash({ root: b.root, operationId: b.operationId, purpose: 'private-imessage-binding' }),
      'channel-runtime-binding', 'The private binding is not bound to this exact profile/root operation.');
      label(b.operationId); material(b.material);
      return b as BindingFile;
    } finally { await handle.close(); }
  }
  async put(root: string, value: PrivateChannelMaterial, operationId: string): Promise<string> {
    requireThat(isBodyStream(root), 'root-identity', 'Private transport custody needs the existing full root RAPPID.');
    label(operationId);
    const bindingId = contentHash({ root, operationId, purpose: 'private-imessage-binding' });
    const entry: BindingFile = { schema: 'rapp-work.private-channel-runtime/1', profile: this.#profile,
      root, operationId, bindingId, material: material(value) };
    await this.#directory(true);
    const filename = path.join(this.directory, `${bindingId}.json`);
    const files = await readdir(this.directory);
    requireThat(files.includes(`${bindingId}.json`) || files.length < 64, 'channel-runtime-private', 'The bounded private binding catalog is full.');
    let handle;
    try { handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      requireThat(canonicalJson(await this.#read(filename)) === canonicalJson(entry), 'idempotency-conflict', 'The private binding operation is already bound; no overwrite.');
      return bindingId;
    }
    try { await handle.writeFile(canonicalJson(entry)); await handle.sync(); }
    finally { await handle.close(); }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return bindingId;
  }
  async get(root: string, bindingId: string): Promise<PrivateChannelMaterial> {
    requireThat(isBodyStream(root) && /^[0-9a-f]{64}$/u.test(bindingId), 'channel-runtime-binding', 'An exact root and opaque runtime binding are required.');
    await this.#directory();
    const entry = await this.#read(path.join(this.directory, `${bindingId}.json`));
    requireThat(entry.root === root && entry.bindingId === bindingId, 'channel-runtime-binding', 'Another root cannot borrow this private transport binding.');
    return entry.material;
  }
}
