import { canonicalJson, sha256, type JsonObject } from './canonical.js';
import { Bots } from './bots.js';
import { Refusal, requireThat } from './errors.js';
import { memoryFrames, sourceReference } from './source-memory.js';

export class RootedEgg {
  constructor(readonly bots: Bots) {}

  async atRest(root: string): Promise<JsonObject> {
    const snapshot = await this.bots.repository.root(root);
    const frames = [...snapshot.streams.body, ...snapshot.streams.swarm, ...memoryFrames(snapshot),
      ...snapshot.branches.flatMap(b => b.frames), ...(snapshot.sources ?? []).flatMap(s => s.branches.flatMap(b => b.frames))];
    return {
      root: snapshot.definition.root,
      representation: 'existing-canonical-rooted-data',
      frames: frames.map(f => ({ wave: f.frame_hash, bytesSha256: sha256(canonicalJson(f)), origin: sourceReference(f) })),
      branches: [...snapshot.branches.map(b => ({ family: b.family, head: b.head })),
        ...(snapshot.sources ?? []).flatMap(s => s.branches.map(b => ({ guid: root, scope: s.scope, stream_id: s.stream, family: 'memory', head: b.head })))],
      transformation: false, transferAuthority: false,
    };
  }

  async transfer(root: string, operation: 'inspect' | 'export' | 'restore', scope: 'godd' | 'dogg' | 'both'): Promise<never> {
    requireThat(['inspect', 'export', 'restore'].includes(operation) && ['godd', 'dogg', 'both'].includes(scope),
      'domain-scope', 'Only canonical GODD, DOGG or both may be selected.');
    await this.bots.repository.root(root);
    throw new Refusal('canonical-domain-binding-unavailable',
      'Signed adopted rooted-object domain/closure bindings and required GODD sealing transport are unavailable. No new Egg format, filtering, transformation, reminting or output write is permitted.');
  }
}
