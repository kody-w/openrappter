import type { SensitiveFinding } from './privacy.js';

export const SHOW_AND_TELL_SCHEMA = 'openrappter-show-and-tell/1.0' as const;
export const SHOW_AND_TELL_ANALYSIS_SCHEMA =
  'openrappter-show-and-tell-analysis/1.0' as const;
export const SHOW_AND_TELL_AUTOMATION_SCHEMA =
  'openrappter-automation/1.0' as const;
export const SHOW_AND_TELL_BUNDLE_SCHEMA =
  'openrappter-show-and-tell-bundle/1.0' as const;
export const SHOW_AND_TELL_PLAN_SCHEMA =
  'openrappter-show-and-tell-plan/1.0' as const;
export const SHOW_AND_TELL_MARKETPLACE_SCHEMA =
  'openrappter-skill-marketplace/1.0' as const;

export type ShowAndTellState = 'recording' | 'stopping' | 'stopped' | 'failed';
export type ShowAndTellConfidence = 'high' | 'medium' | 'low';
export type ShowAndTellArtifactKind = 'skill' | 'automation' | 'marketplace';
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
  /** Wall-clock milliseconds. Recognisable to a human, but it can jump. */
  timestamp: number;
  /**
   * Milliseconds since the session started, advanced by a monotonic clock.
   * `null` only for rows written before this column existed; readers must say
   * so rather than pretending a wall-clock difference is monotonic evidence.
   */
  elapsedMs: number | null;
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

/** One value the demonstration happened to use, lifted out of the steps. */
export type ShowAndTellValueKind =
  | 'url'
  | 'email'
  | 'path'
  | 'date'
  | 'amount'
  | 'identifier'
  | 'text'
  | 'number';

export interface ShowAndTellValue {
  /** Placeholder id used as `{{id}}` inside step templates. */
  id: string;
  kind: ShowAndTellValueKind;
  label: string;
  /** The literal observed once, after privacy masking. */
  example: string;
  /** True when the observed literal was sensitive and was masked away. */
  exampleMasked: boolean;
  required: boolean;
  /** `step:<stepId>:<field>` references, in first-appearance order. */
  occurrences: string[];
}

export type ShowAndTellRiskCategory =
  | 'destructive'
  | 'financial'
  | 'publishing'
  | 'messaging'
  | 'credential';

export interface ShowAndTellPlanStep {
  id: string;
  /** Templated: concrete literals are replaced by `{{value}}` references. */
  title: string;
  detail: string;
  kind: 'calculation' | 'action';
  tool: string;
  app: string;
  url: string;
  evidence: string[];
  confidence: ShowAndTellConfidence;
  /** Value ids this step substitutes. */
  values: string[];
  requiresConfirmation: boolean;
  riskCategories: ShowAndTellRiskCategory[];
}

export interface ShowAndTellPlanPrivacy {
  findings: SensitiveFinding[];
  masked: boolean;
  /** OpenRappter never sends raw frames to a model. This records that. */
  rawFramesShared: false;
}

/**
 * The reviewable proposal between analysis and building.
 *
 * An analysis says what happened. A plan says what would be built, which
 * values are editable, what it refuses to do without confirmation, and what
 * the recording could not explain. Nothing is built from it until `approved`.
 */
export interface ShowAndTellSkillPlan {
  schema: typeof SHOW_AND_TELL_PLAN_SCHEMA;
  sessionId: string;
  analysisRevision: number;
  revision: number;
  title: string;
  intent: string;
  useWhen: string[];
  useFor: string[];
  doNotUseWhen: string[];
  steps: ShowAndTellPlanStep[];
  values: ShowAndTellValue[];
  evidenceStats: ShowAndTellBundleStats;
  openQuestions: string[];
  privacy: ShowAndTellPlanPrivacy;
  feedbackLog: Array<{ at: number; feedback: string }>;
  approved: boolean;
  approvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type ShowAndTellSegmentKind = 'work' | 'detour';

export interface ShowAndTellSegment {
  index: number;
  kind: ShowAndTellSegmentKind;
  app: string;
  url: string;
  startSequence: number;
  endSequence: number;
  startElapsedMs: number;
  endElapsedMs: number;
  eventCount: number;
  narrated: boolean;
  observed: boolean;
  frameCount: number;
  unexplainedFrames: number;
  silentEvents: number;
  evidence: string[];
  reason: string;
}

export interface ShowAndTellBundleStats {
  eventCount: number;
  /** Events that describe the demonstration, excluding collector lifecycle. */
  meaningfulEventCount: number;
  segmentCount: number;
  narratedSegments: number;
  silentSegments: number;
  detourSegments: number;
  silentEvents: number;
  unexplainedFrames: number;
  /** Events whose elapsed time was derived from wall-clock, not monotonic. */
  estimatedElapsedEvents: number;
  longestGapMs: number;
  durationMs: number;
  /** Explained events per thousand meaningful events. Integer, no floats. */
  explainedRatioMilli: number;
}

export interface ShowAndTellSessionBundle {
  schema: typeof SHOW_AND_TELL_BUNDLE_SCHEMA;
  sessionId: string;
  segments: ShowAndTellSegment[];
  stats: ShowAndTellBundleStats;
  /** Plain statements of what the recording could not account for. */
  warnings: string[];
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
