import type {
  EffectiveFeatures,
  PromotableFeature,
} from '../config/features.js';
import type { ChatEnvelope } from '../gateway/chat-envelope.js';
import { isRappid } from '../rappids/identity.js';
import {
  RappParticipantIdentityDriftError,
  type RappParticipant,
  type RappParticipantChatRequest,
  type RappParticipantDescriptor,
  type RappParticipantStatus,
} from './participant.js';

export const PARTICIPANT_REGISTRY_ERROR = {
  UNKNOWN_PARTICIPANT: 'UNKNOWN_PARTICIPANT',
  EXPERIMENTAL_FEATURE_DISABLED: 'EXPERIMENTAL_FEATURE_DISABLED',
  PARTICIPANT_IDENTITY_REQUIRED: 'PARTICIPANT_IDENTITY_REQUIRED',
  PARTICIPANT_REPLACEMENT_REQUIRED: 'PARTICIPANT_REPLACEMENT_REQUIRED',
  PARTICIPANT_LIVE_ID_CONFLICT: 'PARTICIPANT_LIVE_ID_CONFLICT',
  PARTICIPANT_ALIAS_CONFLICT: 'PARTICIPANT_ALIAS_CONFLICT',
  PARTICIPANT_QUARANTINED: 'PARTICIPANT_QUARANTINED',
  PARTICIPANT_UNAVAILABLE: 'PARTICIPANT_UNAVAILABLE',
} as const;

export type ParticipantRegistryErrorCode =
  (typeof PARTICIPANT_REGISTRY_ERROR)[keyof typeof PARTICIPANT_REGISTRY_ERROR];

export class ParticipantRegistryError extends Error {
  constructor(
    readonly code: ParticipantRegistryErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'ParticipantRegistryError';
  }
}

export type ParticipantFeatureGate =
  Exclude<PromotableFeature, 'brainSurgeonGroupChat'>;

export interface ParticipantRegistrationOptions {
  aliases?: readonly string[];
  feature?: ParticipantFeatureGate;
  replace?: boolean;
}

export interface ParticipantRegistryOptions {
  configuredDefault?: string | null;
  brainstemFallback?: RappParticipant;
  localFallback?: RappParticipant;
}

export type ParticipantRegistryState = 'active' | 'quarantined';

export interface ParticipantMetadata {
  aliases: string[];
  harness: string | null;
  endpoint: string;
  port: number | null;
}

export interface ParticipantRegistryRecord {
  rappid: string;
  liveId: string;
  pid: number;
  feature?: ParticipantFeatureGate;
  state: ParticipantRegistryState;
  quarantineReason?: string;
  isDefault: boolean;
  featureEnabled: boolean;
  liveLabel: string;
  metadata: ParticipantMetadata;
}

export interface ResolvedParticipant {
  participant: RappParticipant;
  rappid: string | null;
  liveId: string | null;
  source: 'explicit' | 'configured-default' | 'brainstem' | 'local';
}

interface ParticipantEntry {
  participant: RappParticipant;
  descriptor: Readonly<RappParticipantDescriptor>;
  rappid: string;
  liveId: string;
  pid: number;
  aliases: Set<string>;
  feature?: ParticipantFeatureGate;
  state: ParticipantRegistryState;
  quarantineReason?: string;
}

const normalizeAlias = (value: string): string => value.trim().toLowerCase();

function descriptorPort(descriptor: RappParticipantDescriptor): number | null {
  try {
    const parsed = new URL(descriptor.endpoint);
    if (parsed.port) return Number(parsed.port);
    if (parsed.protocol === 'http:') return 80;
    if (parsed.protocol === 'https:') return 443;
  } catch {
    // The participant contract validates endpoints. A malformed test double is
    // metadata-only here and must not become a registry identity.
  }
  return null;
}

export function participantLiveLabel(
  descriptor: Pick<RappParticipantDescriptor, 'liveId' | 'harness'>,
): string {
  const harness = descriptor.harness?.name ?? 'RAPP';
  return `${descriptor.liveId ?? 'unbound'} · ${harness}`;
}

