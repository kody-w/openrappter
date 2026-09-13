import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITY, buildFrame, canonicalJson, contentHash, frameHead, mintIdentity, sha256, streamFor,
} from '../dist/canonical.js';
import { ROOT_SCHEMA, defaultScopes, eventPayload, eventKind } from '../dist/contract.js';
import { validateDraft } from '../dist/intent.js';
import { fixtureSigners } from '../dist/fixtures.js';
import { targetCapability } from '../dist/spine.js';
import { nativeMetadataPointer } from '../dist/native-metadata.js';
import { approvalStream, MIGRATION_SCHEMA, migrationPlan, verifyRootFiles } from '../dist/migration-contract.js';
import { projectBot } from '../dist/projection.js';

const source = fileURLToPath(new URL('../fixtures/migration-estate.json', import.meta.url));
export async function sourceInventory(directory, includeDirectories = false) {
  const files = {};
  async function walk(current, relative = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Fixture/source tree contains an unexpected symlink');
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (includeDirectories) {
          const stat = await lstat(path.join(current, entry.name));
          files[`${name}/`] = { type: 'directory', mode: stat.mode & 0o777, inode: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
        }
        await walk(path.join(current, entry.name), name);
      }
      else {
        const bytes = await readFile(path.join(current, entry.name));
        const stat = await lstat(path.join(current, entry.name));
        files[name] = { type: 'file', sha256: sha256(bytes), bytes: bytes.length, mode: stat.mode & 0o777, inode: stat.ino,
          mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      }
    }
  }
  await walk(directory);
  return files;
}

