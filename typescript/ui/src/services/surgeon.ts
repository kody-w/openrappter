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
