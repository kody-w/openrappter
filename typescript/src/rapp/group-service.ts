import { randomUUID } from 'node:crypto';

import type { EffectiveFeatures } from '../config/features.js';
import type { ChatEnvelope } from '../gateway/chat-envelope.js';
import type { ChatHistoryMessage } from '../gateway/chat-request.js';
import type { Session, StorageAdapter } from '../storage/types.js';
import {
  PARTICIPANT_REGISTRY_ERROR,
  ParticipantRegistryError,
  type ParticipantRegistry,
  type ParticipantRegistryRecord,
} from './participant-registry.js';

export const GROUP_ERROR = {
  EXPERIMENTAL_FEATURE_DISABLED:
    PARTICIPANT_REGISTRY_ERROR.EXPERIMENTAL_FEATURE_DISABLED,
  UNKNOWN_GROUP: 'UNKNOWN_GROUP',
  GROUP_PARTICIPANT_LIMIT: 'GROUP_PARTICIPANT_LIMIT',
  GROUP_ROUND_LIMIT: 'GROUP_ROUND_LIMIT',
  GROUP_DURATION_LIMIT: 'GROUP_DURATION_LIMIT',
  GROUP_OUTPUT_LIMIT: 'GROUP_OUTPUT_LIMIT',
  GROUP_ALREADY_RUNNING: 'GROUP_ALREADY_RUNNING',
  GROUP_PERSISTENCE_FAILED: 'GROUP_PERSISTENCE_FAILED',
} as const;

export type GroupServiceErrorCode =
  (typeof GROUP_ERROR)[keyof typeof GROUP_ERROR];

export class GroupServiceError extends Error {
  constructor(
    readonly code: GroupServiceErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'GroupServiceError';
  }
}

export interface GroupLimits {
  maxParticipants: number;
  maxRounds: number;
  maxDurationMs: number;
  maxOutputChars: number;
}

export const DEFAULT_GROUP_LIMITS: Readonly<GroupLimits> = Object.freeze({
  maxParticipants: 6,
  maxRounds: 3,
  maxDurationMs: 120_000,
  maxOutputChars: 32_000,
});

export const HARD_GROUP_LIMITS: Readonly<GroupLimits> = Object.freeze({
  maxParticipants: 12,
  maxRounds: 8,
  maxDurationMs: 300_000,
  maxOutputChars: 200_000,
});

const MAX_CONVERSATION_HISTORY_MESSAGES = 40;
const GROUP_TRANSCRIPT_SCHEMA = 'rapp-group-transcript/1.0' as const;

export interface GroupParticipant {
  rappid: string;
  liveId: string;
  liveLabel: string;
  harness: string | null;
}

export interface GroupTranscriptEnvelope {
  schema: typeof GROUP_TRANSCRIPT_SCHEMA;
  id: string;
  groupId: string;
  messageId: string;
  sequence: number;
  round: number;
  participant: GroupParticipant;
  prompt: string;
  envelope: ChatEnvelope;
  completedAt: string;
  truncated?: boolean;
}

export type GroupState =
  | 'ready'
  | 'running'
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'bounded'
  | 'archived';

export interface GroupSnapshot {
  id: string;
  participants: GroupParticipant[];
  rounds: number;
  state: GroupState;
  createdAt: string;
  updatedAt: string;
  transcriptLength: number;
}

export interface GroupCreateRequest {
  participants: string[];
  rounds?: number;
}

export interface GroupSendRequest {
  groupId: string;
  userInput: string;
  rounds?: number;
}

export interface GroupFailure {
  participantRappid: string;
  round: number;
  message: string;
}

export type GroupBoundary = 'time' | 'output';

export interface GroupRunResult extends GroupSnapshot {
  status: 'completed' | 'partial' | 'cancelled' | 'bounded';
  transcript: GroupTranscriptEnvelope[];
  failures: GroupFailure[];
  outputChars: number;
  boundary?: GroupBoundary;
  persistenceError?: string;
}

