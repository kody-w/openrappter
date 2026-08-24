// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
  patientChat: vi.fn(),
}));

vi.mock('../services/desktop.js', () => ({
  desktopBridge: () => bridge,
}));

const health = {
  status: 200,
  body: JSON.stringify({
    status: 'ok',
    version: '1.13.0',
    uptime: 10,
    timestamp: '2026-08-23T00:00:00.000Z',
    checks: { gateway: true },
  }),
};

describe('patient public chat transport', () => {
  beforeEach(() => {
    vi.resetModules();
    bridge.patientChat.mockReset();
  });

  it('probes and sends through the same exact mediated /chat contract', async () => {
    bridge.patientChat
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce({
        status: 200,
        body: JSON.stringify({
          schema: 'rapp-chat/1.0',
          status: 'success',
          response: 'hello',
          session_id: 'session-1',
          agent_logs: '',
        }),
      });
    const service = await import('../services/patient.js');

    await expect(service.probePatientTransport()).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(service.askPatient('hello')).resolves.toMatchObject({
      response: 'hello',
      session_id: 'session-1',
    });
    expect(bridge.patientChat.mock.calls).toEqual([
      [{ action: 'probe' }],
      [{ action: 'send', userInput: 'hello' }],
    ]);
  });

  it.each([
    [{ status: 0, body: '', error: 'offline' }, 'offline'],
    [{ status: 0, body: '', error: 'timeout' }, 'timeout'],
    [{ status: 401, body: '' }, 'unauthorized'],
    [{ status: 503, body: '' }, 'server-error'],
    [{ status: 200, body: '{}' }, 'server-error'],
  ])('classifies failed readiness without stale ready state', async (result, status) => {
    bridge.patientChat.mockResolvedValue(result);
    const service = await import('../services/patient.js');
    await expect(service.probePatientTransport()).resolves.toMatchObject({
      status,
      retryable: true,
    });
    expect(service.getPatientTransportState().status).toBe(status);
  });

  it('persists no session or answer when a completed response is malformed', async () => {
    bridge.patientChat
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce({ status: 200, body: '{"response":"missing session"}' });
    const service = await import('../services/patient.js');
    await service.probePatientTransport();
    await expect(service.askPatient('hello')).rejects.toThrow('malformed');
    expect(service.getPatientTransportState()).toMatchObject({
      status: 'server-error',
    });
  });

  it('deduplicates concurrent conversation actions', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bridge.patientChat
      .mockResolvedValueOnce(health)
      .mockImplementationOnce(async () => {
        await gate;
        return {
          status: 200,
          body: JSON.stringify({
            response: 'done',
            session_id: 'session-1',
            agent_logs: '',
          }),
        };
      });
    const service = await import('../services/patient.js');
    await service.probePatientTransport();
    const first = service.askPatient('hello');
    const duplicate = service.askPatient('hello');
    expect(first).toBe(duplicate);
    release();
    await first;
    expect(bridge.patientChat).toHaveBeenCalledTimes(2);
  });

  it('downgrades after health succeeds but chat fails, then recovers via health', async () => {
    bridge.patientChat
      .mockResolvedValueOnce(health)
      .mockResolvedValueOnce({ status: 0, body: '', error: 'offline' })
      .mockResolvedValueOnce(health);
    const service = await import('../services/patient.js');

    await expect(service.probePatientTransport()).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(service.askPatient('hello')).rejects.toThrow('offline');
    expect(service.getPatientTransportState()).toMatchObject({
      status: 'offline',
    });
    await expect(service.probePatientTransport(true)).resolves.toMatchObject({
      status: 'ready',
    });
    expect(bridge.patientChat.mock.calls.map(([request]) => request.action))
      .toEqual(['probe', 'send', 'probe']);
  });
});
