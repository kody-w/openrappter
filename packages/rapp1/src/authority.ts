import type { JsonObject } from './json.js';

export type StreamFamily = 'body' | 'memory' | 'swarm';
export interface AuthorityIdentity extends JsonObject {
  revision: 'rev-14';
  frame_hash: string;
  payload_hash: string;
}

export const AUTHORITY_IDENTITY: Readonly<AuthorityIdentity> = Object.freeze({
  revision: 'rev-14',
  frame_hash: '59629adab4e26d156f3d66ecfb766e08705919ea1d2adc92ba0ad2b17337dfc2',
  payload_hash: 'c7549bbd3e133b833930e24e008817ea295734b870f41706455d3f45821aba3a',
});

const kinds: Record<string, StreamFamily> = Object.assign(Object.create(null), {
  'body.pulse': 'body',
  'body.re-genesis': 'body',
  'body.reconstructed': 'body',
  'body.twin-pulse': 'body',
  'memory.chat-turn': 'memory',
  'memory.re-genesis': 'memory',
  'memory.reconstructed': 'memory',
  'memory.save': 'memory',
  'memory.tool-call': 'memory',
  'swarm.echo': 'swarm',
  'swarm.guidance': 'swarm',
  'swarm.re-genesis': 'swarm',
  'swarm.reconstructed': 'swarm',
  'swarm.telemetry': 'swarm',
});

export const RAPP1_AUTHORITY = Object.freeze({
  status: 'accepted' as const,
  identity: AUTHORITY_IDENTITY,
  repository: 'https://github.com/kody-w/rapp-1',
  checkpointCommit: 'caf6ef276cafa92aa744499af90dc1a28559941a',
  normativeSha256: 'd345235be5bc698d78c5893285abd09f2e62a398f781123d1de8da313a01c7de',
  bootstrapProfileSha256: '1666e44acf532f854d4bf74868c9af9f9b362055692189ac858a7c8b52dcd5bb',
  kindFamilies: Object.freeze(kinds),
});

const getDescriptor = Object.getOwnPropertyDescriptor;
export function kindFamily(kind: unknown): StreamFamily | null {
  if (typeof kind !== 'string') return null;
  return getDescriptor(kinds, kind)?.value as StreamFamily | undefined ?? null;
}

export function isSelectedAuthority(value: unknown): value is typeof RAPP1_AUTHORITY {
  return value === RAPP1_AUTHORITY;
}
