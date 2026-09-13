import { contentHash, isUtc, type JsonObject } from './canonical.js';
import { Bots, findRoot } from './bots.js';
import { label, list, object, text } from './contract.js';
import { requireThat } from './errors.js';
import { projectBot } from './projection.js';

export type NativeProvider = 'copilot' | 'claude' | 'hermes' | 'grokbot' | 'scout';
export interface NativePointer extends JsonObject {
  id: string;
  provider: NativeProvider;
  title: string;
  nativeShape: string;
  locator: string;
}
export interface DiscoveryEvidence extends JsonObject {
  origin: 'sanitized-fixture' | 'explicit-operator-evidence';
  observedUtc: string;
  historical: true;
  pointers: NativePointer[];
}
export interface NativeEstateSource {
  discover(): Promise<DiscoveryEvidence>;
}

export function discoveryEvidence(value: unknown): DiscoveryEvidence {
  const evidence = object(value, ['origin', 'observedUtc', 'historical', 'pointers']);
  requireThat(['sanitized-fixture', 'explicit-operator-evidence'].includes(String(evidence.origin))
    && evidence.historical === true && isUtc(evidence.observedUtc),
  'discovery', 'Explicit historical discovery evidence is required, not live or inferred ownership.');
  const pointers = list(evidence.pointers, 32).map(value => {
    const p = object(value, ['id', 'provider', 'title', 'nativeShape', 'locator']);
    label(p.id);
    requireThat(['copilot', 'claude', 'hermes', 'grokbot', 'scout'].includes(String(p.provider)),
      'native-provider', 'A supported native pointer provider is required.');
    text(p.title, 120);
    text(p.nativeShape, 240);
    requireThat(typeof p.locator === 'string' && /^native:\/\/(?:copilot|claude|hermes|grokbot|scout)\/[A-Za-z0-9._/-]{1,180}$/u.test(p.locator)
      && p.locator.startsWith(`native://${String(p.provider)}/`) && !p.locator.split('/').includes('..'),
    'native-pointer', 'Only opaque provider-owned read-only native locators are accepted; no file URLs, content or executable paths.');
    return p as NativePointer;
  });
  requireThat(new Set(pointers.map(p => p.id)).size === pointers.length, 'discovery', 'Discovery pointer IDs must be unique.');
  return { ...evidence, pointers } as DiscoveryEvidence;
}

export class NativeEstate {
  constructor(readonly bots: Bots) {}
  async discover(root: string, source: NativeEstateSource, operationId: string): Promise<JsonObject> {
    const evidence = discoveryEvidence(await source.discover());
    return this.bots.repository.transaction(async transaction => {
      const snapshot = findRoot(transaction, root);
      requireThat(!projectBot(snapshot).hidden, 'bot-hidden', 'Restore this root before recording discovery.');
      const frame = await this.bots.appendEvent(transaction, snapshot, 'discovery.recorded',
        { ...evidence, evidenceHash: contentHash(evidence) }, operationId, 'local-estate');
      return { sourceWave: frame.frame_hash, historical: true, candidates: evidence.pointers,
        createdWorlds: 0, nativeWrites: 0, next: 'Ask for RAPP Up organization, review the full proposal, then confirm once.' };
    });
  }
}
