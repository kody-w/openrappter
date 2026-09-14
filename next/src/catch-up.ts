import { canonicalJson, contentHash, snapshotJson, type JsonObject, type RappFrame } from './canonical.js';
import { label, object, workEvent } from './contract.js';
import { Refusal, requireThat } from './errors.js';
import { atCursor, cursorFor, projectAi } from './ai-projector.js';
import { publicationData, publicationKind } from './ai-contract.js';
import { reference } from './projection.js';
import type { RootSnapshot } from './repository.js';
import { foldState, permittedScopes } from './state.js';
import { CanonicalComputerReplay, guestOptIn, GUEST_REPLAY_SCHEMA } from './computer-replay.js';

export const CATCH_UP_SCHEMA = 'rapp-work.catch-up/1';
export const CATCH_UP_LIMITS = Object.freeze({ steps: 16, stateBytes: 98_304, pageBytes: 524_288 });
export type ReplayGrade = 'recorded' | 'reconstructed' | 'unavailable';
export interface ReplayState extends JsonObject {
  root: string;
  scope: string;
  cursor: JsonObject | null;
  projection: JsonObject | null;
  guest: JsonObject | null;
}
export interface ReplayCheckpoint extends JsonObject {
  cursor: JsonObject | null;
  grade: 'reconstructed' | 'unavailable';
  stateDigest: string | null;
  state: ReplayState | null;
  reason: string | null;
  sourceFrameHashes: string[];
}
export interface ReplayStep extends JsonObject {
  cursor: JsonObject;
  previousCursor: JsonObject | null;
  event: string;
  grade: ReplayGrade;
  workGrade: 'recorded' | 'unavailable';
  stateGrade: 'reconstructed' | 'unavailable';
  sourceFrameHashes: string[];
  publicSummary: string | null;
  stateDigest: string | null;
  state: ReplayState | null;
  reason: string | null;
  guest: JsonObject | null;
  guestDigest: string | null;
}

function checkpoint(root: RootSnapshot, scope: string, guest: JsonObject | null = null): ReplayCheckpoint {
  const cursor = cursorFor(root);
  const sourceFrameHashes = [root.streams.body[0]!.frame_hash, ...(cursor ? [String(cursor.frame_hash)] : [])];
  try {
    const projection = projectAi(root, scope);
    const state: ReplayState = { root: root.definition.root, scope, cursor, projection, guest };
    if (Buffer.byteLength(canonicalJson(state)) > CATCH_UP_LIMITS.stateBytes) {
      return { cursor, grade: 'unavailable', stateDigest: null, state: null, reason: 'state-byte-bound', sourceFrameHashes };
    }
    return { cursor, grade: 'reconstructed', stateDigest: contentHash(state), state, reason: null, sourceFrameHashes };
  } catch (error) {
    if (error instanceof Refusal && ['scope', 'scope-dependency', 'projection-size'].includes(error.code)) {
      return { cursor, grade: 'unavailable', stateDigest: null, state: null, reason: 'historical-scope-or-state-unavailable', sourceFrameHashes };
    }
    throw error;
  }
}

function publicMaterial(frame: RappFrame): { summary: string | null; recordedView: boolean; refusedView: boolean; hashes: string[] } {
  const e = workEvent(frame.payload);
  const sources = [frame.frame_hash];
  if (['client.conversation', 'client.activity', 'client.evidence', 'client.attention', 'client.view'].includes(e.event)) {
    const p = publicationData(publicationKind(e.event.slice('client.'.length)), e.data);
    return {
      summary: String(p.content.text ?? p.content.summary ?? 'Recorded bounded declarative view intent.'),
      recordedView: p.view !== null, refusedView: p.viewRefusal !== null,
      hashes: [...sources, ...p.causes, ...p.viewParents],
    };
  }
  const publicEvents = new Set(['turn.user', 'turn.assistant', 'work.progress', 'organization.applied',
    'state.corrected', 'routine.tick', 'root.visibility', 'provider.unavailable', 'operation.interrupted',
    'collaboration.synthesized', 'collaboration.perspective', 'migration.root.imported', 'migration.pointer.imported']);
  if (!publicEvents.has(e.event)) return { summary: null, recordedView: false, refusedView: false, hashes: sources };
  let summary = e.data.text ?? e.data.summary ?? e.data.reason;
  if (e.event === 'root.visibility') summary = e.data.hidden ? 'Root hidden; history retained.' : 'Same root restored.';
  if (e.event.startsWith('migration.')) summary = `Recorded ${e.event}; original source identity and classification remain canonical.`;
  if (summary === undefined) summary = `Recorded ${e.event}.`;
  const evidence = Array.isArray(e.data.evidence) ? e.data.evidence.filter((v): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)) : [];
  return { summary: String(summary).slice(0, 4_000), recordedView: false, refusedView: false, hashes: [...sources, ...evidence] };
}

