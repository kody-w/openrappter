export type SurgeonPatientState = 'stable' | 'degraded' | 'critical' | 'dormant';

export interface SurgeonPatientTissue {
  id: string;
  label: string;
  status: SurgeonPatientState;
  summary: string;
  value?: number;
}

export interface SurgeonPatientSnapshot {
  capturedAt: string;
  patient: 'OpenRappter';
  version: string;
  state: SurgeonPatientState;
  uptimeSeconds: number;
  tissues: SurgeonPatientTissue[];
  inventory: {
    agents: string[];
    channels: string[];
    scheduledJobs: string[];
  };
  metrics: {
    connections: number;
    agents: number;
    configuredChannels: number;
    connectedChannels: number;
    scheduledJobs: number;
    activeCases: number;
  };
}

export type SurgeonSeverity = 'stable' | 'notice' | 'warning' | 'critical';
export type SurgeonRisk = 'low' | 'medium' | 'high';
export type SurgeonTurnKind = 'consultation' | 'proposal' | 'error';

export interface SurgeonOption {
  label: string;
  value: string;
}

export interface SurgeonDiagnosis {
  summary: string;
  severity: SurgeonSeverity;
  findings: string[];
}

export type SurgeonProcedureStatus =
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'operating'
  | 'verifying'
  | 'recovered'
  | 'needs_attention'
  | 'failed';

export interface SurgeonProcedure {
  id: string;
  digest: string;
  patientDigest: string;
  title: string;
  summary: string;
  risk: SurgeonRisk;
  steps: string[];
  expectedOutcome: string;
  verification: string[];
  status: SurgeonProcedureStatus;
  proposedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
  completedAt?: string;
}

export interface SurgeonTurn {
  id: string;
  kind: SurgeonTurnKind;
  response: string;
  voiceLine: string;
  prompt: string;
  options: SurgeonOption[];
  diagnosis?: SurgeonDiagnosis;
  procedure?: SurgeonProcedure;
  createdAt: string;
}

export interface SurgeonCaseTurn {
  userInput: string;
  turn: SurgeonTurn;
  createdAt: string;
}

export type SurgeonOutcomeStatus = 'recovered' | 'needs_attention' | 'failed';

export interface SurgeonOutcome {
  status: SurgeonOutcomeStatus;
  summary: string;
  evidence: string[];
  completedAt: string;
  patientAfter?: SurgeonPatientSnapshot;
}

export type SurgeonCaseStatus =
  | 'observing'
  | 'proposed'
  | 'approved'
  | 'rejected'
  | 'operating'
  | 'verifying'
  | 'recovered'
  | 'needs_attention'
  | 'failed';

export interface SurgeonCase {
  id: string;
  status: SurgeonCaseStatus;
  createdAt: string;
  updatedAt: string;
  patientAtDiagnosis: SurgeonPatientSnapshot;
  turns: SurgeonCaseTurn[];
  procedure?: SurgeonProcedure;
  outcome?: SurgeonOutcome;
}

export interface SurgeonConsultRequest {
  caseId?: string;
  userInput: string;
}

export interface SurgeonConsultResult {
  case: SurgeonCase;
  turn: SurgeonTurn;
  patient: SurgeonPatientSnapshot;
}

export interface SurgeonProcedureApproval {
  caseId: string;
  procedureId: string;
  digest: string;
  confirmation?: string;
}

export interface SurgeonProcedureExecutionEvidence {
  summary: string;
  agentLogs: string[];
}

export interface SurgeonProcedureExecutionRequest {
  case: SurgeonCase;
  procedure: SurgeonProcedure;
  patientBefore: SurgeonPatientSnapshot;
  executionPrompt: string;
}
