import { canonicalJson, frameHead, type JsonObject, type RappFrame } from './canonical.js';
import { requireThat } from './errors.js';
import type { RootSnapshot } from './repository.js';

export function retainedFrames(root: RootSnapshot): readonly RappFrame[] {
  return [...root.branches.flatMap(b => b.frames), ...(root.sources ?? []).flatMap(s => s.branches.flatMap(b => b.frames))];
}
function selectedFrames(root: RootSnapshot): readonly RappFrame[] {
  return [...Object.values(root.streams).flat(), ...(root.sources ?? []).flatMap(s => s.frames)];
}

/** Existing RAPP/1 fork rule over independently verified source occurrences. */
export function canonicalForks(root: RootSnapshot): JsonObject[] {
  const groups = new Map<string, Map<string, RappFrame>>();
  for (const frame of [...selectedFrames(root), ...retainedFrames(root)]) {
    const key = canonicalJson([frame.stream_id, frame.seq, frame.prev]);
    const group = groups.get(key) ?? new Map<string, RappFrame>();
    group.set(frame.frame_hash, frame); groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.size > 1).map(group => {
    const frames = [...group.values()].sort((a, b) => a.frame_hash.localeCompare(b.frame_hash));
    return { root: root.definition.root, stream_id: frames[0]!.stream_id, seq: frames[0]!.seq, prev: frames[0]!.prev,
      occurrences: frames.map(frame => ({ ...frameHead(frame) })), resolution: 'canonical-owner-resolution-unavailable' };
  }).sort((a, b) => String(a.stream_id).localeCompare(String(b.stream_id)) || Number(a.seq) - Number(b.seq));
}

export function assertCanonicalSelection(root: RootSnapshot): void {
  requireThat(canonicalForks(root).length === 0, 'canonical-fork-unresolved',
    'Conflicting canonical source occurrences are retained. Neither directory/branch order nor a carried flag authorizes projection or successors; canonical owner resolution is required.');
  const selected = new Set(selectedFrames(root).map(f => f.frame_hash));
  requireThat(retainedFrames(root).every(f => selected.has(f.frame_hash)), 'canonical-head-unresolved',
    'A retained successor is not part of the complete selected source chain. No directory-based head selection or automatic promotion is authorized.');
}