/** Pure replay over already verified canonical data; never invokes a runtime or writes state. */
export function catchUpTimeline(root: RootSnapshot, scope: string, value: unknown = {}, computer?: CanonicalComputerReplay): JsonObject {
  label(scope);
  const input = object(value, [], ['from', 'to', 'limit', 'guest']);
  const guestRequest = input.guest === undefined ? null : guestOptIn(input.guest);
  const limit = input.limit === undefined ? CATCH_UP_LIMITS.steps : Number(input.limit);
  requireThat((input.limit === undefined || typeof input.limit === 'number') && Number.isInteger(limit)
    && limit >= 1 && limit <= CATCH_UP_LIMITS.steps, 'replay-bound', 'Catch-up pages contain at most sixteen canonical occurrences.');
  const allowed = permittedScopes(foldState(root).scopes, scope);
  const end = input.to === undefined ? root : atCursor(root, input.to);
  const from = input.from === undefined
    ? { ...end, streams: { ...end.streams, memory: end.streams.memory.slice(0, Math.max(0, end.streams.memory.length - limit)) } }
    : atCursor(root, input.from);
  requireThat(from.streams.memory.length <= end.streams.memory.length, 'replay-range', 'The start cursor must not follow the fixed end cursor.');
  const baseline = checkpoint(from, scope);
  const steps: ReplayStep[] = [];
  let cursor = cursorFor(from);
  let bytes = Buffer.byteLength(canonicalJson(baseline));
  for (const frame of end.streams.memory.slice(from.streams.memory.length, from.streams.memory.length + limit)) {
    const visible = allowed.has(String(frame.payload.scope));
    const after = atCursor(end, reference(frame));
    let guest: JsonObject | null = null;
    if (visible && frame.payload.event === 'computer.receipt.linked' && guestRequest) {
      try {
        guest = computer?.project(root, scope, frame, guestRequest) ?? {
          schema: GUEST_REPLAY_SCHEMA, grade: 'unavailable', kind: 'missing-display', dataClass: 'godd', visibility: 'private',
          sourceFrameHashes: [frame.frame_hash], reason: 'canonical-computer-broker-binding-unavailable',
          image: null, command: null, diff: null, execution: false,
        };
      } catch {
        guest = { schema: GUEST_REPLAY_SCHEMA, grade: 'unavailable', kind: 'missing-display', dataClass: 'godd', visibility: 'private',
          sourceFrameHashes: [frame.frame_hash], reason: 'guest-policy-origin-safety-or-evidence-unavailable',
          image: null, command: null, diff: null, execution: false };
      }
    }
    const state = checkpoint(after, scope, guest);
    const material = visible ? publicMaterial(frame) : { summary: null, recordedView: false, refusedView: false, hashes: [frame.frame_hash] };
    const unavailable = !visible || material.summary === null || material.refusedView || state.grade === 'unavailable'
      || (material.recordedView && object(state.state?.projection?.view).status === 'invalidated');
    const grade: ReplayGrade = guest ? guest.grade as ReplayGrade : unavailable ? 'unavailable' : material.recordedView ? 'recorded' : 'reconstructed';
    const reason = !visible ? 'outside-authorized-scope' : material.summary === null ? 'control-payload-not-public'
      : material.refusedView ? 'recorded-hint-unavailable' : state.reason
        ?? (unavailable ? 'recorded-reference-unavailable' : grade === 'recorded' ? 'recorded-declarative-intent-not-screen-recording' : 'projection-reconstructed-from-canonical-work');
    const step: ReplayStep = {
      cursor: reference(frame), previousCursor: cursor, event: visible ? String(frame.payload.event) : 'scoped-record-unavailable',
      grade, workGrade: guest && guest.grade !== 'unavailable' ? 'recorded' : material.summary === null ? 'unavailable' : 'recorded', stateGrade: state.grade,
      sourceFrameHashes: guest ? guest.sourceFrameHashes as string[] : material.hashes,
      publicSummary: guest ? `${String(guest.grade)} Omarchy guest replay: ${String(guest.kind)}; no execution.` : material.summary,
      stateDigest: state.stateDigest, state: state.state, reason: guest ? String(guest.reason) : reason,
      guest, guestDigest: guest ? contentHash(guest) : null,
    };
    const size = Buffer.byteLength(canonicalJson(step));
    if (steps.length && bytes + size > CATCH_UP_LIMITS.pageBytes) break;
    requireThat(bytes + size <= CATCH_UP_LIMITS.pageBytes, 'replay-bound', 'Narrow the replay scope; the first checkpoint exceeds the page byte bound.');
    steps.push(step); bytes += size; cursor = reference(frame);
  }
  const to = cursorFor(end);
  const selection = { root: root.definition.root, scope, from: cursorFor(from), to,
    sourceFrameHashes: end.streams.memory.slice(from.streams.memory.length).map(f => f.frame_hash),
    guestPolicy: guestRequest, guestEvidenceDigest: guestRequest ? computer?.snapshotDigest ?? null : null };
  const result: JsonObject = {
    schema: CATCH_UP_SCHEMA, root: root.definition.root, scope, from: cursorFor(from), to, baseline, steps,
    next: cursor, more: (cursor === null ? 0 : Number(cursor.seq) + 1) < end.streams.memory.length,
    selectionDigest: contentHash(selection), digestSpace: 'rapp/1:particle',
    grades: {
      recorded: steps.filter(s => s.grade === 'recorded').length,
      reconstructed: steps.filter(s => s.grade === 'reconstructed').length,
      unavailable: steps.filter(s => s.grade === 'unavailable').length,
    },
    contract: {
      ordering: 'canonical-memory-stream-sequence; UTC/wave and explicit causes retained, not a global causal clock',
      gradeScope: 'presentation-basis; workGrade and stateGrade are separate',
      recordedMeans: 'stored declarative intent for ordinary replay; exact approved guest image bytes only for an explicitly authorized private guest lane',
      stateMeans: 'exact returned authorized reconstruction, not regenerated model reasoning',
      modelCalls: 0, toolExecutions: 0, mutations: 0, screenRecording: false, captureDuringReplay: false,
      guestReplayOptIn: guestRequest !== null, guestPrivacy: 'GODD/private; no host screen, secrets, keystrokes or execution',
      guestFrames: 'recorded only from exact approved canonical ComputerBroker guest artifacts',
      guestCommandAndDiff: 'reconstructed safe summaries; raw command/output/diff content excluded',
      alternativeBranchesReplayed: false,
    },
  };
  return snapshotJson({ ...result, timelineDigest: contentHash(result) }) as JsonObject;
}
