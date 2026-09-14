import { contentHash, type JsonObject } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { requireThat } from './errors.js';
import { projectBot } from './projection.js';
import { memoryFrames, sourceReference } from './source-memory.js';
import { discoveryEvidence, type NativeEstateSource } from './estate-contract.js';
export { discoveryEvidence } from './estate-contract.js';
export type { NativeProvider, EstateProvider, NativePointer, EstateObservation, EstateProvenance, DiscoveryEvidence, NativeEstateSource } from './estate-contract.js';

export class NativeEstate {
  constructor(readonly bots: Bots) {}
  async discover(root: string, source: NativeEstateSource, operationId: string): Promise<JsonObject> {
    const evidence = discoveryEvidence(await source.discover());
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'Restore this root before recording discovery.');
      const duplicate = memoryFrames(snapshot).some(f => f.payload.operationId === operationId);
      const evidenceHash = contentHash(evidence);
      const frame = await this.bots.appendEvent(transaction, snapshot, 'discovery.recorded',
        { ...evidence, evidenceHash }, operationId, 'local-estate');
      return { root, scope: 'local-estate', receipt: sourceReference(frame), sourceWave: frame.frame_hash, evidenceHash, duplicate,
        historical: true, candidates: evidence.pointers, observations: evidence.observations ?? [],
        createdWorlds: 0, nativeWrites: 0, next: 'Ask for RAPP Up organization, review the full proposal, then confirm once.' };
    });
  }
}
