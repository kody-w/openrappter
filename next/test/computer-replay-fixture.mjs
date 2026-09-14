import { buildFrame, canonicalJson, contentHash, frameHead, sha256 } from '../dist/canonical.js';
import { findRoot } from '../dist/bots.js';
import { CanonicalComputerReplay } from '../dist/computer-replay.js';

export async function computerReplayFixture(h, root) {
  const owner = { agentId: 'fixture-agent', workspaceId: 'fixture-workspace' };
  const computerId = 'fixture-omarchy';
  const policy = await h.runtime.bots.repository.transaction(tx => h.runtime.bots.appendEvent(tx, findRoot(tx, root),
    'computer.replay.policy', {
      schema: 'rapp-work.guest-replay-policy/1', enabled: true, target: 'omarchy-guest',
      dataClass: 'godd', visibility: 'private', computerId, hostScreen: 'forbidden',
      secrets: 'excluded', keystrokes: 'excluded',
    }, 'private-guest-policy'));
  const frames = [];
  const stream = `${root}:computer-evidence`;
  const emit = payload => {
    const frame = buildFrame({ kind: 'memory.save', streamId: stream, head: frames.length ? frameHead(frames.at(-1)) : null,
      utc: h.runtime.bots.now(), payload, signer: h.keys.signers[0].signer, signatures: h.keys.signatures });
    frames.push(frame); return frame;
  };
  const link = async (operation, value, receipts, id) => {
    const command = { scope: { agentId: 'history-agent', workspaceId: 'history-workspace' }, idempotencyKey: id, operation,
      payload: { computerId, owner, argv: ['fixture-command', 'EXCLUDED-SECRET-ARGUMENT'],
        cwd: '/workspaces/fixture-workspace', privateKeyStrokeBuffer: 'EXCLUDED-KEYSTROKES' }, resources: [] };
    const hash = contentHash(command);
    const intent = emit({ type: 'work.intent', version: 1, commandHash: hash, command, principalId: 'fixture-owner', at: h.runtime.bots.now() });
    const outcome = emit({ type: 'work.outcome', version: 1, commandHash: hash, intentRef: intent.frame_hash,
      status: 'succeeded', value, receiptsHash: contentHash(receipts), events: [], at: h.runtime.bots.now() });
    const evidence = emit({ type: 'work.evidence', version: 1, commandHash: hash, intentRef: intent.frame_hash,
      outcomeRef: outcome.frame_hash, receipts, at: h.runtime.bots.now() });
    const linked = await h.runtime.bots.repository.transaction(tx => h.runtime.bots.appendEvent(tx, findRoot(tx, root),
      'computer.receipt.linked', { kind: 'computer-receipt', computerId, intentRef: intent.frame_hash,
        outcomeRef: outcome.frame_hash, evidenceRef: evidence.frame_hash }, `linked-${id}`));
    return { intent, outcome, evidence, linked };
  };
  // Synthetic recorded pixels, not a claim that a live guest was captured.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMxkAAAAASUVORK5CYII=', 'base64');
  const imageHash = sha256(png);
  const capture = await link('computer.artifact.download', { artifactId: 'guest-frame', sha256: imageHash },
    [{ kind: 'artifact-download', artifactId: 'guest-frame', sha256: imageHash, bytes: png.length }], 'capture');
  const approval = emit({ type: 'computer.guest-capture.approved', artifactId: 'guest-frame', sha256: imageHash,
    surface: 'omarchy-guest', policyWave: policy.frame_hash, exclusions: 'secrets-and-keystrokes-excluded' });
  const command = await link('computer.execute', { exitCode: 0, stdout: 'EXCLUDED-SECRET-STDOUT', stderr: 'EXCLUDED-SECRET-STDERR' },
    [{ kind: 'guest-execution', exitCode: 0 }], 'command');
  const diff = await link('computer.artifact.download', { artifactId: 'diff-artifact', sha256: '2'.repeat(64) },
    [{ kind: 'guest-diff-summary', filesChanged: 2, addedLines: 7, removedLines: 3 }], 'diff');
  const absent = await link('computer.artifact.download', { artifactId: 'missing-frame', sha256: '3'.repeat(64) },
    [{ kind: 'artifact-download', artifactId: 'missing-frame', sha256: '3'.repeat(64), bytes: 123 }], 'absent');
  const binding = {
    root, scope: 'root', computerId, producer: root, stream, owner,
    canonicalFrames: frames.map(f => canonicalJson(f)), signatures: h.keys.signatures,
    approvedGuestArtifacts: [{ artifactId: 'guest-frame', sha256: imageHash, bytes: png, policyWave: policy.frame_hash,
      surface: 'omarchy-guest', exclusions: 'secrets-and-keystrokes-excluded', approvalFrame: approval.frame_hash }],
  };
  return {
    policy, frames, png, binding, replay: new CanonicalComputerReplay(binding), capture, command, diff, absent,
    option: { enabled: true, dataClass: 'godd', visibility: 'private', policyWave: policy.frame_hash },
  };
}