function requireActiveIdentity(
  descriptor: Readonly<RappParticipantDescriptor>,
): { rappid: string; liveId: string; pid: number } {
  if (
    descriptor.rappid === null
    || !isRappid(descriptor.rappid)
    || descriptor.liveId === null
    || !/^rapp-\d+-[a-z0-9]+$/i.test(descriptor.liveId)
    || descriptor.pid === null
    || !Number.isSafeInteger(descriptor.pid)
    || descriptor.pid <= 0
  ) {
    throw new ParticipantRegistryError(
      PARTICIPANT_REGISTRY_ERROR.PARTICIPANT_IDENTITY_REQUIRED,
      'Admission requires a stable RAPPID and a live rapp-<PID>-<suffix> binding.',
    );
  }
  const livePid = Number(/^rapp-(\d+)-/.exec(descriptor.liveId)?.[1]);
  if (livePid !== descriptor.pid) {
    throw new ParticipantRegistryError(
      PARTICIPANT_REGISTRY_ERROR.PARTICIPANT_IDENTITY_REQUIRED,
      'The participant liveId must contain its published PID.',
    );
  }
  return {
    rappid: descriptor.rappid,
    liveId: descriptor.liveId,
    pid: descriptor.pid,
  };
}

export class ParticipantRegistry {
  private readonly participants = new Map<string, ParticipantEntry>();
  private readonly activeByLiveId = new Map<string, string>();
  private readonly aliases = new Map<string, string>();
  private configuredDefault: string | null;
  private readonly brainstemFallback?: RappParticipant;
  private readonly localFallback?: RappParticipant;

  constructor(options: ParticipantRegistryOptions = {}) {
    this.configuredDefault = options.configuredDefault?.trim() || null;
    this.brainstemFallback = options.brainstemFallback;
    this.localFallback = options.localFallback;
  }

  async register(
    participant: RappParticipant,
    options: ParticipantRegistrationOptions = {},
  ): Promise<ParticipantRegistryRecord> {
    const status = await participant.status();
    const identity = requireActiveIdentity(status.descriptor);
    const existing = this.participants.get(identity.rappid);

    if (existing && existing.liveId !== identity.liveId && options.replace !== true) {
      throw new ParticipantRegistryError(
        PARTICIPANT_REGISTRY_ERROR.PARTICIPANT_REPLACEMENT_REQUIRED,
        `${identity.rappid} is already active as ${existing.liveId}; replace it explicitly.`,
      );
    }

    const liveOwner = this.activeByLiveId.get(identity.liveId);
    if (liveOwner && liveOwner !== identity.rappid) {
      const owner = this.participants.get(liveOwner);
      if (owner) {
        this.quarantine(
          owner,
          `Live identity ${identity.liveId} was also claimed by ${identity.rappid}.`,
        );
      }
      throw new ParticipantRegistryError(
        PARTICIPANT_REGISTRY_ERROR.PARTICIPANT_LIVE_ID_CONFLICT,
        `${identity.liveId} is already bound to ${liveOwner}.`,
      );
    }

    const nextAliases = new Set(
      (options.aliases ?? (existing ? [...existing.aliases] : []))
        .map(normalizeAlias)
        .filter(Boolean),
    );
    for (const alias of nextAliases) {
      const owner = this.aliases.get(alias);
      if (owner && owner !== identity.rappid) {
        throw new ParticipantRegistryError(
          PARTICIPANT_REGISTRY_ERROR.PARTICIPANT_ALIAS_CONFLICT,
          `Alias ${JSON.stringify(alias)} is already assigned to ${owner}.`,
        );
      }
    }

    if (existing) {
      this.removeBindings(existing);
    }
    const entry: ParticipantEntry = {
      participant,
      descriptor: status.descriptor,
      ...identity,
      aliases: nextAliases,
      feature: options.feature ?? existing?.feature,
      state: 'active',
    };
    this.participants.set(entry.rappid, entry);
    this.activeByLiveId.set(entry.liveId, entry.rappid);
    for (const alias of entry.aliases) this.aliases.set(alias, entry.rappid);
    return this.toRecord(entry, undefined);
  }

  admit(
    participant: RappParticipant,
    options: ParticipantRegistrationOptions = {},
  ): Promise<ParticipantRegistryRecord> {
    return this.register(participant, options);
  }

  replace(
    participant: RappParticipant,
    options: Omit<ParticipantRegistrationOptions, 'replace'> = {},
  ): Promise<ParticipantRegistryRecord> {
    return this.register(participant, { ...options, replace: true });
  }

  setConfiguredDefault(reference: string | null): void {
    this.configuredDefault = reference?.trim() || null;
  }

  get(reference: string): ParticipantRegistryRecord | undefined {
    const entry = this.lookup(reference);
    return entry ? this.toRecord(entry, undefined) : undefined;
  }

  getByLiveId(liveId: string): ParticipantRegistryRecord | undefined {
    const rappid = this.activeByLiveId.get(liveId);
    const entry = rappid ? this.participants.get(rappid) : undefined;
    return entry ? this.toRecord(entry, undefined) : undefined;
  }

