import fs from 'node:fs';
import path from 'node:path';
import {
  ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
  RAPP_ACCEPTED_BODY_PULSE_PROFILE,
  RAPP_ACCEPTED_BODY_STREAM_PROFILE,
  RAPP_ACCEPTED_MEMORY_STREAM_PROFILE,
  buildRappFrame,
  createRappFrameProfile,
  rappFrameToJson,
  selectRappChainTrustPolicy,
  verifyRappFrameJson,
  type RappFrame,
  type RappFrameHead,
} from '../../rapp/index.js';
import { rappCanonicalJson, rappHb } from '../../rappids/canonical.js';
import { VmRappEvidence, type VmRappPersistence } from '../rapp-evidence.js';
import type { VmWorkspaceIdentity } from '../types.js';

// Pre-minted UUIDv4-octet test identities, never derived from agent/VM names.
export const BODY_STREAM = `rappid:@test/computer:${rappHb('rapp/1:rappid', Buffer.from('12345678123442348234123456789abc', 'hex'))}`;
export const MEMORY_STREAM = `rappid:@test/agent:${rappHb('rapp/1:rappid', Buffer.from('8765432143214321a321cba987654321', 'hex'))}:session-one`;
const MEMORY_GENESIS_PROFILE = createRappFrameProfile({ name: 'vm-test-memory-genesis', kind: 'memory.save' });

interface StoredStream {
  family: 'body' | 'memory';
  genesis: RappFrame;
  head: RappFrame;
  sources: string[];
}

/** Fake host ownership/transport; frame serialization, disk bytes and scans are real. */
export class FakeRappPersistence implements VmRappPersistence {
  readonly streams = new Map<string, StoredStream>();
  readonly appended: RappFrame[] = [];
  appendError?: Error;
  acknowledgeWithoutWrite = false;
  beforeAppend?: (frame: RappFrame) => Promise<void>;

  constructor(readonly directory?: string) {
    if (directory) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [streamId, family] of [[BODY_STREAM, 'body'], [MEMORY_STREAM, 'memory']] as const) {
      const genesis = buildRappFrame({
        streamId, kind: family === 'body' ? 'body.pulse' : 'memory.save',
        utc: '2026-09-11T00:00:00.000Z', payload: { fixture: 'independently-pinned-genesis' }, head: null,
      }, family === 'body' ? RAPP_ACCEPTED_BODY_PULSE_PROFILE : MEMORY_GENESIS_PROFILE);
      const source = rappCanonicalJson(rappFrameToJson(genesis));
      this.streams.set(streamId, { family, genesis, head: genesis, sources: [source] });
      this.write(family, 0, source);
    }
  }

  private write(family: string, seq: number, source: string): void {
    if (!this.directory) return;
    const file = this.frameFile(family, seq);
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, source);
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    if (process.platform !== 'win32') {
      const parent = fs.openSync(this.directory, 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    }
  }

  frameFile(family: string, seq: number): string {
    return path.join(this.directory!, `${family}-${String(seq).padStart(8, '0')}.json`);
  }

  async selectStream(family: 'body' | 'memory', _identity: VmWorkspaceIdentity | null, signal: AbortSignal) {
    signal.throwIfAborted();
    const streamId = family === 'body' ? BODY_STREAM : MEMORY_STREAM;
    const stream = this.streams.get(streamId)!;
    return selectRappChainTrustPolicy({
      authority: ACCEPTED_RAPP_PROTOCOL_AUTHORITY,
      trustedGenesis: { streamId, frameHash: stream.genesis.frame_hash, payloadHash: stream.genesis.payload_hash },
      persistedHead: { streamId, seq: stream.head.seq, frameHash: stream.head.frame_hash },
    });
  }

  async readStream(streamId: string, signal: AbortSignal): Promise<readonly string[]> {
    signal.throwIfAborted();
    const stream = this.streams.get(streamId)!;
    return this.directory
      ? stream.sources.map((_source, seq) => fs.readFileSync(this.frameFile(stream.family, seq), 'utf8'))
      : [...stream.sources];
  }

  async appendFrame(source: string, head: Readonly<RappFrameHead>, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.appendError) throw this.appendError;
    const stream = this.streams.get(head.stream_id)!;
    const scanned = verifyRappFrameJson(
      source,
      stream.family === 'body' ? RAPP_ACCEPTED_BODY_STREAM_PROFILE : RAPP_ACCEPTED_MEMORY_STREAM_PROFILE,
      { head, streamIdOfRecord: head.stream_id },
    );
    if (!scanned.ok) throw scanned.error;
    await this.beforeAppend?.(scanned.frame);
    signal.throwIfAborted();
    const same = stream.sources[scanned.frame.seq];
    if (same === source) return;
    if (stream.head.frame_hash !== head.frame_hash || stream.head.seq !== head.seq) throw new Error('CAS head conflict');
    if (this.acknowledgeWithoutWrite) return;
    this.write(stream.family, scanned.frame.seq, source);
    stream.sources.push(source);
    stream.head = scanned.frame;
    this.appended.push(scanned.frame);
  }
}

export function testEvidence(persistence = new FakeRappPersistence()): VmRappEvidence {
  return new VmRappEvidence(persistence);
}
