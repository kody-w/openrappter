import {
  canonicalJson, contentHash, frameHead, isBodyStream, sha256, signerOf, verifiedFrame,
  type JsonObject, type RappFrame, type SignaturePolicy,
} from './canonical.js';
import { label, object, text, workEvent } from './contract.js';
import { requireThat } from './errors.js';
import { wave } from './intent.js';
import type { RootSnapshot } from './repository.js';
import { memoryFrames } from './source-memory.js';

export const GUEST_REPLAY_SCHEMA = 'rapp-work.omarchy-replay/1';
export interface GuestReplayOptIn extends JsonObject {
  enabled: true;
  dataClass: 'godd';
  visibility: 'private';
  policyWave: string;
}
export function guestOptIn(value: unknown): GuestReplayOptIn {
  const g = object(value, ['enabled', 'dataClass', 'visibility', 'policyWave']);
  requireThat(g.enabled === true && g.dataClass === 'godd' && g.visibility === 'private',
    'guest-opt-in', 'Guest replay is explicit opt-in GODD/private data, never a public or host-screen fallback.');
  wave(g.policyWave);
  return g as GuestReplayOptIn;
}

export interface ApprovedGuestArtifact {
  readonly artifactId: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly policyWave: string;
  readonly surface: 'omarchy-guest';
  readonly exclusions: 'secrets-and-keystrokes-excluded';
  readonly approvalFrame: string;
}
export interface ComputerReplayBinding {
  readonly root: string;
  readonly scope: string;
  readonly computerId: string;
  readonly producer: string;
  readonly stream: string;
  readonly owner: { readonly agentId: string; readonly workspaceId: string };
  readonly canonicalFrames: readonly string[];
  readonly signatures: SignaturePolicy;
  /** Host-selected, independently verified safety/origin approvals; not API claims. */
  readonly approvedGuestArtifacts: readonly ApprovedGuestArtifact[];
}
interface Triple { intent: RappFrame; outcome?: RappFrame; evidence?: RappFrame }

function payload(frame: RappFrame): JsonObject {
  return object(frame.payload.data === undefined ? frame.payload : frame.payload.data);
}

/**
 * Immutable read-only adapter over an already-selected canonical ComputerBroker
 * snapshot. It exposes no VM, execute, capture, keyboard, host-screen or I/O port.
 */
export class CanonicalComputerReplay {
  readonly #triples = new Map<string, Triple>();
  readonly #frames = new Map<string, RappFrame>();
  readonly #artifacts = new Map<string, ApprovedGuestArtifact>();
  readonly #binding: Pick<ComputerReplayBinding, 'root' | 'scope' | 'computerId' | 'producer' | 'owner'>;
  readonly snapshotDigest: string;