  list(features?: EffectiveFeatures): ParticipantRegistryRecord[] {
    return [...this.participants.values()]
      .map(entry => this.toRecord(entry, features))
      .sort((left, right) => left.rappid.localeCompare(right.rappid));
  }

  has(reference: string): boolean {
    return this.lookup(reference) !== undefined;
  }

  resolveExplicit(
    reference: string,
    features: EffectiveFeatures,
  ): ResolvedParticipant {
    const entry = this.lookup(reference);
    if (!entry) {
      throw new ParticipantRegistryError(
        PARTICIPANT_REGISTRY_ERROR.UNKNOWN_PARTICIPANT,
        `${JSON.stringify(reference)} is not an admitted RAPPID or alias.`,
      );
    }
    this.assertAvailable(entry, features);
    return {
      participant: entry.participant,
      rappid: entry.rappid,
      liveId: entry.liveId,
      source: 'explicit',
    };
  }

  async resolveDefault(
    features: EffectiveFeatures,
    signal?: AbortSignal,
  ): Promise<ResolvedParticipant> {
    if (this.configuredDefault) {
      const configured = this.lookup(this.configuredDefault);
      if (configured) {
        this.assertAvailable(configured, features);
        return {
          participant: configured.participant,
          rappid: configured.rappid,
          liveId: configured.liveId,
          source: 'configured-default',
        };
      }
    }

    const attempts: string[] = [];
    const brainstem = await this.tryFallback(
      this.brainstemFallback,
      'Brainstem',
      'brainstem',
      attempts,
      signal,
    );
    if (brainstem) return brainstem;
    const local = await this.tryFallback(
      this.localFallback,
      'local OpenRappter',
      'local',
      attempts,
      signal,
    );
    if (local) return local;

    throw new ParticipantRegistryError(
      PARTICIPANT_REGISTRY_ERROR.PARTICIPANT_UNAVAILABLE,
      `No default participant is available. Start Brainstem, admit and configure a default RAPPID, `
        + `or make the local OpenRappter endpoint reachable.${attempts.length > 0
          ? ` Checks: ${attempts.join('; ')}.`
          : ''}`,
    );
  }

  async resolve(
    reference: string | undefined,
    features: EffectiveFeatures,
    signal?: AbortSignal,
  ): Promise<ResolvedParticipant> {
    return reference?.trim()
      ? this.resolveExplicit(reference, features)
      : this.resolveDefault(features, signal);
  }

  async status(
    reference: string,
    features: EffectiveFeatures,
    signal?: AbortSignal,
  ): Promise<RappParticipantStatus> {
    const resolved = this.resolveExplicit(reference, features);
    const entry = this.participants.get(resolved.rappid!);
    if (!entry) {
      throw new ParticipantRegistryError(
        PARTICIPANT_REGISTRY_ERROR.UNKNOWN_PARTICIPANT,
        `${JSON.stringify(reference)} is no longer admitted.`,
      );
    }
    try {
      const status = await entry.participant.status(signal);
      this.assertObservedIdentity(entry, status.descriptor, 'health');
      entry.descriptor = status.descriptor;
      return status;
    } catch (error) {
      if (error instanceof RappParticipantIdentityDriftError) {
        this.quarantine(entry, error.message);
      }
      throw error;
    }
  }

  async chat(
    reference: string,
    request: RappParticipantChatRequest,
    features: EffectiveFeatures,
    signal?: AbortSignal,
  ): Promise<ChatEnvelope> {
    const resolved = this.resolveExplicit(reference, features);
    const entry = this.participants.get(resolved.rappid!);
    if (!entry) {
      throw new ParticipantRegistryError(
        PARTICIPANT_REGISTRY_ERROR.UNKNOWN_PARTICIPANT,
        `${JSON.stringify(reference)} is no longer admitted.`,
      );
    }
    try {
      this.assertObservedIdentity(entry, entry.participant.descriptor, 'chat');
      const envelope = await entry.participant.chat(request, signal);
      this.assertEnvelopeIdentity(entry, envelope);
      this.assertObservedIdentity(entry, entry.participant.descriptor, 'chat');
      entry.descriptor = entry.participant.descriptor;
      return envelope;
    } catch (error) {
      if (error instanceof RappParticipantIdentityDriftError) {
        this.quarantine(entry, error.message);
      }
      throw error;
    }
  }

  private lookup(reference: string): ParticipantEntry | undefined {
    const value = reference.trim();
    if (!value) return undefined;
    const direct = this.participants.get(value);
    if (direct) return direct;
    const rappid = this.aliases.get(normalizeAlias(value));
    return rappid ? this.participants.get(rappid) : undefined;
  }

