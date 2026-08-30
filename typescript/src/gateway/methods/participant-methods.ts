import {
  getEffectiveFeatures,
  type EffectiveFeatures,
} from '../../config/features.js';
import {
  GroupService,
  GroupServiceError,
  GROUP_ERROR,
  type GroupCreateRequest,
  type GroupHistory,
  type GroupRunResult,
  type GroupSendRequest,
  type GroupSnapshot,
} from '../../rapp/group-service.js';
import {
  ParticipantRegistry,
  type ParticipantRegistryRecord,
} from '../../rapp/participant-registry.js';
import type { RappParticipantStatus } from '../../rapp/participant.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

export interface ParticipantMethodsDeps {
  registry?: ParticipantRegistry;
  groupService?: GroupService;
  loadFeatures?: () => EffectiveFeatures;
}

interface ParticipantStatusParams {
  participant?: string;
  rappid?: string;
  alias?: string;
}

interface GroupCreateParams {
  participants?: string[];
  participantIds?: string[];
  rounds?: number;
}

interface GroupSendParams {
  groupId: string;
  userInput?: string;
  message?: string;
  rounds?: number;
}

function assertGroupEnabled(features: EffectiveFeatures): void {
  if (features.brainSurgeonGroupChat !== true) {
    throw new GroupServiceError(
      GROUP_ERROR.EXPERIMENTAL_FEATURE_DISABLED,
      'Brain Surgeon group chat is disabled.',
    );
  }
}

export function registerParticipantMethods(
  server: MethodRegistrar,
  deps: ParticipantMethodsDeps = {},
): void {
  const registry = deps.registry ?? new ParticipantRegistry();
  const groups = deps.groupService ?? new GroupService({ registry });
  const features = (): EffectiveFeatures =>
    deps.loadFeatures?.() ?? getEffectiveFeatures(undefined);

  server.registerMethod<void, { participants: ParticipantRegistryRecord[] }>(
    'participants.list',
    async () => {
      const current = features();
      assertGroupEnabled(current);
      return { participants: registry.list(current) };
    },
    { requiresAuth: true },
  );

  server.registerMethod<
    ParticipantStatusParams,
    RappParticipantStatus
  >(
    'participants.status',
    async params => {
      const current = features();
      const participant = params.participant ?? params.rappid ?? params.alias ?? '';
      registry.resolveExplicit(participant, current);
      assertGroupEnabled(current);
      return registry.status(participant, current);
    },
    { requiresAuth: true },
  );

  server.registerMethod<GroupCreateParams, GroupSnapshot>(
    'group.create',
    async params => groups.create({
      participants: params.participants ?? params.participantIds ?? [],
      ...(params.rounds === undefined ? {} : { rounds: params.rounds }),
    } satisfies GroupCreateRequest, features()),
    { requiresAuth: true },
  );

  server.registerMethod<GroupSendParams, GroupRunResult>(
    'group.send',
    async params => groups.send({
      groupId: params.groupId,
      userInput: params.userInput ?? params.message ?? '',
      ...(params.rounds === undefined ? {} : { rounds: params.rounds }),
    } satisfies GroupSendRequest, features()),
    { requiresAuth: true },
  );

  server.registerMethod<{ groupId: string }, GroupSnapshot>(
    'group.cancel',
    async ({ groupId }) => {
      assertGroupEnabled(features());
      return groups.cancel(groupId);
    },
    { requiresAuth: true },
  );

  server.registerMethod<{ groupId: string }, GroupHistory>(
    'group.history',
    async ({ groupId }) => {
      assertGroupEnabled(features());
      return groups.history(groupId);
    },
    { requiresAuth: true },
  );
}