  constructor(binding: ComputerReplayBinding) {
    requireThat(isBodyStream(binding.root) && isBodyStream(binding.producer), 'guest-owner', 'An exact root and selected canonical producer are required.');
    this.#binding = {
      root: binding.root, scope: label(binding.scope), computerId: text(binding.computerId, 128), producer: binding.producer,
      owner: object(binding.owner, ['agentId', 'workspaceId']) as { agentId: string; workspaceId: string },
    };
    requireThat(binding.canonicalFrames.length <= 1_024 && binding.approvedGuestArtifacts.length <= 32,
      'guest-bound', 'The canonical guest replay snapshot exceeds its bounds.');
    requireThat(binding.canonicalFrames.reduce((total, bytes) => total + Buffer.byteLength(bytes), 0) <= 8_388_608,
      'guest-bound', 'The canonical ComputerBroker replay snapshot exceeds the eight MiB read bound.');
    let previous: RappFrame | null = null;
    for (const bytes of binding.canonicalFrames) {
      const frame = verifiedFrame(bytes, binding.stream, previous ? frameHead(previous) : null, binding.signatures);
      requireThat(signerOf(frame) === binding.producer, 'guest-producer', 'Computer evidence requires its explicitly selected producer signature.');
      this.#frames.set(frame.frame_hash, frame); previous = frame;
      const data = payload(frame);
      if (data.type === 'work.intent') {
        const command = object(data.command);
        requireThat(data.commandHash === contentHash(command), 'guest-evidence', 'Canonical broker command digest mismatch.');
        this.#triples.set(frame.frame_hash, { intent: frame });
      } else if (data.type === 'work.outcome' || data.type === 'work.evidence') {
        const triple = this.#triples.get(String(data.intentRef));
        requireThat(triple && payload(triple.intent).commandHash === data.commandHash, 'guest-evidence', 'Broker occurrence links must retain their canonical intent.');
        if (data.type === 'work.outcome') {
          requireThat(!triple.outcome, 'guest-evidence', 'Duplicate broker outcome.');
          triple.outcome = frame;
        } else {
          requireThat(triple.outcome && !triple.evidence && data.outcomeRef === triple.outcome.frame_hash
            && contentHash(data.receipts) === payload(triple.outcome).receiptsHash,
          'guest-evidence', 'A complete broker intent/outcome/evidence triple is required.');
          triple.evidence = frame;
        }
      }
    }
    for (const artifact of binding.approvedGuestArtifacts) {
      label(artifact.artifactId); wave(artifact.sha256); wave(artifact.policyWave); wave(artifact.approvalFrame);
      const approval = this.#frames.get(artifact.approvalFrame);
      requireThat(artifact.surface === 'omarchy-guest' && artifact.exclusions === 'secrets-and-keystrokes-excluded'
        && approval && artifact.bytes.length > 0 && artifact.bytes.length <= 65_536 && sha256(artifact.bytes) === artifact.sha256,
      'guest-capture-approval', 'Only exact host-approved canonical Omarchy guest artifacts with safety/origin evidence may be replayed.');
      const attestation = object(payload(approval), ['type', 'artifactId', 'sha256', 'surface', 'policyWave', 'exclusions']);
      requireThat(attestation.type === 'computer.guest-capture.approved' && attestation.artifactId === artifact.artifactId
        && attestation.sha256 === artifact.sha256 && attestation.surface === artifact.surface
        && attestation.policyWave === artifact.policyWave && attestation.exclusions === artifact.exclusions,
      'guest-capture-approval', 'The selected capture approval does not bind these exact bytes, origin and exclusions.');
      const bytes = Buffer.from(artifact.bytes);
      requireThat(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 2048
        && bytes.readUInt32BE(20) > 0 && bytes.readUInt32BE(20) <= 2048,
      'guest-image', 'Replay carries bounded PNG guest frames only, never executable content or a host display.');
      this.#artifacts.set(artifact.artifactId, { ...artifact, bytes: Uint8Array.from(bytes) });
    }
    this.snapshotDigest = contentHash({
      root: binding.root, scope: binding.scope, computerId: binding.computerId, producer: binding.producer,
      frames: [...this.#frames.keys()], artifacts: [...this.#artifacts.values()].map(a => ({
        artifactId: a.artifactId, sha256: a.sha256, approvalFrame: a.approvalFrame, policyWave: a.policyWave,
      })),
    });
  }

  project(root: RootSnapshot, scope: string, link: RappFrame, optIn: GuestReplayOptIn): JsonObject {
    requireThat(root.definition.root === this.#binding.root && scope === this.#binding.scope,
      'guest-scope', 'Computer replay is bound to one exact canonical root and internal scope.');
    const memory = memoryFrames(root);
    const policy = memory.find(f => f.frame_hash === optIn.policyWave && f.payload.event === 'computer.replay.policy');
    requireThat(policy && signerOf(policy) === root.definition.root && memory.indexOf(policy) < memory.indexOf(link),
      'guest-policy', 'An original root-signed private guest capture policy must precede this recorded occurrence.');
    const selected = memory.filter(f => f.payload.event === 'computer.replay.policy'
      && f.payload.scope === scope).at(-1);
    requireThat(selected?.frame_hash === policy.frame_hash, 'guest-policy', 'Guest replay policy changed or was revoked.');
    const permission = object(workEvent(policy.payload).data,
      ['schema', 'enabled', 'target', 'dataClass', 'visibility', 'computerId', 'hostScreen', 'secrets', 'keystrokes']);
    requireThat(permission.schema === 'rapp-work.guest-replay-policy/1' && permission.enabled === true
      && permission.target === 'omarchy-guest' && permission.dataClass === 'godd' && permission.visibility === 'private'
      && permission.computerId === this.#binding.computerId && permission.hostScreen === 'forbidden'
      && permission.secrets === 'excluded' && permission.keystrokes === 'excluded',
    'guest-policy', 'No host screen, secrets or keystrokes can be included by a replay option.');
    const data = object(workEvent(link.payload).data, ['kind', 'computerId', 'intentRef', 'outcomeRef', 'evidenceRef'], ['heads']);
    requireThat(data.kind === 'computer-receipt' && data.computerId === this.#binding.computerId,
      'guest-evidence', 'Use an existing canonical ComputerBroker receipt link.');
    const triple = this.#triples.get(String(data.intentRef));
    requireThat(triple?.outcome && triple.evidence && triple.outcome.frame_hash === data.outcomeRef
      && triple.evidence.frame_hash === data.evidenceRef, 'guest-evidence', 'Broker evidence is absent or bound to a different occurrence.');
    const command = object(payload(triple.intent).command);
    const commandPayload = object(command.payload);
    requireThat(commandPayload.computerId === this.#binding.computerId
      && canonicalJson(commandPayload.owner) === canonicalJson(this.#binding.owner),
    'guest-owner', 'Guest evidence cannot cross the ComputerBroker workspace owner boundary.');
    const operation = text(command.operation, 80);
    const outcome = payload(triple.outcome), evidence = payload(triple.evidence);
    const sourceFrameHashes = [link.frame_hash, policy.frame_hash, triple.intent.frame_hash, triple.outcome.frame_hash, triple.evidence.frame_hash];
    const receipts = Array.isArray(evidence.receipts) ? evidence.receipts.map(r => object(r)) : [];
    const downloads = receipts.filter(r => r.kind === 'artifact-download');
    for (const receipt of downloads) {
      const artifact = this.#artifacts.get(String(receipt.artifactId));
      if (!artifact) continue;
      requireThat(operation === 'computer.artifact.download' && outcome.status === 'succeeded'
        && receipt.sha256 === artifact.sha256 && receipt.bytes === artifact.bytes.length && artifact.policyWave === policy.frame_hash,
      'guest-evidence', 'A guest frame must retain exact broker download and capture-policy binding.');
      return {
        schema: GUEST_REPLAY_SCHEMA, grade: 'recorded', kind: 'guest-frame', dataClass: 'godd', visibility: 'private',
        sourceFrameHashes: [...sourceFrameHashes, artifact.approvalFrame], reason: 'canonical-guest-frame-bytes-with-selected-origin-and-safety-approval',
        image: { artifactId: artifact.artifactId, mediaType: 'image/png', sha256: artifact.sha256,
          bytes: artifact.bytes.length, base64: Buffer.from(artifact.bytes).toString('base64') },
        command: null, diff: null, execution: false,
      };
    }
    const diff = receipts.find(r => r.kind === 'guest-diff-summary');
    if (diff) {
      object(diff, ['kind', 'filesChanged', 'addedLines', 'removedLines']);
      requireThat([diff.filesChanged, diff.addedLines, diff.removedLines].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 1_000_000),
        'guest-diff', 'Only bounded aggregate diff counts may be reconstructed.');
      return { schema: GUEST_REPLAY_SCHEMA, grade: 'reconstructed', kind: 'diff-summary', dataClass: 'godd', visibility: 'private',
        sourceFrameHashes, reason: 'aggregate-canonical-diff-visualization-not-captured-pixels', image: null,
        command: null, diff: { filesChanged: diff.filesChanged!, addedLines: diff.addedLines!, removedLines: diff.removedLines! }, execution: false };
    }
    if (operation === 'computer.execute') {
      const value = object(outcome.value);
      requireThat(Number.isInteger(value.exitCode) && Number(value.exitCode) >= 0 && Number(value.exitCode) <= 255,
        'guest-command', 'Canonical command result is unavailable.');
      return { schema: GUEST_REPLAY_SCHEMA, grade: 'reconstructed', kind: 'command-summary', dataClass: 'godd', visibility: 'private',
        sourceFrameHashes, reason: 'safe-command-result-visualization-not-captured-pixels', image: null, diff: null,
        command: { operation: 'computer.execute', status: String(outcome.status), exitCode: value.exitCode!,
          rawCommand: 'excluded', stdout: 'excluded', stderr: 'excluded', keystrokes: 'excluded' }, execution: false };
    }
    return { schema: GUEST_REPLAY_SCHEMA, grade: 'unavailable', kind: 'missing-display', dataClass: 'godd', visibility: 'private',
      sourceFrameHashes, reason: 'no-approved-canonical-guest-display-artifact', image: null, command: null, diff: null, execution: false };
  }
}
