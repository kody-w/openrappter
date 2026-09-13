import {
  canonicalJson, contentHash, frameHead, isBodyStream, parseCanonicalJson, sha256, signerOf,
  streamFor, verifiedFrame, type Family, type JsonObject, type RappFrame, type SignaturePolicy,
} from './canonical.js';
import { eventKind, label, list, object, rootDefinition, text, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import { wave } from './intent.js';
import type { RootSnapshot } from './repository.js';

export const MIGRATION_LIMITS = Object.freeze({
  items: 256, filesPerRoot: 1_024, fileBytes: 1_048_576, rootBytes: 33_554_432,
  chunkBytes: 16_384, requestBytes: 65_536, controlFrames: 8_192,
});
export const MIGRATION_SCHEMA = 'rapp-work.migration-plan/1';
export const CANONICAL_FILE = /^(?:(?:body|memory|swarm)\/frames|branches\/(?:body|memory|swarm)-[0-9a-f]{64}\/frames)\/[0-9]{12}\.json$/u;
export interface FileDescriptor extends JsonObject { path: string; sha256: string; bytes: number }
export interface MigrationItem extends JsonObject {
  id: string;
  kind: 'canonical-root' | 'estate-pointer';
  root: string;
  title: string;
  sourceIdentity: string;
  classification: 'compatible-canonical' | 'historical-derived' | 'native-pointer' | 'historical-unavailable';
  provider: string;
  sourceLocator: string;
  sourceDigest: string;
  files: FileDescriptor[];
  pointer: JsonObject | null;
}
export interface MigrationPlan extends JsonObject {
  schema: typeof MIGRATION_SCHEMA;
  mode: 'sanitized-fixture' | 'controlled-local';
  owner: string;
  roots: string[];
  items: MigrationItem[];
  expected: JsonObject;
}

export function migrationItem(value: unknown): MigrationItem {
  const item = object(value, ['id', 'kind', 'root', 'title', 'sourceIdentity', 'classification', 'provider', 'sourceLocator', 'sourceDigest', 'files', 'pointer']);
  label(item.id); label(item.provider); text(item.title, 120); text(item.sourceIdentity, 256); text(item.sourceLocator, 300); wave(item.sourceDigest);
  requireThat(isBodyStream(item.root) && ['canonical-root', 'estate-pointer'].includes(String(item.kind)),
    'migration-item', 'An explicit source item and exact target root GUID are required.');
  requireThat(['compatible-canonical', 'historical-derived', 'native-pointer', 'historical-unavailable'].includes(String(item.classification)),
    'migration-classification', 'Compatibility/provenance classifications must be explicit, never inferred by the destination.');
  const files = list(item.files, MIGRATION_LIMITS.filesPerRoot).map(value => {
    const file = object(value, ['path', 'sha256', 'bytes']);
    requireThat(typeof file.path === 'string' && CANONICAL_FILE.test(file.path), 'migration-path', 'Only canonical root frame paths can be copied.');
    wave(file.sha256);
    requireThat(Number.isInteger(file.bytes) && Number(file.bytes) > 0 && Number(file.bytes) <= MIGRATION_LIMITS.fileBytes,
      'migration-bound', 'Canonical file byte bounds exceeded.');
    return file as FileDescriptor;
  });
  requireThat(new Set(files.map(f => f.path)).size === files.length
    && files.reduce((n, f) => n + f.bytes, 0) <= MIGRATION_LIMITS.rootBytes, 'migration-bound', 'The complete root closure must be unique and bounded.');
  if (item.kind === 'canonical-root') {
    requireThat(files.length > 0 && item.pointer === null && item.classification === 'compatible-canonical'
      && files.some(f => f.path === 'body/frames/000000000000.json'), 'migration-root', 'A compatible root requires its complete exact-byte canonical closure.');
  } else {
    requireThat(files.length === 0 && item.classification !== 'compatible-canonical', 'migration-pointer', 'Pointers are not reinterpreted as compatible roots.');
    const pointer = object(item.pointer, ['scope', 'nativeShape', 'availability', 'reason', 'sourceRappid']);
    label(pointer.scope); text(pointer.nativeShape, 240); text(pointer.reason, 500);
    requireThat(['historical', 'metadata-only', 'unavailable'].includes(String(pointer.availability)),
      'migration-pointer', 'Pointer availability must be honest and explicit.');
    requireThat(pointer.sourceRappid === null || isBodyStream(pointer.sourceRappid), 'migration-pointer', 'A historical root reference must retain its original full RAPPID.');
    if (item.classification === 'native-pointer') requireThat(/^native:\/\/(?:copilot|claude|hermes|scout|grokbot)\/[A-Za-z0-9._/-]+$/u.test(String(item.sourceLocator))
      && !String(item.sourceLocator).split('/').includes('..'), 'migration-pointer', 'Native stores remain opaque safe provider locators, not content imports.');
  }
  return { ...item, files } as MigrationItem;
}

export function migrationPlan(value: unknown): MigrationPlan {
  const plan = object(value, ['schema', 'mode', 'owner', 'roots', 'items', 'expected']);
  requireThat(plan.schema === MIGRATION_SCHEMA && ['sanitized-fixture', 'controlled-local'].includes(String(plan.mode))
    && isBodyStream(plan.owner), 'migration-plan', 'An explicitly selected canonical migration plan is required.');
  const roots: string[] = list(plan.roots, 32).map(value => {
    requireThat(isBodyStream(value), 'migration-root', 'Every selected root is a full canonical GUID.');
    return value;
  });
  const items = list(plan.items, MIGRATION_LIMITS.items).map(migrationItem);
  requireThat(roots.length > 0 && roots.includes(String(plan.owner)) && new Set(roots).size === roots.length
    && items.length > 0 && new Set(items.map(i => i.id)).size === items.length
    && new Set(items.map(i => `${i.root}:${i.sourceIdentity}`)).size === items.length
    && items.every(i => roots.includes(i.root))
    && roots.every(root => items.filter(i => i.kind === 'canonical-root' && i.root === root).length === 1),
  'migration-plan', 'The complete selection must have unique source identities and exactly one whole-root item per selected GUID.');
  object(plan.expected);
  return { schema: MIGRATION_SCHEMA, mode: plan.mode as MigrationPlan['mode'], owner: String(plan.owner),
    roots, items, expected: object(plan.expected) };
}

export const migrationStream = (owner: string): string => `${owner}:migration`;
export const approvalStream = (owner: string): string => `${owner}:migration-approval`;
export function verifyMigrationApproval(plan: MigrationPlan, source: string, signatures: SignaturePolicy, fixture: boolean): RappFrame {
  const approval = verifiedFrame(source, approvalStream(plan.owner), null, signatures);
  requireThat(signerOf(approval) === plan.owner && approval.kind === 'memory.save', 'migration-authority', 'The out-of-band owner must sign the selected approval.');
  const data = object(approval.payload, ['schema', 'planHash', 'mode', 'destination', 'nativeContent', 'rootSelection']);
  requireThat(data.schema === 'rapp-work.migration-approval/1' && data.planHash === contentHash(plan)
    && data.mode === plan.mode && data.destination === 'empty-isolated-profile' && data.nativeContent === 'refused'
    && canonicalJson(data.rootSelection) === canonicalJson(plan.roots), 'migration-authority', 'The approval does not bind this exact complete selection and isolated destination.');
  requireThat(fixture && plan.mode === 'sanitized-fixture' && plan.roots.every(r => r.startsWith('rappid:@fixture/')),
    'migration-adoption-unavailable', 'Controlled local transfer requires adopted canonical domain/closure and signer bindings. A fixture flag or carried classification cannot authorize live data.');
  return approval;
}

export function verifyRootFiles(root: string, files: ReadonlyMap<string, Buffer>, signatures: SignaturePolicy): RootSnapshot {
  requireThat(files.size > 0 && files.size <= MIGRATION_LIMITS.filesPerRoot, 'migration-root', 'A complete bounded canonical file set is required.');
  const genesis = files.get('body/frames/000000000000.json');
  requireThat(genesis, 'migration-root', 'Root genesis is required.');
  const definition = rootDefinition(object(parseCanonicalJson(genesis)).payload);
  requireThat(definition.root === root, 'migration-root', 'Migration cannot remint, reparent or substitute the source root GUID.');
  const directories = new Map<string, { path: string; bytes: Buffer }[]>();
  for (const [name, bytes] of files) {
    requireThat(CANONICAL_FILE.test(name), 'migration-path', 'Unexpected canonical path.');
    const directory = name.slice(0, name.lastIndexOf('/'));
    const entries = directories.get(directory) ?? [];
    entries.push({ path: name, bytes }); directories.set(directory, entries);
  }
  const streams: Record<Family, readonly RappFrame[]> = { body: [], memory: [], swarm: [] };
  const branches: { family: Family; head: string; frames: readonly RappFrame[] }[] = [];
  for (const [directory, entries] of directories) {
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const family = (directory.startsWith('branches/') ? directory.slice(9).split('-')[0] : directory.split('/')[0]) as Family;
    const chain: RappFrame[] = [];
    for (const [index, entry] of entries.entries()) {
      requireThat(entry.path.endsWith(`/${String(index).padStart(12, '0')}.json`), 'migration-lineage', 'No frame gaps, filtering or sequence rewrite is allowed.');
      const frame = verifiedFrame(entry.bytes, streamFor(root, family), chain.length ? frameHead(chain.at(-1)!) : null, signatures);
      requireThat(signerOf(frame) === definition.signer, 'migration-signature', 'All source occurrences must retain the original root signer.');
      if (family === 'memory') requireThat(workEvent(frame.payload).root === root && eventKind(String(frame.payload.event)) === frame.kind,
        'migration-profile', 'Unsupported application histories must remain historical pointers.');
      chain.push(frame);
    }
    if (directory.startsWith('branches/')) {
      const head = directory.split('/')[1]!.slice(family.length + 1);
      requireThat(chain.at(-1)!.frame_hash === head, 'migration-lineage', 'Complete original branch ancestry and head are required.');
      branches.push({ family, head, frames: chain });
    } else streams[family] = chain;
  }
  requireThat(streams.body.length === 1 && streams.body[0]!.kind === 'body.pulse', 'migration-root', 'Root identity is its exact immutable genesis.');
  const ids = [...Object.values(streams).flat()].map(f => f.payload.operationId).filter(id => id !== undefined);
  requireThat(new Set(ids).size === ids.length, 'migration-idempotency', 'An incompatible duplicate operation identity cannot be silently normalized.');
  const snapshot = { definition, streams, branches };
  return snapshot;
}

export function verifyFileTable(item: MigrationItem, files: ReadonlyMap<string, Buffer>): void {
  requireThat(files.size === item.files.length, 'migration-incomplete', 'Every approved canonical file is required; no frame filtering.');
  for (const descriptor of item.files) {
    const bytes = files.get(descriptor.path);
    requireThat(bytes && bytes.length === descriptor.bytes && sha256(bytes) === descriptor.sha256,
      'migration-bytes', 'Canonical source bytes differ from the owner-selected complete closure.');
  }
  requireThat(contentHash(item.files) === item.sourceDigest, 'migration-closure', 'The selected root file closure digest is not exact.');
}
