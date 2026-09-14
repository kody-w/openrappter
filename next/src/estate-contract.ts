import { isUtc, type JsonObject } from './canonical.js';
import { label, list, object, text } from './contract.js';
import { requireThat } from './errors.js';

export type NativeProvider = 'copilot' | 'claude' | 'hermes' | 'grokbot' | 'scout';
export type EstateProvider = NativeProvider | 'local';
export interface EstateProvenance extends JsonObject {
  source: 'rapp-workspace-manager';
  manifestSha256: string;
  recordSha256: string;
  providerUnion: EstateProvider[];
  mappingState: 'mapped' | 'unresolved' | 'app-only';
  evidenceSha256: string[];
}
export interface NativePointer extends JsonObject {
  id: string;
  provider: EstateProvider;
  title: string;
  nativeShape: string;
  locator: string;
}
export interface EstateObservation extends JsonObject {
  id: string;
  provider: EstateProvider;
  title: string;
  nativeShape: string;
  provenance: EstateProvenance;
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

const PROVIDERS: readonly string[] = ['copilot', 'claude', 'hermes', 'grokbot', 'scout', 'local'];
function provenance(value: unknown, candidate: boolean): EstateProvenance {
  const p = object(value, ['source', 'manifestSha256', 'recordSha256', 'providerUnion', 'mappingState', 'evidenceSha256']);
  const digest = (value: unknown): string => {
    requireThat(typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value), 'estate-provenance', 'An exact SHA-256 evidence digest is required.');
    return value;
  };
  requireThat(p.source === 'rapp-workspace-manager', 'estate-provenance', 'Only the declared bounded manager evidence shape is supported.');
  const providers = list(p.providerUnion, 6);
  requireThat(new Set(providers).size === providers.length && providers.every(v => typeof v === 'string' && PROVIDERS.includes(v)),
    'estate-provenance', 'Native union provenance is bounded and cannot silently add providers.');
  const evidence = list(p.evidenceSha256, 16).map(digest);
  requireThat(new Set(evidence).size === evidence.length, 'estate-provenance', 'Evidence digest references must be unique.');
  requireThat(candidate ? p.mappingState === 'mapped' : typeof p.mappingState === 'string' && ['unresolved', 'app-only'].includes(p.mappingState),
    'estate-mapping', 'Unresolved/app-only observations are not workspace or native-context candidates.');
  digest(p.manifestSha256); digest(p.recordSha256);
  return p as EstateProvenance;
}

function description(value: JsonObject): void {
  label(value.id);
  requireThat(typeof value.provider === 'string' && PROVIDERS.includes(value.provider), 'native-provider', 'A declared local or supported native metadata provider is required.');
  text(value.title, 120); text(value.nativeShape, 240);
}

export function discoveryEvidence(value: unknown): DiscoveryEvidence {
  const evidence = object(value, ['origin', 'observedUtc', 'historical', 'pointers'], ['observations']);
  requireThat(typeof evidence.origin === 'string' && ['sanitized-fixture', 'explicit-operator-evidence'].includes(evidence.origin)
    && evidence.historical === true && isUtc(evidence.observedUtc),
  'discovery', 'Explicit historical discovery evidence is required, not live or inferred ownership.');
  const pointers = list(evidence.pointers, 32).map(value => {
    const p = object(value, ['id', 'provider', 'title', 'nativeShape', 'locator'], ['provenance']);
    description(p);
    if (p.provenance !== undefined) provenance(p.provenance, true);
    const local = p.provider === 'local';
    requireThat(!local || p.provenance !== undefined, 'estate-provenance', 'A local workspace pointer requires exact manager provenance references.');
    requireThat(typeof p.locator === 'string' && (local
      ? /^local:\/\/workspace\/[A-Za-z0-9._-]{1,180}$/u.test(p.locator)
      : /^native:\/\/(?:copilot|claude|hermes|grokbot|scout)\/[A-Za-z0-9._/-]{1,180}$/u.test(p.locator)
        && p.locator.startsWith(`native://${String(p.provider)}/`)) && !p.locator.split('/').some(p => p === '.' || p === '..'),
    'native-pointer', 'Only opaque read-only context locators are accepted; no file URLs, content, source paths or executable paths.');
    requireThat(p.provider !== 'grokbot' || String(p.locator).startsWith('native://grokbot/workspace/'),
      'estate-mapping', 'A Grok app root is not a mapped native workspace; record a non-candidate observation instead.');
    return p as NativePointer;
  });
  const observations = evidence.observations === undefined ? [] : list(evidence.observations, 32).map(value => {
    const o = object(value, ['id', 'provider', 'title', 'nativeShape', 'provenance']);
    description(o); provenance(o.provenance, false);
    return o as EstateObservation;
  });
  const ids = [...pointers, ...observations].map(p => p.id);
  requireThat(new Set(ids).size === ids.length, 'discovery', 'Candidate/observation IDs must be unique in this evidence record.');
  requireThat(new Set(pointers.map(p => `${p.provider}:${p.locator}`)).size === pointers.length,
    'discovery', 'A source context cannot be duplicated as multiple candidates in one record.');
  return { ...evidence, pointers, ...(evidence.observations === undefined ? {} : { observations }) } as DiscoveryEvidence;
}