export async function migrationFixture(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const coverage = JSON.parse(await readFile(source, 'utf8'));
  const keys = fixtureSigners();
  const capability = await targetCapability();
  const sourceByItem = new Map();
  const items = [];
  const snapshots = [];
  const roots = keys.signers.map(s => s.root);
  let clock = Date.parse('2026-09-12T12:00:00.000Z');
  const now = () => new Date(clock++).toISOString();
  const capabilityText = Buffer.from(capability.bytes).toString('utf8');
  await mkdir(path.join(directory, 'capabilities'), { mode: 0o700 });
  await writeFile(path.join(directory, 'capabilities/agent.py'), capability.bytes, { mode: 0o400 });
  for (const [index, descriptor] of coverage.compatibleRoots.entries()) {
    const root = roots[index], signer = keys.signers[index].signer;
    const scopes = [...defaultScopes(descriptor.name),
      { id: 'source-world', parent: 'monorepo', kind: 'world', name: 'Source Work World', description: 'An existing hidden internal world.' },
      { id: 'source-workspace', parent: 'source-world', kind: 'workspace', name: 'Source Workspace', description: 'Existing recursive workspace.' },
      { id: 'source-agent', parent: 'source-workspace', kind: 'agent', name: 'Research Agent', description: 'Verified capability reference; no executable activation during migration.' },
      { id: 'source-twin', parent: 'source-world', kind: 'twin', name: 'Planning Twin', description: 'Existing canonical Twin organ.' },
      { id: 'source-neighborhood', parent: 'source-world', kind: 'neighborhood', name: 'Planning Neighborhood', description: 'Existing neighborhood with its own ancestry.' },
      { id: 'source-factory', parent: 'source-neighborhood', kind: 'factory', name: 'Review Factory', description: 'Canonical factory data; no factory execution.' },
      { id: 'source-rapplication', parent: 'source-factory', kind: 'rapplication', name: 'Digest Rapplication', description: 'Existing scoped rapplication.' },
      { id: 'source-task', parent: 'source-rapplication', kind: 'task', name: 'Draft Task', description: 'Reversible internal task data.' },
      { id: 'source-memory', parent: 'source-world', kind: 'memory', name: 'World Memory', description: 'Canonical public memory, not hidden reasoning.' },
    ];
    const definition = {
      schema: ROOT_SCHEMA, operationId: `source-${descriptor.id}`, root, name: descriptor.name, scopes,
      capability: capability.reference, authority: { ...AUTHORITY }, signer: root,
      policy: { externalEffects: 'explicit-approval', nativeStores: 'pointer-only', memory: 'public-turns-and-outcomes' },
    };
    const body = buildFrame({ kind: 'body.pulse', streamId: root, head: null, utc: now(), payload: definition, signer, signatures: keys.signatures });
    const memory = [];
    const append = (event, data, id, scope = 'root') => {
      const frame = buildFrame({ kind: eventKind(event), streamId: streamFor(root, 'memory'), head: memory.length ? frameHead(memory.at(-1)) : null,
        utc: now(), payload: eventPayload(root, scope, id, event, data), signer, signatures: keys.signatures });
      memory.push(frame); return frame;
    };
    const user = append('turn.user', { text: 'Retain our complete canonical source world and public evidence.' }, `source-user-${index}`);
    const draft = validateDraft({
      summary: 'Retain the verified source capability, an artifact and a reviewed routine.',
      tradeoffs: ['This is canonical inert fixture data, not live code or a new visible bot.'], questions: [], actions: [
        { type: 'artifact.save', id: 'source-capability', scope: 'source-agent', name: 'agent.py', mediaType: 'text/plain', content: capabilityText },
        { type: 'artifact.save', id: 'source-brief', scope: 'source-workspace', name: 'Existing brief', mediaType: 'text/plain', content: 'Sanitized existing canonical artifact and lineage.' },
        { type: 'routine.create', id: 'source-routine', scope: 'source-world', instruction: 'Recap the source world', work: 'canonical-recap', cadence: 'monday-0900-utc' },
      ],
    }, now());
    const proposed = append('turn.assistant', { text: draft.summary, draft, draftHash: contentHash(draft), replyTo: user.frame_hash }, `source-plan-${index}`);
    const applied = append('organization.applied', { proposalWave: proposed.frame_hash, summary: draft.summary, actor: 'local-operator' }, `source-applied-${index}`);
    append('work.progress', { summary: 'Existing memory and artifact evidence remain rooted.', evidence: [applied.frame_hash] }, `source-progress-${index}`, 'source-memory');
    if (descriptor.hidden) append('root.visibility', { hidden: true }, `source-hidden-${index}`);
    const swarm = buildFrame({ kind: 'swarm.telemetry', streamId: streamFor(root, 'swarm'), head: null, utc: now(),
      payload: { root, operationId: `source-telemetry-${index}`, summary: 'Existing signed source telemetry.' }, signer, signatures: keys.signatures });
    const files = new Map();
    const put = (family, frame) => files.set(`${family}/frames/${String(frame.seq).padStart(12, '0')}.json`, Buffer.from(canonicalJson(frame)));
    put('body', body); for (const frame of memory) put('memory', frame); put('swarm', swarm);
    if (index === 0) {
      const branch = buildFrame({ kind: 'memory.chat-turn', streamId: streamFor(root, 'memory'), head: null, utc: now(),
        payload: eventPayload(root, 'root', 'source-branch', 'turn.user', { text: 'An alternative source branch is retained, not unified.' }), signer, signatures: keys.signatures });
      files.set(`branches/memory-${branch.frame_hash}/frames/000000000000.json`, Buffer.from(canonicalJson(branch)));
    }
    const relativeRoot = path.join('canonical', descriptor.id);
    for (const [name, bytes] of files) {
      const target = path.join(directory, relativeRoot, name);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o400 });
    }
    const table = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, sha256: sha256(bytes), bytes: bytes.length }));
    const item = {
      id: descriptor.id, kind: 'canonical-root', root, title: descriptor.name, sourceIdentity: root,
      classification: 'compatible-canonical', provider: 'rapp-1', sourceLocator: `fixture://canonical/${descriptor.id}`,
      sourceDigest: contentHash(table), files: table, pointer: null,
    };
    items.push(item); sourceByItem.set(item.id, { directory: path.join(directory, relativeRoot), files });
    snapshots.push(verifyRootFiles(root, files, keys.signatures));
  }

  await mkdir(path.join(directory, 'workspace-manager'), { mode: 0o700 });
  for (const descriptor of coverage.managerPointers) {
    const metadata = { selected: true, nativeWorkspaceId: `fixture-${descriptor.id}`, title: descriptor.title, locator: `manager://selected/${descriptor.id}` };
    const bytes = Buffer.from(canonicalJson(metadata));
    const filename = path.join(directory, 'workspace-manager', `${descriptor.id}.json`);
    await writeFile(filename, bytes, { mode: 0o400 });
    items.push({ id: `wm-${descriptor.id}`, kind: 'estate-pointer', root: roots[0], title: descriptor.title,
      sourceIdentity: metadata.locator, classification: 'historical-derived', provider: 'workspace-manager',
      sourceLocator: metadata.locator, sourceDigest: sha256(bytes), files: [],
      pointer: { scope: descriptor.scope, nativeShape: 'Workspace Manager selected native workspace identity and locator', availability: 'historical',
        reason: 'Historical/derived selected estate pointer; no live ownership, contents or filesystem migration is claimed.', sourceRappid: null } });
  }
  const metadata = {
    copilot: { session_id: 'fixture-copilot', title: 'Native Copilot', cwd_reference: 'fixture-cwd' },
    claude: { project_key: 'fixture-claude-project', session: { uuid: 'fixture-claude-session', title: 'Native Claude' } },
    hermes: { session: { id: 'fixture-hermes', title: 'Native Hermes', workspace_reference: 'fixture-hermes-world' } },
    scout: { workspace: { key: 'fixture-scout', title: 'Native Scout' }, conversation_key: 'fixture-scout-conversation' },
    grokbot: { workspaceId: 'fixture-grokbot', threadId: 'fixture-thread', label: 'Native Grokbot' },
  };
  for (const provider of coverage.nativeProviders) {
    const folder = path.join(directory, 'native', provider);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(canonicalJson(metadata[provider]));
    await writeFile(path.join(folder, 'selected-metadata.json'), bytes, { mode: 0o400 });
    await writeFile(path.join(folder, 'private-transcript.txt'), `PRIVATE-NATIVE-${provider.toUpperCase()}-DO-NOT-IMPORT`, { mode: 0o400 });
    const pointer = nativeMetadataPointer(provider, metadata[provider]);
    items.push({ id: pointer.id, kind: 'estate-pointer', root: roots[0], title: pointer.title, sourceIdentity: pointer.locator,
      classification: 'native-pointer', provider, sourceLocator: pointer.locator, sourceDigest: sha256(bytes), files: [],
      pointer: { scope: 'local-estate', nativeShape: pointer.nativeShape, availability: 'metadata-only',
        reason: 'Explicitly selected safe native metadata only. Private transcripts/content are not imported.', sourceRappid: null } });
  }
  await mkdir(path.join(directory, 'archives'), { mode: 0o700 });
  for (const descriptor of coverage.historicalArchives) {
    const sourceRappid = descriptor.id === 'legacy-canonical-root' ? mintIdentity('fixture', 'legacy-root') : null;
    const bytes = Buffer.from(canonicalJson({ schema: 'historical-unsupported-fixture/1', sourceRappid, note: descriptor.reason }));
    await writeFile(path.join(directory, 'archives', `${descriptor.id}.json`), bytes, { mode: 0o400 });
    items.push({ id: descriptor.id, kind: 'estate-pointer', root: roots[0], title: descriptor.title,
      sourceIdentity: sourceRappid ?? `archive://fixture/${descriptor.id}`, classification: 'historical-unavailable', provider: 'legacy-rapp',
      sourceLocator: `archive://fixture/${descriptor.id}`, sourceDigest: sha256(bytes), files: [],
      pointer: { scope: 'global-estate', nativeShape: 'Historical archive/profile; unsupported interpretation',
        availability: 'unavailable', reason: descriptor.reason, sourceRappid } });
  }
  const projected = snapshots.map(projectBot);
  const forms = {};
  for (const p of projected) for (const scope of p.scopes) forms[scope.kind] = (forms[scope.kind] ?? 0) + 1;
  for (const form of coverage.requiredForms) if (!forms[form]) throw new Error(`Required fixture form missing: ${form}`);
  const expected = {
    roots: roots.length, items: items.length, pointers: items.filter(i => i.kind === 'estate-pointer').length,
    scopes: projected.reduce((n, p) => n + p.scopes.length, 0), artifacts: projected.reduce((n, p) => n + p.artifacts.length, 0),
    branches: snapshots.reduce((n, r) => n + r.branches.length, 0), forms,
    sourceFrames: snapshots.reduce((n, r) => n + Object.values(r.streams).flat().length + r.branches.reduce((n, b) => n + b.frames.length, 0), 0),
    classifications: Object.fromEntries([...new Set(items.map(i => i.classification))].map(k => [k, items.filter(i => i.classification === k).length])),
    providers: Object.fromEntries([...new Set(items.map(i => i.provider))].map(k => [k, items.filter(i => i.provider === k).length])),
    managerPointers: coverage.managerPointers.map(p => p.id), nativeProviders: coverage.nativeProviders,
  };
  const plan = migrationPlan({ schema: MIGRATION_SCHEMA, mode: 'sanitized-fixture', owner: roots[0], roots, items, expected });
  const approval = buildFrame({ kind: 'memory.save', streamId: approvalStream(plan.owner), head: null, utc: now(),
    payload: { schema: 'rapp-work.migration-approval/1', planHash: contentHash(plan), mode: plan.mode,
      destination: 'empty-isolated-profile', nativeContent: 'refused', rootSelection: roots },
    signer: keys.signers[0].signer, signatures: keys.signatures });
  const manifestPath = path.join(directory, 'approved-plan.json'), approvalPath = path.join(directory, 'approved-plan.frame.json');
  await writeFile(manifestPath, canonicalJson(plan), { mode: 0o400 });
  await writeFile(approvalPath, canonicalJson(approval), { mode: 0o400 });
  return { plan, approval, manifestPath, approvalPath, roots, sourceByItem, snapshots, keys, coverage };
}
