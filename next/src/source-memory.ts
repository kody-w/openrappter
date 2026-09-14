import { canonicalJson, contentHash, frameHead, isBodyStream, snapshotJson, streamFor, type JsonObject, type RappFrame } from './canonical.js';
import { label, object, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import type { RootSnapshot } from './repository.js';

export interface SourceMemory {
  readonly scope: string;
  readonly stream: string;
  readonly frames: readonly RappFrame[];
  readonly branches: readonly { head: string; frames: readonly RappFrame[] }[];
}
export function sourceKey(root: string, scope: string): string {
  requireThat(isBodyStream(root), 'source-guid', 'A full source root GUID is required.');
  label(scope);
  return contentHash({ root, scope });
}
export function sourceStream(root: string, scope: string): string {
  return scope === 'root' ? `${root}:work` : `${root}:s-${sourceKey(root, scope).slice(0, 62)}`;
}
export function sourceChain(root: RootSnapshot, scope: string): readonly RappFrame[] {
  return scope === 'root' ? root.streams.memory : root.sources?.find(s => s.scope === scope)?.frames ?? [];
}
export function sourceReference(frame: RappFrame): JsonObject {
  const event = frame.kind.startsWith('memory.') ? workEvent(frame.payload) : { root: frame.payload.root, scope: 'root' };
  requireThat(isBodyStream(event.root), 'source-guid', 'An original full source root GUID is required.');
  const owned = frame.kind.startsWith('memory.') ? sourceStream(event.root, event.scope)
    : frame.kind.startsWith('swarm.') ? streamFor(event.root, 'swarm') : event.root;
  requireThat(frame.stream_id === owned || frame.stream_id === streamFor(event.root, 'memory'),
    'source-ownership', 'An occurrence cannot claim another source stream.');
  return {
    guid: event.root, scope: event.scope, ...frameHead(frame),
    ownership: frame.stream_id === owned ? 'source-owned' : 'legacy-root-stream',
  };
}
export function rawMemoryFrames(root: RootSnapshot): readonly RappFrame[] {
  return [...root.streams.memory, ...(root.sources ?? []).flatMap(s => s.frames)];
}

function dependenciesFor(root: RootSnapshot): Map<string, Set<string>> {
  const frames = rawMemoryFrames(root);
  const sources = root.sources ?? [];
  requireThat(new Set(sources.map(s => s.scope)).size === sources.length, 'source-duplication', 'Each original scope has one active source stream.');
  for (const source of sources) {
    const authority = scopeCreationParent(root, source.scope);
    requireThat(source.scope !== 'root' && source.stream === sourceStream(root.definition.root, source.scope)
      && source.frames.length > 0 && source.frames.every(f => f.stream_id === source.stream && f.payload.scope === source.scope
        && f.payload.root === root.definition.root && Array.isArray(f.payload.parents) && f.payload.parents.includes(authority)),
    'source-ownership', 'Each source occurrence must retain its exact root/scope and canonical scope creation authority.');
  }
  const byHash = new Map(frames.map(frame => [frame.frame_hash, frame]));
  requireThat(byHash.size === frames.length, 'source-duplication', 'An occurrence must have exactly one authoritative source location.');
  const dependencies = new Map<string, Set<string>>();
  const streamSeq = new Map(frames.map(f => [`${f.stream_id}:${f.seq}`, f.frame_hash]));
  requireThat(streamSeq.size === frames.length, 'source-duplication', 'Two active occurrences may not occupy one source sequence.');
  for (const frame of frames) {
    const e = workEvent(frame.payload);
    const parents = new Set<string>();
    if (frame.seq) {
      const previous = streamSeq.get(`${frame.stream_id}:${frame.seq - 1}`);
      requireThat(previous, 'source-lineage', 'A source stream has incomplete ancestry.');
      parents.add(previous);
    }
    if (Array.isArray(e.parents)) for (const value of e.parents) {
      requireThat(typeof value === 'string' && (byHash.has(value) || root.streams.body.some(f => f.frame_hash === value)),
        'source-lineage', 'Explicit source parents must be retained canonical occurrences.');
      if (byHash.has(value)) parents.add(value);
    }
    const add = (hash: unknown): void => { if (typeof hash === 'string' && byHash.has(hash)) parents.add(hash); };
    for (const name of ['replyTo', 'proposalWave', 'targetWave', 'approval', 'bindingWave', 'requestWave',
      'responseWave', 'grantWave', 'deliveryId', 'attempt', 'policyWave'] as const) {
      const hash = e.data[name];
      add(hash);
    }
    for (const name of ['evidence', 'causes', 'viewParents'] as const) {
      const values = e.data[name];
      if (Array.isArray(values)) for (const value of values) add(value);
    }
    if (Array.isArray(e.data.sourceRefs)) for (const value of e.data.sourceRefs) {
      const ref = object(value);
      const original = byHash.get(String(ref.frame_hash));
      requireThat(original && canonicalJson(sourceReference(original)) === canonicalJson(ref), 'source-lineage',
        'A local reference must retain the exact original source GUID, scope, stream and frame hashes.');
      add(original.frame_hash);
    }
    const actor = e.data.actor;
    if (actor && typeof actor === 'object' && !Array.isArray(actor)) {
      const hash = actor.grantWave;
      add(hash);
    }
    if (e.event.startsWith('client.') && e.data.content) {
      const content = object(e.data.content);
      for (const field of ['evidence', 'references']) {
        if (Array.isArray(content[field])) for (const hash of content[field]) add(hash);
      }
      if (e.data.view) {
        const view = object(e.data.view);
        add(view.progress);
        if (Array.isArray(view.cards)) for (const card of view.cards) add(object(card).ref);
      }
    }
    if (e.data.draft) {
      const draft = object(e.data.draft);
      if (Array.isArray(draft.resolves)) for (const hash of draft.resolves) add(hash);
      if (Array.isArray(draft.actions)) for (const action of draft.actions) add(object(action).evidenceWave);
    }
    dependencies.set(frame.frame_hash, parents);
  }
  return dependencies;
}

/** No journal is written: retain original source occurrences in causal order. */
export function memoryFrames(root: RootSnapshot): readonly RappFrame[] {
  const frames = rawMemoryFrames(root);
  const byHash = new Map(frames.map(frame => [frame.frame_hash, frame]));
  const dependencies = dependenciesFor(root);
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const [hash, parents] of dependencies) {
    indegree.set(hash, parents.size);
    for (const parent of parents) children.set(parent, [...(children.get(parent) ?? []), hash]);
  }
  const ready = frames.filter(f => indegree.get(f.frame_hash) === 0);
  const result: RappFrame[] = [];
  while (ready.length) {
    ready.sort((a, b) => a.utc.localeCompare(b.utc) || a.frame_hash.localeCompare(b.frame_hash));
    const next = ready.shift()!;
    result.push(next);
    for (const child of children.get(next.frame_hash) ?? []) {
      indegree.set(child, indegree.get(child)! - 1);
      if (indegree.get(child) === 0) ready.push(byHash.get(child)!);
    }
  }
  requireThat(result.length === frames.length, 'source-lineage', 'Source references form a cycle or omit required ancestry.');
  return result;
}

