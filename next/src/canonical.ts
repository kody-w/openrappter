import { readFile } from 'node:fs/promises';
import {
  buildFrame, canonicalJson, frameHead, hashBytes, hashValue, isBodyStream, isLabel, isUtc,
  keyedIdentity, mergeFrames, mintIdentity, parseCanonicalJson, parseJson, scanFrameJson,
  sha256, snapshotJson, streamFamily, createFrameSigner, selectSignaturePolicy,
  scanChain, selectChainTrust, kindFamily,
  type FrameHead, type FrameSigner, type JsonObject, type JsonValue, type RappFrame,
  type RegistryKey, type SignaturePolicy,
} from '../../packages/rapp1/dist/index.js';
import { requireThat } from './errors.js';

// Deliberate adoption boundary: wire/crypto only. No rev-14 trust report escapes.
export {
  buildFrame, canonicalJson, frameHead, hashBytes, hashValue, isBodyStream, isLabel, isUtc,
  keyedIdentity, mergeFrames, mintIdentity, parseCanonicalJson, parseJson, sha256,
  snapshotJson, streamFamily, createFrameSigner, selectSignaturePolicy,
};
export type { FrameHead, FrameSigner, JsonObject, JsonValue, RappFrame, RegistryKey, SignaturePolicy };

export const AUTHORITY = Object.freeze({
  revision: 'rev-15',
  repository: 'https://github.com/kody-w/rapp-1',
  commit: 'dda32d741c7218f41443a5bd17eebfe0eae82cb7',
  frame_hash: '83ca275f35cca96e43d75c99d338326c1a39b2240eabf57eb7c29ac96cc90818',
  payload_hash: '1ac47416e9caf174c4fdc00265ca187c244fb701ae2a7fb7211ba1385a951310',
  normative_sha256: '348e7d5baa94aaf2ce4c5354f3cb261f389298a04af65e271a686d3b62f7c384',
  chain_sha256: '4d9b0e389395bfb2a61ff907e58efd12241c78e167ffd9be0f7f1452cd05b523',
});

export function verifiedFrame(bytes: string | Uint8Array, stream: string, head: FrameHead | null,
  signatures?: SignaturePolicy): RappFrame {
  const result = scanFrameJson(bytes, { streamId: stream, head, ...(signatures ? { signatures } : {}) });
  requireThat(result.ok, 'canonical-integrity', result.ok ? '' : result.error.message);
  return result.frame;
}

export async function verifySelectedAuthority(): Promise<{ revision: 'rev-15'; frames: number }> {
  const base = new URL('../vendor/rapp1/', import.meta.url);
  const bytes = await readFile(new URL('anchor/chain.jsonl', base));
  requireThat(sha256(bytes) === AUTHORITY.chain_sha256, 'authority-mismatch', 'The complete accepted authority chain bytes changed.');
  const chain = bytes.toString('utf8').trimEnd().split('\n');
  let head: FrameHead | null = null;
  let last: RappFrame | null = null;
  for (const line of chain) {
    const parsed = parseJson(line) as JsonObject;
    const frame = verifiedFrame(canonicalJson(parsed), String(parsed.stream_id), head);
    head = frameHead(frame);
    last = frame;
  }
  requireThat(chain.length === 16 && last?.frame_hash === AUTHORITY.frame_hash
    && last.payload_hash === AUTHORITY.payload_hash && last.payload.revision === AUTHORITY.revision,
  'authority-mismatch', 'The selected rev-15 canonical authority is not the exact accepted checkpoint.');
  const normative = last.payload.normative as JsonObject;
  requireThat(typeof normative?.text === 'string' && sha256(normative.text) === AUTHORITY.normative_sha256,
    'authority-mismatch', 'Normative rev-15 bytes do not match the accepted checkpoint.');
  const registered = last.payload.registered_kinds;
  requireThat(Array.isArray(registered) && registered.length === 14
    && registered.every(kind => typeof kind === 'string' && kindFamily(kind) === kind.split('.')[0]),
  'authority-mismatch', 'The deliberately adopted wire kind registry differs from the accepted rev-15 registry.');
  return { revision: 'rev-15', frames: chain.length };
}

export function rootTail(root: string): string {
  requireThat(isBodyStream(root), 'root-identity', 'A full canonical root RAPPID is required.');
  return root.slice(root.lastIndexOf(':') + 1);
}

export type Family = 'body' | 'memory' | 'swarm';
export function streamFor(root: string, family: Family): string {
  const tail = rootTail(root);
  return family === 'body' ? root : family === 'memory' ? `${root}:work` : `net:${tail}`;
}

export const contentHash = (value: unknown): string => hashValue('rapp/1:particle', snapshotJson(value));

export function signerOf(frame: RappFrame): string | null {
  if (frame.sig === null) return null;
  const header = parseCanonicalJson(Buffer.from(frame.sig.split('.')[0]!, 'base64url')) as JsonObject;
  return String(header.kid);
}

export function mergeStoredChains(chains: readonly (readonly RappFrame[])[], signatures?: SignaturePolicy): readonly RappFrame[] {
  const verified = chains.filter(chain => chain.length).map(chain => {
    const first = chain[0]!;
    const selected = selectChainTrust({
      genesis: { stream_id: first.stream_id, payload_hash: first.payload_hash, frame_hash: first.frame_hash },
      persistedHead: frameHead(chain.at(-1)!), requireCommittedHead: true,
    });
    const result = scanChain(chain.map(frame => canonicalJson(frame)), selected, signatures ? { signatures } : {});
    requireThat(result.ok, 'canonical-integrity', result.ok ? '' : result.error.message);
    return result;
  });
  return mergeFrames(verified);
}