  private assertAvailable(
    entry: ParticipantEntry,
    features: EffectiveFeatures,
  ): void {
    if (entry.state === 'quarantined') {
      throw new ParticipantRegistryError(
        PARTICIPANT_REGISTRY_ERROR.PARTICIPANT_QUARANTINED,
        `${entry.rappid} is quarantined${entry.quarantineReason
          ? `: ${entry.quarantineReason}`
          : '.'}`,
      );
    }
    if (entry.feature && features[entry.feature] !== true) {
      throw new ParticipantRegistryError(
        PARTICIPANT_REGISTRY_ERROR.EXPERIMENTAL_FEATURE_DISABLED,
        `${entry.feature} is disabled for known participant ${entry.rappid}.`,
      );
    }
  }

  private assertObservedIdentity(
    entry: ParticipantEntry,
    descriptor: Readonly<RappParticipantDescriptor>,
    operation: 'health' | 'chat',
  ): void {
    if (descriptor.rappid !== entry.rappid) {
      const error = new RappParticipantIdentityDriftError(
        operation,
        descriptor.endpoint,
        'rappid',
        entry.rappid,
        descriptor.rappid ?? '(missing)',
      );
      this.quarantine(entry, error.message);
      throw error;
    }
    if (descriptor.liveId !== entry.liveId) {
      const error = new RappParticipantIdentityDriftError(
        operation,
        descriptor.endpoint,
        'liveId',
        entry.liveId,
        descriptor.liveId ?? '(missing)',
      );
      this.quarantine(entry, error.message);
      throw error;
    }
  }

  private assertEnvelopeIdentity(
    entry: ParticipantEntry,
    envelope: ChatEnvelope,
  ): void {
    if (envelope.rappid !== undefined && envelope.rappid !== entry.rappid) {
      const error = new RappParticipantIdentityDriftError(
        'chat',
        entry.participant.descriptor.endpoint,
        'rappid',
        entry.rappid,
        envelope.rappid,
      );
      this.quarantine(entry, error.message);
      throw error;
    }
    if (envelope.live_id !== undefined && envelope.live_id !== entry.liveId) {
      const error = new RappParticipantIdentityDriftError(
        'chat',
        entry.participant.descriptor.endpoint,
        'liveId',
        entry.liveId,
        envelope.live_id,
      );
      this.quarantine(entry, error.message);
      throw error;
    }
  }

  private quarantine(entry: ParticipantEntry, reason: string): void {
    if (this.activeByLiveId.get(entry.liveId) === entry.rappid) {
      this.activeByLiveId.delete(entry.liveId);
    }
    entry.state = 'quarantined';
    entry.quarantineReason = reason;
  }

  private removeBindings(entry: ParticipantEntry): void {
    if (this.activeByLiveId.get(entry.liveId) === entry.rappid) {
      this.activeByLiveId.delete(entry.liveId);
    }
    for (const alias of entry.aliases) {
      if (this.aliases.get(alias) === entry.rappid) this.aliases.delete(alias);
    }
  }

  private toRecord(
    entry: ParticipantEntry,
    features: EffectiveFeatures | undefined,
  ): ParticipantRegistryRecord {
    const descriptor = entry.descriptor;
    const aliases = [...entry.aliases].sort();
    const harness = descriptor.harness?.name ?? null;
    const port = descriptorPort(descriptor);
    const defaultEntry = this.configuredDefault
      ? this.lookup(this.configuredDefault)
      : undefined;
    const featureEnabled = entry.feature === undefined
      || features === undefined
      || features[entry.feature] === true;
    return {
      rappid: entry.rappid,
      liveId: entry.liveId,
      pid: entry.pid,
      ...(entry.feature ? { feature: entry.feature } : {}),
      state: entry.state,
      ...(entry.quarantineReason ? { quarantineReason: entry.quarantineReason } : {}),
      isDefault: defaultEntry?.rappid === entry.rappid,
      featureEnabled,
      liveLabel: participantLiveLabel(descriptor),
      metadata: {
        aliases,
        harness,
        endpoint: descriptor.endpoint,
        port,
      },
    };
  }

  private async tryFallback(
    participant: RappParticipant | undefined,
    label: string,
    source: 'brainstem' | 'local',
    attempts: string[],
    signal?: AbortSignal,
  ): Promise<ResolvedParticipant | undefined> {
    if (!participant) {
      attempts.push(`${label} is not configured`);
      return undefined;
    }
    try {
      const status = await participant.status(signal);
      return {
        participant,
        rappid: status.descriptor.rappid,
        liveId: status.descriptor.liveId,
        source,
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      attempts.push(`${label} unavailable (${(error as Error).message})`);
      return undefined;
    }
  }
}