export function scopeCreationParent(root: RootSnapshot, scope: string): string {
  if (root.definition.scopes.some(s => s.id === scope)) return root.streams.body[0]!.frame_hash;
  const frames = rawMemoryFrames(root);
  const byHash = new Map(frames.map(f => [f.frame_hash, f]));
  for (const frame of frames) {
    if (frame.payload.event !== 'organization.applied') continue;
    const proposal = byHash.get(String(workEvent(frame.payload).data.proposalWave));
    const draft = proposal && workEvent(proposal.payload).data.draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || !Array.isArray(draft.actions)) continue;
    for (const value of draft.actions) {
      const action = object(value);
      const id = action.type === 'scope.create' ? object(action.scope).id : action.id;
      if (id === scope) return frame.frame_hash;
    }
  }
  requireThat(false, 'source-scope', 'The source workspace/world has no canonical creation authority.');
}

export function sourceParents(root: RootSnapshot, scope: string): string[] {
  const parent = scopeCreationParent(root, scope);
  const previous = sourceChain(root, scope).at(-1)?.frame_hash;
  return [...new Set([...(previous ? [previous] : []), parent])];
}

export function memoryPrefix(root: RootSnapshot, count: number): RootSnapshot {
  return memorySubset(root, new Set(memoryFrames(root).slice(0, count).map(f => f.frame_hash)));
}

function memorySubset(root: RootSnapshot, selected: ReadonlySet<string>): RootSnapshot {
  const sources = (root.sources ?? []).map(s => ({ ...s, frames: s.frames.filter(f => selected.has(f.frame_hash)) })).filter(s => s.frames.length);
  const { sources: _sources, ...base } = root;
  return {
    ...base,
    streams: { ...root.streams, memory: root.streams.memory.filter(f => selected.has(f.frame_hash)) },
    ...(sources.length ? { sources } : {}),
  };
}

function assertClosedCut(root: RootSnapshot, cut: RootSnapshot): void {
  const selected = new Set(rawMemoryFrames(cut).map(f => f.frame_hash));
  const dependencies = dependenciesFor(root);
  requireThat(cut.definition.root === root.definition.root && [...selected].every(hash => dependencies.has(hash)
    && [...dependencies.get(hash)!].every(parent => selected.has(parent))), 'cursor-invalid',
  'A source vector must retain every selected occurrence and its original causal ancestry.');
  memoryFrames(cut);
}