export interface GroupHistory {
  groupId: string;
  state: GroupState;
  transcript: GroupTranscriptEnvelope[];
}

export interface GroupServiceOptions {
  registry: ParticipantRegistry;
  storage?: Pick<StorageAdapter, 'getSession' | 'saveSession'>;
  limits?: Partial<GroupLimits>;
  idFactory?: () => string;
  now?: () => Date;
}

interface GroupRecord {
  id: string;
  participants: GroupParticipant[];
  rounds: number;
  state: GroupState;
  createdAt: string;
  updatedAt: string;
  transcript: GroupTranscriptEnvelope[];
  contextHistory: ChatHistoryMessage[];
}

interface ActiveGroupRun {
  controller: AbortController;
  boundary?: GroupBoundary;
}

function positiveInteger(
  value: number,
  hardMaximum: number,
  code: GroupServiceErrorCode,
  label: string,
): number {
  if (!Number.isInteger(value) || value <= 0 || value > hardMaximum) {
    throw new GroupServiceError(
      code,
      `${label} must be an integer between 1 and ${hardMaximum}.`,
    );
  }
  return value;
}

function cloneEnvelope<T>(value: T): T {
  return structuredClone(value);
}

function participantFromRecord(record: ParticipantRegistryRecord): GroupParticipant {
  return {
    rappid: record.rappid,
    liveId: record.liveId,
    liveLabel: record.liveLabel,
    harness: record.metadata.harness,
  };
}

function attributedTurn(turn: GroupTranscriptEnvelope): ChatHistoryMessage {
  return {
    role: 'assistant',
    content: `[${turn.participant.liveLabel} | ${turn.participant.rappid}]\n`
      + turn.envelope.response,
  };
}

function isTranscriptEnvelope(value: unknown): value is GroupTranscriptEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<GroupTranscriptEnvelope>;
  return candidate.schema === GROUP_TRANSCRIPT_SCHEMA
    && typeof candidate.id === 'string'
    && typeof candidate.groupId === 'string'
    && typeof candidate.messageId === 'string'
    && Number.isInteger(candidate.sequence)
    && Number.isInteger(candidate.round)
    && typeof candidate.prompt === 'string'
    && typeof candidate.completedAt === 'string'
    && candidate.participant !== null
    && typeof candidate.participant === 'object'
    && typeof candidate.participant.rappid === 'string'
    && candidate.envelope !== null
    && typeof candidate.envelope === 'object'
    && typeof candidate.envelope.response === 'string';
}

function contextFromTranscript(
  transcript: readonly GroupTranscriptEnvelope[],
): ChatHistoryMessage[] {
  const history: ChatHistoryMessage[] = [];
  let messageId: string | undefined;
  for (const turn of transcript) {
    if (turn.messageId !== messageId) {
      history.push({ role: 'user', content: turn.prompt });
      messageId = turn.messageId;
    }
    history.push(attributedTurn(turn));
  }
  return history.slice(-MAX_CONVERSATION_HISTORY_MESSAGES);
}

export class GroupService {
  private readonly registry: ParticipantRegistry;
  private readonly storage?: Pick<StorageAdapter, 'getSession' | 'saveSession'>;
  private readonly limits: GroupLimits;
  private readonly idFactory: () => string;
  private readonly now: () => Date;
  private readonly groups = new Map<string, GroupRecord>();
  private readonly activeRuns = new Map<string, ActiveGroupRun>();

