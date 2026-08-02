import { describe, expect, it } from 'vitest';
import { buildPatientSnapshot } from './patient.js';

describe('buildPatientSnapshot', () => {
  it('reports stable anatomy from real healthy runtime inputs', () => {
    const snapshot = buildPatientSnapshot({
      capturedAt: '2026-08-02T01:00:00.000Z',
      version: '1.10.0',
      running: true,
      uptimeSeconds: 120,
      connections: 2,
      agents: Array.from({ length: 32 }, (_, index) => `Agent${index + 1}`),
      channels: [
        { id: 'telegram', configured: true, connected: true },
        { id: 'imessage', configured: false, connected: false },
      ],
      scheduledJobs: ['DailyTip', 'Dream'],
      storageReady: true,
      memoryReady: true,
    });

    expect(snapshot.state).toBe('stable');
    expect(snapshot.metrics).toMatchObject({
      connections: 2,
      agents: 32,
      configuredChannels: 1,
      connectedChannels: 1,
      scheduledJobs: 2,
    });
    expect(snapshot.tissues.find(tissue => tissue.id === 'channels')?.status)
      .toBe('stable');
  });

  it('degrades when a configured nerve is disconnected without declaring the patient dead', () => {
    const snapshot = buildPatientSnapshot({
      capturedAt: '2026-08-02T01:00:00.000Z',
      version: '1.10.0',
      running: true,
      uptimeSeconds: 120,
      connections: 1,
      agents: Array.from({ length: 32 }, (_, index) => `Agent${index + 1}`),
      channels: [{ id: 'telegram', configured: true, connected: false }],
      scheduledJobs: [],
      storageReady: true,
      memoryReady: true,
    });

    expect(snapshot.state).toBe('degraded');
    expect(snapshot.tissues.find(tissue => tissue.id === 'channels')).toMatchObject({
      status: 'degraded',
      value: 0,
    });
    expect(snapshot.tissues.find(tissue => tissue.id === 'autonomic')?.status)
      .toBe('dormant');
  });

  it('reports critical state when the gateway or agent cortex is absent', () => {
    const snapshot = buildPatientSnapshot({
      capturedAt: '2026-08-02T01:00:00.000Z',
      version: '1.10.0',
      running: false,
      uptimeSeconds: 0,
      connections: 0,
      agents: [],
      channels: [],
      scheduledJobs: [],
      storageReady: false,
      memoryReady: false,
    });

    expect(snapshot.state).toBe('critical');
    expect(snapshot.tissues.filter(tissue => tissue.status === 'critical').map(tissue => tissue.id))
      .toEqual(expect.arrayContaining(['gateway', 'agents', 'storage']));
  });
});
