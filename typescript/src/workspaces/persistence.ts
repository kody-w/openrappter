import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  protocolAuthorityIdentity,
  rappFrameToJson,
  selectRappChainTrustPolicy,
  verifyRappEvidenceChain,
  type OpenRappterEvidenceFrame,
} from '../rapp/index.js';
import { rappCanonicalJson, snapshotRappJsonValue } from '../rappids/canonical.js';
import { validateWorkspaceAgentId } from './filesystem.js';
import { WorkspaceError, type AppendWorkspaceEvidenceInput, type WorkspaceFramePersistence } from './types.js';

function canonical(value: unknown): string {
  try {
    return rappCanonicalJson(snapshotRappJsonValue(value));
  } catch (error) {
    throw new WorkspaceError('integrity', 'persistence boundary returned non-canonical evidence', error);
  }
}

/**
 * Cross-component commit contract: a producer receives the actual canonical
 * frame only after an independent read proves membership in the persisted chain.
 * A receipt, metadata flag, or unpersisted builder result is not sufficient.
 */
export async function commitWorkspaceEvidence(
  persistence: WorkspaceFramePersistence,
  agentId: string,
  input: AppendWorkspaceEvidenceInput,
): Promise<OpenRappterEvidenceFrame> {
  const id = validateWorkspaceAgentId(agentId);
  const receipt = await persistence.appendEvidence(id, input);
  const workspace = await persistence.get(id);
  if (
    workspace === null || workspace.agentId !== id || workspace.manifest.identity.agentId !== id
    || canonical(workspace.manifest.protocolRevision) !== canonical(protocolAuthorityIdentity(ACCEPTED_RAPP_PROTOCOL_AUTHORITY))
  ) {
    throw new WorkspaceError('integrity', 'committed evidence lacks the expected workspace identity and selected authority');
  }
  const checkpoint = workspace.manifest.streams.body;
  if (
    checkpoint.genesis === null || checkpoint.head === null
    || checkpoint.streamId !== workspace.manifest.identity.rappid
    || checkpoint.frameHashes.length !== checkpoint.head.seq + 1
    || checkpoint.frameHashes[0] !== checkpoint.genesis.frameHash
    || checkpoint.frameHashes[checkpoint.frameHashes.length - 1] !== checkpoint.head.frameHash
  ) {
    throw new WorkspaceError('integrity', 'committed evidence has no consistent persisted index, genesis, and head');
  }
  // Capture the checkpoint before scanning: concurrent append-only growth is
  // valid, but a scan older than this checkpoint must fail as a rollback.
  const streamId = checkpoint.streamId;
  const frameHashes = [...checkpoint.frameHashes];
  const policy = selectRappChainTrustPolicy({
    trustedGenesis: checkpoint.genesis,
    persistedHead: checkpoint.head,
  });
  const scan = await persistence.frames(id, 'body');
  if (scan.agentId !== id || scan.stream !== 'body' || scan.streamId !== streamId) {
    throw new WorkspaceError('integrity', 'evidence scan belongs to a different workspace or stream');
  }
  const checked = verifyRappEvidenceChain(scan.frames, policy);
  if (!checked.ok) {
    throw new WorkspaceError('integrity', 'persistence boundary did not provide a verified committed chain', checked.error);
  }
  for (const [seq, frameHash] of frameHashes.entries()) {
    if (checked.frames[seq]?.seq !== seq || checked.frames[seq].frame_hash !== frameHash) {
      throw new WorkspaceError('integrity', 'evidence scan conflicts with a committed frame address');
    }
  }
  const receiptJson = canonical(receipt);
  const committed = checked.frames.find((frame) => canonical(rappFrameToJson(frame)) === receiptJson);
  if (committed === undefined) {
    throw new WorkspaceError('integrity', 'emitted evidence was not found in the persisted frame scan');
  }
  return committed;
}
