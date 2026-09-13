import { isBodyStream, type JsonObject } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { object, text, workEvent } from './contract.js';
import { Refusal, requireThat } from './errors.js';
import { wave } from './intent.js';
import { projectBot } from './projection.js';
import type { RootSnapshot } from './repository.js';

export const HIVE_AUTHORITY = Object.freeze({
  repository: 'https://github.com/kody-w/RAPP',
  commit: '0a15ebd0d79e0502606755ad4df1432dcb6e1f59',
  source: 'protocols/rapp-hive/1/reference/hive_acceptance.py',
  verifier: 'RegistryAuthority + HiveAcceptance',
});

export interface CanonicalHivePort {
  readonly available: boolean;
  verifyExistingSharedObject(input: {
    root: string; peer: string; room: string; objectWave: string;
    rootConsentWave: string; peerConsentWave: string;
  }): Promise<{
    hive: string; registrySeq: number; registryCommitment: string;
    declarationWave: string; acceptedObjectWave: string; checkpointWave: string;
  }>;
}
export class UnavailablePrivateHive implements CanonicalHivePort {
  readonly available = false;
  async verifyExistingSharedObject(): Promise<never> {
    throw new Refusal('hive-binding-unavailable',
      'Existing signed Private Hive RegistryAuthority/HiveAcceptance, owner anchor, fresh monotonic checkpoint and complete resolver are not bound. A carried label or boolean is not authority.');
  }
}

function consent(root: RootSnapshot, peer: string, room: string, objectWave: string) {
  const selected = root.streams.memory.filter(f => f.payload.event === 'hive.consented'
    && workEvent(f.payload).data.peer === peer && workEvent(f.payload).data.room === room
    && workEvent(f.payload).data.objectWave === objectWave).at(-1);
  return selected && workEvent(selected.payload).data.mode === 'allow' ? selected : undefined;
}

export class LocalHive {
  constructor(readonly bots: Bots, readonly port: CanonicalHivePort = new UnavailablePrivateHive()) {}

  async consent(root: string, peer: string, room: string, objectWave: string, mode: 'allow' | 'revoke', operationId: string): Promise<JsonObject> {
    requireThat(root !== peer && (mode === 'allow' || mode === 'revoke'), 'hive-consent', 'Choose one exact independent peer and consent decision.');
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      findRoot(transaction, peer);
      requireThat(snapshot.definition.signer === root && !projectBot(snapshot).hidden, 'hive-consent', 'Only an active independently signed root may consent to a Hive reference.');
      const frame = await this.bots.appendEvent(transaction, snapshot, 'hive.consented', {
        peer, room: text(room, 100), objectWave: wave(objectWave), mode,
        scope: 'existing-hive-context-reference', actor: 'local-operator',
      }, operationId);
      return { source: frame.frame_hash, peer, room, objectWave, mode, hiveAuthorityGranted: false };
    });
  }

  async link(root: string, peer: string, room: string, objectWave: string, operationId: string): Promise<JsonObject> {
    const snapshot = await this.bots.repository.snapshot();
    const left = snapshot.roots.find(r => r.definition.root === root);
    const right = snapshot.roots.find(r => r.definition.root === peer);
    requireThat(root !== peer && left && right && !projectBot(left).hidden && !projectBot(right).hidden,
      'hive-scope', 'Hive relationships require independent active worlds, never merged identities.');
    const a = consent(left, peer, room, objectWave);
    const b = consent(right, root, room, objectWave);
    requireThat(a && b, 'hive-consent', 'Both independent roots must consent to this exact Hive room/object. A public-perspective grant is not Hive authority.');
    requireThat(this.port.available, 'hive-binding-unavailable', 'No existing signed Private Hive authority has been adopted for these worlds.');
    const accepted = await this.port.verifyExistingSharedObject({
      root, peer, room: text(room, 100), objectWave: wave(objectWave), rootConsentWave: a.frame_hash, peerConsentWave: b.frame_hash,
    });
    object(accepted, ['hive', 'registrySeq', 'registryCommitment', 'declarationWave', 'acceptedObjectWave', 'checkpointWave']);
    requireThat(isBodyStream(accepted.hive) && accepted.acceptedObjectWave === objectWave && Number.isSafeInteger(accepted.registrySeq) && accepted.registrySeq >= 0,
      'hive-authority', 'The canonical Hive adapter did not accept the exact shared object.');
    for (const hash of [accepted.registryCommitment, accepted.declarationWave, accepted.checkpointWave]) wave(hash);
    return this.bots.repository.transaction(async transaction => {
      const currentLeft = findRoot(transaction, root);
      const currentRight = findRoot(transaction, peer);
      requireThat(!projectBot(currentLeft).hidden && !projectBot(currentRight).hidden
        && consent(currentLeft, peer, room, objectWave)?.frame_hash === a.frame_hash
        && consent(currentRight, root, room, objectWave)?.frame_hash === b.frame_hash,
        'hive-consent', 'World consent changed before the shared-context reference could be recorded.');
      const frame = await this.bots.appendEvent(transaction, currentLeft, 'hive.linked',
        { peer, room, accepted: { ...accepted }, source: { ...HIVE_AUTHORITY }, shared: 'references-only', identitiesMerged: false }, operationId);
      return { source: frame.frame_hash, peer, objectWave, identitiesMerged: false };
    });
  }
}
