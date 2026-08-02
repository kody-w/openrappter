import type {
  SurgeonPatientSnapshot,
  SurgeonPatientState,
  SurgeonPatientTissue,
} from './types.js';

export interface PatientVitalsInput {
  capturedAt: string;
  version: string;
  running: boolean;
  uptimeSeconds: number;
  connections: number;
  agents: string[];
  channels: Array<{ id: string; configured: boolean; connected: boolean }>;
  scheduledJobs: string[];
  storageReady: boolean;
  memoryReady: boolean;
}

export function buildPatientSnapshot(
  input: PatientVitalsInput,
): SurgeonPatientSnapshot {
  const configuredChannels = input.channels.filter(channel => channel.configured);
  const connectedChannels = configuredChannels.filter(channel => channel.connected);
  const channelState: SurgeonPatientState =
    configuredChannels.length === 0
      ? 'dormant'
      : connectedChannels.length === configuredChannels.length
        ? 'stable'
        : 'degraded';

  const tissues: SurgeonPatientTissue[] = [
    {
      id: 'gateway',
      label: 'Brainstem',
      status: input.running ? 'stable' : 'critical',
      summary: input.running
        ? `Gateway responsive for ${input.uptimeSeconds} seconds.`
        : 'Gateway is not running.',
    },
    {
      id: 'agents',
      label: 'Agent cortex',
      status: input.agents.length > 0 ? 'stable' : 'critical',
      summary: input.agents.length > 0
        ? `${input.agents.length} agent${input.agents.length === 1 ? '' : 's'} available.`
        : 'No agents are available.',
      value: input.agents.length,
    },
    {
      id: 'memory',
      label: 'Memory',
      status: input.memoryReady ? 'stable' : 'dormant',
      summary: input.memoryReady
        ? 'Persistent memory tissue is present.'
        : 'No persistent memory tissue is present yet.',
    },
    {
      id: 'channels',
      label: 'Channel nerves',
      status: channelState,
      summary: configuredChannels.length === 0
        ? 'No external channel nerves are configured.'
        : `${connectedChannels.length} of ${configuredChannels.length} configured channel nerves connected.`,
      value: connectedChannels.length,
    },
    {
      id: 'autonomic',
      label: 'Autonomic jobs',
      status: input.scheduledJobs.length > 0 ? 'stable' : 'dormant',
      summary: input.scheduledJobs.length > 0
        ? `${input.scheduledJobs.length} scheduled job${input.scheduledJobs.length === 1 ? '' : 's'} active.`
        : 'No scheduled jobs are active.',
      value: input.scheduledJobs.length,
    },
    {
      id: 'storage',
      label: 'Local tissue',
      status: input.storageReady ? 'stable' : 'critical',
      summary: input.storageReady
        ? 'Local patient state is writable.'
        : 'Local patient state is unavailable.',
    },
  ];

  const state: SurgeonPatientState = tissues.some(tissue => tissue.status === 'critical')
    ? 'critical'
    : tissues.some(tissue => tissue.status === 'degraded')
      ? 'degraded'
      : 'stable';

  return {
    capturedAt: input.capturedAt,
    patient: 'OpenRappter',
    version: input.version,
    state,
    uptimeSeconds: input.uptimeSeconds,
    tissues,
    inventory: {
      agents: [...input.agents].sort(),
      channels: configuredChannels.map(channel => channel.id).sort(),
      scheduledJobs: [...input.scheduledJobs].sort(),
    },
    metrics: {
      connections: input.connections,
      agents: input.agents.length,
      configuredChannels: configuredChannels.length,
      connectedChannels: connectedChannels.length,
      scheduledJobs: input.scheduledJobs.length,
      activeCases: 0,
    },
  };
}