export function memoryPending(root: RootSnapshot, from: RootSnapshot): readonly RappFrame[] {
  assertClosedCut(root, from);
  const retained = new Set(rawMemoryFrames(from).map(f => f.frame_hash));
  return memoryFrames(root).filter(f => !retained.has(f.frame_hash));
}

export function memoryAdvance(root: RootSnapshot, from: RootSnapshot, count: number): RootSnapshot {
  const pending = memoryPending(root, from).slice(0, count);
  return memorySubset(root, new Set([...rawMemoryFrames(from), ...pending].map(f => f.frame_hash)));
}

export function memoryHeadHashes(root: RootSnapshot): string[] {
  return [root.streams.memory.at(-1), ...(root.sources ?? []).map(s => s.frames.at(-1))]
    .filter((f): f is RappFrame => f !== undefined).map(f => f.frame_hash);
}

export function memoryCursor(root: RootSnapshot): JsonObject | null {
  const sourceHeads = (root.sources ?? []).filter(s => s.frames.length).sort((a, b) => a.scope.localeCompare(b.scope));
  if (!sourceHeads.length) {
    const last = root.streams.memory.at(-1);
    return last ? snapshotJson(frameHead(last)) as JsonObject : null;
  }
  return {
    schema: 'rapp-work.source-cursor/1', guid: root.definition.root,
    root: root.streams.memory.length ? snapshotJson(frameHead(root.streams.memory.at(-1)!)) : null,
    sources: sourceHeads.map(s => ({ key: sourceKey(root.definition.root, s.scope), head: snapshotJson(frameHead(s.frames.at(-1)!)),
      branches: s.branches.map(b => b.head).sort() })),
  };
}

export function memoryAtCursor(root: RootSnapshot, value: unknown): RootSnapshot {
  if (value === null) return memoryPrefix(root, 0);
  const candidate = object(value);
  if (candidate.schema !== 'rapp-work.source-cursor/1') {
    const index = root.streams.memory.findIndex(f => canonicalJson(frameHead(f)) === canonicalJson(candidate));
    requireThat(index >= 0, 'cursor-invalid', 'The exact source frame cursor is not present in this root.');
    const prefix = memorySubset(root, new Set(root.streams.memory.slice(0, index + 1).map(f => f.frame_hash)));
    assertClosedCut(root, prefix);
    return prefix;
  }
  object(candidate, ['schema', 'guid', 'root', 'sources']);
  requireThat(candidate.guid === root.definition.root && Array.isArray(candidate.sources), 'cursor-invalid', 'Source vector belongs to another root.');
  const cut = (chain: readonly RappFrame[], head: unknown): readonly RappFrame[] => {
    if (head === null) return [];
    const found = chain.find(f => canonicalJson(frameHead(f)) === canonicalJson(head));
    requireThat(found, 'cursor-invalid', 'A source cursor head is not a retained exact occurrence.');
    return chain.slice(0, found.seq + 1);
  };
  const heads = new Map<string, unknown>();
  const branches = new Map<string, readonly { head: string; frames: readonly RappFrame[] }[]>();
  for (const item of candidate.sources) {
    const source = object(item, ['key', 'head', 'branches']);
    const actual = root.sources?.find(s => sourceKey(root.definition.root, s.scope) === source.key);
    requireThat(actual && !heads.has(actual.scope), 'cursor-invalid', 'Unknown or duplicate source cursor scope.');
    requireThat(Array.isArray(source.branches) && source.branches.every(hash => actual.branches.some(b => b.head === hash)),
      'cursor-invalid', 'A source cursor must retain exact original branch heads.');
    heads.set(actual.scope, source.head);
    branches.set(actual.scope, actual.branches.filter(b => (source.branches as unknown[]).includes(b.head)));
  }
  const prefix: RootSnapshot = { ...root, streams: { ...root.streams, memory: cut(root.streams.memory, candidate.root) },
    sources: (root.sources ?? []).map(s => ({ ...s, frames: cut(s.frames, heads.get(s.scope) ?? null),
      branches: branches.get(s.scope) ?? [] })).filter(s => s.frames.length) };
  try { assertClosedCut(root, prefix); }
  catch { requireThat(false, 'cursor-invalid', 'A source vector omitted canonical ancestry.'); }
  requireThat(canonicalJson(memoryCursor(prefix)) === canonicalJson(candidate), 'cursor-invalid', 'A source vector is not in canonical order.');
  return prefix;
}