  constructor(options: GroupServiceOptions) {
    this.registry = options.registry;
    this.storage = options.storage;
    this.idFactory = options.idFactory ?? (() => `group-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
    this.limits = {
      maxParticipants: positiveInteger(
        options.limits?.maxParticipants ?? DEFAULT_GROUP_LIMITS.maxParticipants,
        HARD_GROUP_LIMITS.maxParticipants,
        GROUP_ERROR.GROUP_PARTICIPANT_LIMIT,
        'maxParticipants',
      ),
      maxRounds: positiveInteger(
        options.limits?.maxRounds ?? DEFAULT_GROUP_LIMITS.maxRounds,
        HARD_GROUP_LIMITS.maxRounds,
        GROUP_ERROR.GROUP_ROUND_LIMIT,
        'maxRounds',
      ),
      maxDurationMs: positiveInteger(
        options.limits?.maxDurationMs ?? DEFAULT_GROUP_LIMITS.maxDurationMs,
        HARD_GROUP_LIMITS.maxDurationMs,
        GROUP_ERROR.GROUP_DURATION_LIMIT,
        'maxDurationMs',
      ),
      maxOutputChars: positiveInteger(
        options.limits?.maxOutputChars ?? DEFAULT_GROUP_LIMITS.maxOutputChars,
        HARD_GROUP_LIMITS.maxOutputChars,
        GROUP_ERROR.GROUP_OUTPUT_LIMIT,
        'maxOutputChars',
      ),
    };
  }

  create(
    request: GroupCreateRequest,
    features: EffectiveFeatures,
  ): GroupSnapshot {
    if (!Array.isArray(request.participants)) {
      throw new GroupServiceError(
        GROUP_ERROR.GROUP_PARTICIPANT_LIMIT,
        'participants must be an array of admitted RAPPIDs or aliases.',
      );
    }
    if (
      request.participants.length < 2
      || request.participants.length > this.limits.maxParticipants
    ) {
      throw new GroupServiceError(
        GROUP_ERROR.GROUP_PARTICIPANT_LIMIT,
        `A group requires 2-${this.limits.maxParticipants} participants.`,
      );
    }

    const resolved = request.participants.map(reference =>
      this.registry.resolveExplicit(reference, features));
    this.assertFeatureEnabled(features);
    const rappids = resolved.map(participant => participant.rappid!);
    if (new Set(rappids).size !== rappids.length) {
      throw new GroupServiceError(
        GROUP_ERROR.GROUP_PARTICIPANT_LIMIT,
        'A participant may appear only once in a group.',
      );
    }
    const rounds = this.validateRounds(request.rounds ?? 1);
    const participants = rappids.map(rappid => {
      const record = this.registry.get(rappid);
      if (!record) {
        throw new ParticipantRegistryError(
          PARTICIPANT_REGISTRY_ERROR.UNKNOWN_PARTICIPANT,
          `${rappid} is no longer admitted.`,
        );
      }
      return participantFromRecord(record);
    });
    const timestamp = this.now().toISOString();
    const group: GroupRecord = {
      id: this.uniqueGroupId(),
      participants,
      rounds,
      state: 'ready',
      createdAt: timestamp,
      updatedAt: timestamp,
      transcript: [],
      contextHistory: [],
    };
    this.groups.set(group.id, group);
    return this.snapshot(group);
  }

  async send(
    request: GroupSendRequest,
    features: EffectiveFeatures,
    signal?: AbortSignal,
  ): Promise<GroupRunResult> {
    this.assertFeatureEnabled(features);
    const group = this.groups.get(request.groupId);
    if (!group) {
      throw new GroupServiceError(
        GROUP_ERROR.UNKNOWN_GROUP,
        `Group ${JSON.stringify(request.groupId)} is not active. Create it before sending.`,
      );
    }
    if (this.activeRuns.has(group.id)) {
      throw new GroupServiceError(
        GROUP_ERROR.GROUP_ALREADY_RUNNING,
        `${group.id} already has an active turn.`,
      );
    }
    const userInput = request.userInput?.trim();
    if (!userInput) {
      throw new GroupServiceError(
        GROUP_ERROR.GROUP_OUTPUT_LIMIT,
        'group.send requires a non-empty userInput.',
      );
    }
    const rounds = this.validateRounds(request.rounds ?? group.rounds);
    const active: ActiveGroupRun = { controller: new AbortController() };
    this.activeRuns.set(group.id, active);
    const onExternalAbort = (): void => active.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (signal?.aborted) active.controller.abort(signal.reason);
    const timer = setTimeout(() => {
      active.boundary = 'time';
      active.controller.abort(new Error('Group duration bound reached.'));
    }, this.limits.maxDurationMs);

    const failures: GroupFailure[] = [];
    let persistenceError: string | undefined;
    const messageId = `message-${randomUUID()}`;
    let outputChars = 0;
    const priorContext = [...group.contextHistory];
    let workingHistory = [...priorContext];
    group.state = 'running';
    group.updatedAt = this.now().toISOString();

    groupRun:
    try {
      for (let round = 1; round <= rounds; round++) {
        for (const groupParticipant of group.participants) {
          if (active.controller.signal.aborted) break groupRun;
          try {
            const envelope = await this.registry.chat(
              groupParticipant.rappid,
              {
                userInput,
                conversationHistory: workingHistory.slice(
                  -MAX_CONVERSATION_HISTORY_MESSAGES,
                ),
                sessionId: `${group.id}:${groupParticipant.rappid}`,
                idempotencyKey: `${group.id}:${messageId}:${round}:${groupParticipant.rappid}`,
              },
              features,
              active.controller.signal,
            );
            if (active.controller.signal.aborted) break groupRun;

            const remaining = this.limits.maxOutputChars - outputChars;
            const response = envelope.response;
            const truncated = response.length > remaining;
            const retained = truncated ? response.slice(0, Math.max(0, remaining)) : response;
            const boundedEnvelope: ChatEnvelope = truncated
              ? {
                  ...envelope,
                  response: retained,
                  content: retained,
                  group_truncated: true,
                }
              : envelope;
            const turn: GroupTranscriptEnvelope = {
              schema: GROUP_TRANSCRIPT_SCHEMA,
              id: `group-turn-${randomUUID()}`,
              groupId: group.id,
              messageId,
              sequence: group.transcript.length + 1,
              round,
              participant: cloneEnvelope(groupParticipant),
              prompt: userInput,
              envelope: cloneEnvelope(boundedEnvelope),
              completedAt: this.now().toISOString(),
              ...(truncated ? { truncated: true } : {}),
            };
            group.transcript.push(turn);
            workingHistory = [...workingHistory, attributedTurn(turn)]
              .slice(-MAX_CONVERSATION_HISTORY_MESSAGES);
            outputChars += retained.length;
            group.updatedAt = turn.completedAt;
            await this.persist(group);

            if (truncated || outputChars >= this.limits.maxOutputChars) {
              active.boundary = 'output';
              break groupRun;
            }
          } catch (error) {
            if (active.controller.signal.aborted) break groupRun;
            if (
              error instanceof GroupServiceError
              && error.code === GROUP_ERROR.GROUP_PERSISTENCE_FAILED
            ) {
              persistenceError = error.message;
              break groupRun;
            }
            failures.push({
              participantRappid: groupParticipant.rappid,
              round,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
      this.activeRuns.delete(group.id);
    }

    const currentTurns = group.transcript.filter(turn => turn.messageId === messageId);
    if (currentTurns.length > 0) {
      const userTurn: ChatHistoryMessage = { role: 'user', content: userInput };
      group.contextHistory = [
        ...priorContext,
        userTurn,
        ...currentTurns.map(attributedTurn),
      ].slice(-MAX_CONVERSATION_HISTORY_MESSAGES);
    }

    const status = active.boundary
      ? 'bounded'
      : active.controller.signal.aborted
        ? 'cancelled'
        : failures.length > 0 || persistenceError
          ? 'partial'
          : 'completed';
    group.state = status;
    group.updatedAt = this.now().toISOString();
    return {
      ...this.snapshot(group),
      status,
      transcript: cloneEnvelope(group.transcript),
      failures,
      outputChars,
      ...(active.boundary ? { boundary: active.boundary } : {}),
      ...(persistenceError ? { persistenceError } : {}),
    };
  }

  cancel(groupId: string): GroupSnapshot {
    const group = this.groups.get(groupId);
    if (!group) {
      throw new GroupServiceError(
        GROUP_ERROR.UNKNOWN_GROUP,
        `Group ${JSON.stringify(groupId)} is not active.`,
      );
    }
    group.state = 'cancelled';
    group.updatedAt = this.now().toISOString();
    this.activeRuns.get(groupId)?.controller.abort(new Error('Group cancelled.'));
    return this.snapshot(group);
  }

  async history(groupId: string): Promise<GroupHistory> {
    const group = this.groups.get(groupId);
    if (group) {
      return {
        groupId,
        state: group.state,
        transcript: cloneEnvelope(group.transcript),
      };
    }
    const transcript = await this.loadPersisted(groupId);
    if (transcript.length === 0) {
      throw new GroupServiceError(
        GROUP_ERROR.UNKNOWN_GROUP,
        `No active or persisted group exists for ${JSON.stringify(groupId)}.`,
      );
    }
    return {
      groupId,
      state: 'archived',
      transcript,
    };
  }

  private assertFeatureEnabled(features: EffectiveFeatures): void {
    if (features.brainSurgeonGroupChat !== true) {
      throw new GroupServiceError(
        GROUP_ERROR.EXPERIMENTAL_FEATURE_DISABLED,
        'Brain Surgeon group chat is disabled.',
      );
    }
  }

  private validateRounds(rounds: number): number {
    if (!Number.isInteger(rounds) || rounds <= 0 || rounds > this.limits.maxRounds) {
      throw new GroupServiceError(
        GROUP_ERROR.GROUP_ROUND_LIMIT,
        `rounds must be an integer between 1 and ${this.limits.maxRounds}.`,
      );
    }
    return rounds;
  }

  private uniqueGroupId(): string {
    const candidate = this.idFactory();
    if (!candidate.trim() || this.groups.has(candidate)) {
      throw new GroupServiceError(
        GROUP_ERROR.UNKNOWN_GROUP,
        'The group ID factory returned an empty or duplicate ID.',
      );
    }
    return candidate;
  }

  private snapshot(group: GroupRecord): GroupSnapshot {
    return {
      id: group.id,
      participants: cloneEnvelope(group.participants),
      rounds: group.rounds,
      state: group.state,
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
      transcriptLength: group.transcript.length,
    };
  }

  private async persist(group: GroupRecord): Promise<void> {
    if (!this.storage) return;
    const session: Session = {
      id: `rapp-group:${group.id}`,
      channelId: 'rapp-group',
      conversationId: group.id,
      agentId: 'rapp-group',
      metadata: {
        schema: GROUP_TRANSCRIPT_SCHEMA,
      },
      messages: group.transcript.map(turn => ({
        id: turn.id,
        role: 'assistant',
        content: JSON.stringify(turn),
        timestamp: turn.completedAt,
      })),
      createdAt: group.createdAt,
      updatedAt: group.updatedAt,
    };
    try {
      await this.storage.saveSession(session);
    } catch (error) {
      throw new GroupServiceError(
        GROUP_ERROR.GROUP_PERSISTENCE_FAILED,
        `Completed group envelopes could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async loadPersisted(groupId: string): Promise<GroupTranscriptEnvelope[]> {
    if (!this.storage) return [];
    const session = await this.storage.getSession(`rapp-group:${groupId}`);
    if (!session || session.metadata.schema !== GROUP_TRANSCRIPT_SCHEMA) return [];
    return session.messages
      .map(message => {
        try {
          const parsed = JSON.parse(message.content) as unknown;
          return isTranscriptEnvelope(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((turn): turn is GroupTranscriptEnvelope => turn !== undefined)
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneEnvelope);
  }
}

export function restoreGroupContext(
  transcript: readonly GroupTranscriptEnvelope[],
): ChatHistoryMessage[] {
  return contextFromTranscript(transcript);
}
