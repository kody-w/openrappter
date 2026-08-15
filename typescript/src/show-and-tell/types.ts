export const SHOW_AND_TELL_SCHEMA = 'openrappter-show-and-tell/1.0' as const;
export const SHOW_AND_TELL_ANALYSIS_SCHEMA =
  'openrappter-show-and-tell-analysis/1.0' as const;
export const SHOW_AND_TELL_AUTOMATION_SCHEMA =
  'openrappter-automation/1.0' as const;

export type ShowAndTellState = 'recording' | 'stopping' | 'stopped' | 'failed';
export type ShowAndTellConfidence = 'high' | 'medium' | 'low';
export type ShowAndTellArtifactKind = 'skill' | 'automation';
export type ShowAndTellConsentPurpose =
  | 'start'
  | 'capture'
  | 'analyze'
  | 'approve'
  | 'delete';

export interface ShowAndTellSession {
  schema: typeof SHOW_AND_TELL_SCHEMA;
  id: string;
  state: ShowAndTellState;
  title: string;
  intentHint: string;
  captureMode: 'context';
  createdAt: number;
  startedAt: number;
  stoppedAt: number | null;
  updatedAt: number;
  collectorRuntime: 'typescript' | 'python' | null;
  collectorPid: number | null;
  collectorNonce: string | null;
  collectorStartedAt: number | null;
  collectorHeartbeatAt: number | null;
  stopRequestedAt: number | null;
  maxDurationMs: number;
  pollIntervalMs: number;
  lastError: string | null;
}

export interface ShowAndTellEvent {
  id: string;
  sessionId: string;
  sequence: number;
  timestamp: number;
  type: string;
  source: string;
  data: Record<string, unknown>;
}

export interface ShowAndTellStep {
  id: string;
  title: string;
  detail: string;
  kind: 'calculation' | 'action';
  tool: string;
  app: string;
  url: string;
  evidence: string[];
  confidence: ShowAndTellConfidence;
}

export interface ShowAndTellAnalysis {
  schema: typeof SHOW_AND_TELL_ANALYSIS_SCHEMA;
  sessionId: string;
  revision: number;
  title: string;
  intent: string;
  intentRationale: string;
  intentConfidence: ShowAndTellConfidence;
  steps: ShowAndTellStep[];
  feedbackLog: Array<{ at: number; feedback: string }>;
  approved: boolean;
  approvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ShowAndTellArtifact {
  id: string;
  sessionId: string;
  kind: ShowAndTellArtifactKind;
  name: string;
  path: string;
  contentHash: string;
  createdAt: number;
}

export interface ActiveContext {
  app: string;
  window: string;
  url?: string;
  privateContext?: boolean;
  windowId?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface CreateSessionInput {
  title?: string;
  intentHint?: string;
  maxDurationMs?: number;
  pollIntervalMs?: number;
}
