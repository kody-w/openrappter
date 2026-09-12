import {
  AUTHORITY_IDENTITY, assertOptions, canonicalJson, isVerifiedChain, snapshotJson, streamFamily,
  type JsonObject, type RappFrame, type VerifiedChain,
} from '@rapp-work/rapp1';
import { assertIdentifier } from '@rapp-work/security';
import { DomainError } from './events.js';

export type ComputerState = 'unavailable' | 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export interface ComputerObservation extends JsonObject {
  type: 'computer.observed';
  computer_id: 'omarchy';
  observation_id: string;
  state: ComputerState;
  lease_id: string | null;
  detail: string | null;
}
export interface ComputerProjection {
  readonly id: 'omarchy';
  readonly state: ComputerState;
  readonly leaseId: string | null;
  readonly detail: string | null;
  readonly sourceFrameHash: string;
  readonly observations: readonly { id: string; state: ComputerState; utc: string; frameHash: string }[];
}
const STATES: readonly ComputerState[] = ['unavailable', 'stopped', 'starting', 'running', 'stopping', 'failed'];
const NEXT: Record<ComputerState, readonly ComputerState[]> = {
  unavailable: ['stopped', 'failed'],
  stopped: ['starting', 'unavailable', 'failed'],
  starting: ['running', 'stopped', 'failed', 'unavailable'],
  running: ['stopping', 'failed', 'unavailable'],
  stopping: ['stopped', 'failed', 'unavailable'],
  failed: ['stopped', 'unavailable'],
};

export function validateComputerObservation(value: unknown): ComputerObservation {
  const data = snapshotJson(value);
  assertOptions(data, ['type', 'computer_id', 'observation_id', 'state', 'lease_id', 'detail']);
  assertIdentifier(data.observation_id, 'observation');
  if (data.type !== 'computer.observed' || data.computer_id !== 'omarchy' || !STATES.includes(data.state as ComputerState)) {
    throw new DomainError('computer', 'Only the application-owned Omarchy computer is supported');
  }
  if (data.lease_id !== null) assertIdentifier(data.lease_id, 'lease');
  if (['starting', 'running', 'stopping'].includes(data.state as string) && data.lease_id === null) {
    throw new DomainError('computer-lease', 'An active computer needs an explicit lifecycle lease');
  }
  if (['unavailable', 'stopped'].includes(data.state as string) && data.lease_id !== null) {
    throw new DomainError('computer-lease', 'Inactive observations cannot retain a lifecycle lease');
  }
  if (data.detail !== null) assertIdentifier(data.detail, 'observation detail');
  return data as unknown as ComputerObservation;
}

export function buildComputerPayload(observation: ComputerObservation): JsonObject {
  return snapshotJson({
    subject: 'computer:omarchy', data: validateComputerObservation(observation), protocol_revision: AUTHORITY_IDENTITY,
  }) as JsonObject;
}

export function computerObservationFrame(frame: RappFrame): ComputerObservation {
  assertOptions(frame.payload, ['subject', 'data', 'protocol_revision']);
  if (frame.kind !== 'body.pulse' || streamFamily(frame.stream_id) !== 'body'
    || frame.payload.subject !== 'computer:omarchy'
    || canonicalJson(frame.payload.protocol_revision) !== canonicalJson(AUTHORITY_IDENTITY)) {
    throw new DomainError('computer-frame', 'Computer state requires the selected canonical body history');
  }
  return validateComputerObservation(frame.payload.data);
}

export function reduceComputerHistory(chain: VerifiedChain): ComputerProjection {
  if (!isVerifiedChain(chain) || chain.trust.persistedHead !== 'matched' || streamFamily(chain.head.stream_id) !== 'body') {
    throw new DomainError('computer-trust', 'Computer history must be a full scanned committed body chain');
  }
  let latest: ComputerObservation | null = null;
  let sourceFrameHash = '';
  const observations: { id: string; state: ComputerState; utc: string; frameHash: string }[] = [];
  const seen = new Set<string>();
  for (const frame of chain.frames) {
    const current = computerObservationFrame(frame);
    if (seen.has(current.observation_id)) throw new DomainError('computer-replay', 'Repeated computer observation');
    if (latest && !NEXT[latest.state].includes(current.state)) throw new DomainError('computer-transition', 'Impossible or polling-only computer transition');
    if (latest && ['starting', 'running'].includes(latest.state) && ['running', 'stopping'].includes(current.state)
      && current.lease_id !== latest.lease_id) throw new DomainError('computer-lease', 'Computer lease changed during an active transition');
    seen.add(current.observation_id);
    latest = current; sourceFrameHash = frame.frame_hash;
    observations.push({ id: current.observation_id, state: current.state, utc: frame.utc, frameHash: frame.frame_hash });
  }
  if (latest === null) throw new DomainError('computer-empty', 'There is no observed computer state');
  return snapshotJson({
    id: 'omarchy', state: latest.state, leaseId: latest.lease_id, detail: latest.detail, sourceFrameHash, observations,
  }) as unknown as ComputerProjection;
}
