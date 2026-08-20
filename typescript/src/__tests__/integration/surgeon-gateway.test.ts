import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { GatewayServer } from '../../gateway/server.js';
import type { SurgeonService } from '../../surgeon/service.js';

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function request(
  socket: WebSocket,
  id: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5_000);
    const onMessage = (raw: Buffer | string) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.id !== id) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(frame);
    };
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}

describe('surgeon gateway integration', () => {
  let server: GatewayServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('advertises and serves the surgeon while protecting mutating turns', async () => {
    const service = {
      getPatient: vi.fn(async () => ({ patient: 'OpenRappter', state: 'stable' })),
      listCases: vi.fn(() => []),
      getCase: vi.fn(),
      consult: vi.fn(async () => ({ turn: { response: 'examined' } })),
      approveProcedure: vi.fn(),
      rejectProcedure: vi.fn(),
      operate: vi.fn(),
    } as unknown as SurgeonService;
    server = new GatewayServer({
      port: 0,
      bind: 'loopback',
      auth: { mode: 'token', tokens: ['surgeon-token'] },
    });
    server.setSurgeonService(service);
    await server.start();
    const port = server.port;

    const socket = await connect(port);
    const hello = await request(socket, 'connect', 'connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'surgeon-test',
        version: '1.0.0',
        platform: 'test',
        mode: 'test',
      },
      auth: { token: 'surgeon-token' },
    });
    const features = (
      (hello.payload as { features: { methods: string[] } }).features
    );
    expect(features.methods).toContain('surgeon.turn');

    const patient = await request(socket, 'patient', 'surgeon.patient');
    expect(patient.ok).toBe(true);
    expect(patient.payload).toEqual({ patient: 'OpenRappter', state: 'stable' });
    socket.close();

    const unauthenticated = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'turn',
        method: 'surgeon.turn',
        params: { userInput: 'Operate now' },
      }),
    });
    expect(unauthenticated.status).toBe(401);
    expect(service.consult).not.toHaveBeenCalled();
  });
});
