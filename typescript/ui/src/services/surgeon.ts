import { gateway } from './gateway.js';
import type {
  SurgeonCase,
  SurgeonConsultResult,
  SurgeonPatientSnapshot,
  SurgeonProcedure,
} from '../types.js';

export interface ProcedureReference {
  caseId: string;
  procedureId: string;
  digest: string;
  confirmation?: string;
}

/**
 * A surgeon turn shells out to Copilot, and an operation adds a full agent tool
 * loop plus a verification round-trip. These need the same long budget the agent
 * and cron surfaces already use rather than the 15s client default.
 */
export const SURGEON_TURN_TIMEOUT_MS = 15 * 60_000;
export const SURGEON_OPERATION_TIMEOUT_MS = 30 * 60_000;

export interface SurgeonFeatureSnapshot {
  brainSurgeonGroupChat: boolean;
}

export interface GroupParticipantSummary {
  rappid: string;
  liveId: string;
  pid: number;
  state: 'active' | 'quarantined';
  isDefault: boolean;
  featureEnabled: boolean;
  liveLabel: string;
  metadata: {
    aliases: string[];
    harness: string | null;
    endpoint: string;
    port: number | null;
  };
}

export interface GroupParticipant {
  rappid: string;
  liveId: string;
  liveLabel: string;
  harness: string | null;
}

export interface GroupTranscriptTurn {
  schema: 'rapp-group-transcript/1.0';
  id: string;
  groupId: string;
  messageId: string;
  sequence: number;
  round: number;
  participant: GroupParticipant;
  prompt: string;
  envelope: {
    response: string;
    [key: string]: unknown;
  };
  completedAt: string;
  truncated?: boolean;
}

export interface GroupSnapshot {
  id: string;
  participants: GroupParticipant[];
  rounds: number;
  state: 'ready' | 'running' | 'completed' | 'partial' | 'cancelled' | 'bounded' | 'archived';
  createdAt: string;
  updatedAt: string;
  transcriptLength: number;
}

export interface GroupRunResult extends GroupSnapshot {
  status: 'completed' | 'partial' | 'cancelled' | 'bounded';
  transcript: GroupTranscriptTurn[];
  failures: Array<{
    participantRappid: string;
    round: number;
    message: string;
  }>;
  outputChars: number;
  boundary?: 'time' | 'output';
  persistenceError?: string;
}

export function loadPatient(): Promise<SurgeonPatientSnapshot> {
  return gateway.call<SurgeonPatientSnapshot>('surgeon.patient');
}

export function loadCases(): Promise<SurgeonCase[]> {
  return gateway.call<SurgeonCase[]>('surgeon.cases');
}

export function sendTurn(
  userInput: string,
  caseId?: string,
): Promise<SurgeonConsultResult> {
  return gateway.call<SurgeonConsultResult>('surgeon.turn', {
    userInput,
    ...(caseId ? { caseId } : {}),
  }, { timeoutMs: SURGEON_TURN_TIMEOUT_MS });
}

export async function loadSurgeonFeatures(): Promise<SurgeonFeatureSnapshot> {
  const features = await gateway.call<Record<string, boolean>>('features.get');
  return {
    brainSurgeonGroupChat: features.brainSurgeonGroupChat === true,
  };
}

export function loadGroupParticipants(): Promise<{
  participants: GroupParticipantSummary[];
}> {
  return gateway.call('participants.list');
}

export function createGroup(participants: string[]): Promise<GroupSnapshot> {
  return gateway.call<GroupSnapshot>('group.create', { participants });
}

export function sendGroupTurn(
  groupId: string,
  userInput: string,
  signal?: AbortSignal,
): Promise<GroupRunResult> {
  return gateway.call<GroupRunResult>(
    'group.send',
    { groupId, userInput },
    {
      timeoutMs: SURGEON_TURN_TIMEOUT_MS,
      signal,
      cancel: {
        method: 'group.cancel',
        params: { groupId },
      },
    },
  );
}

export function cancelGroup(groupId: string): Promise<GroupSnapshot> {
  return gateway.call<GroupSnapshot>('group.cancel', { groupId });
}

export function approveProcedure(
  caseId: string,
  procedure: SurgeonProcedure,
  confirmation?: string,
): Promise<SurgeonCase> {
  return gateway.call<SurgeonCase>('surgeon.procedure.approve', {
    caseId,
    procedureId: procedure.id,
    digest: procedure.digest,
    ...(confirmation ? { confirmation } : {}),
  }, { timeoutMs: SURGEON_TURN_TIMEOUT_MS });
}

export function rejectProcedure(
  caseId: string,
  procedure: SurgeonProcedure,
): Promise<SurgeonCase> {
  return gateway.call<SurgeonCase>('surgeon.procedure.reject', {
    caseId,
    procedureId: procedure.id,
    digest: procedure.digest,
  }, { timeoutMs: SURGEON_TURN_TIMEOUT_MS });
}

export function operate(
  caseId: string,
  procedure: SurgeonProcedure,
): Promise<SurgeonCase> {
  return gateway.call<SurgeonCase>('surgeon.procedure.operate', {
    caseId,
    procedureId: procedure.id,
    digest: procedure.digest,
  }, { timeoutMs: SURGEON_OPERATION_TIMEOUT_MS });
}
