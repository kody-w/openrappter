import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayServer } from '../../gateway/server.js';

const roots: string[] = [];
let server: GatewayServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Patient public-wire release fixture', () => {
  it('uses side-effect-free health then the exact authenticated chat route', async () => {
    const dataDir = fs.mkdtempSync(
      path.join(process.cwd(), '.patient-release-fixture-'),
    );
    roots.push(dataDir);
    const port = 30000 + Math.floor(Math.random() * 20000);
    const token = 'release-fixture-token';
    let agentCalls = 0;
    server = new GatewayServer({
      port,
      bind: 'loopback',
      auth: { mode: 'token', tokens: [token] },
      dataDir,
    });
    server.setAgentHandler(async (request) => {
      agentCalls += 1;
      return {
        sessionId: request.sessionId ?? 'fixture-session',
        content: `fixture:${request.message}`,
        agentLogs: [],
        finishReason: 'stop',
      };
    });
    await server.start();
    const origin = `http://127.0.0.1:${port}`;

    const health = await fetch(`${origin}/health`, {
      headers: { Origin: origin, Authorization: `Bearer ${token}` },
    });
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      status: 'ok',
      checks: { gateway: true },
    });
    expect(agentCalls).toBe(0);

    const chat = await fetch(`${origin}/chat`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_input: 'hello fixture' }),
    });
    expect(chat.status).toBe(200);
    const chatBody = await chat.json() as Record<string, unknown>;
    expect(chatBody).toMatchObject({
      status: 'success',
      response: 'fixture:hello fixture',
    });
    expect(chatBody.session_id).toEqual(expect.any(String));
    expect(agentCalls).toBe(1);
  });

  it('blocks adjacent origin/auth/query/malformed bypass mutations', async () => {
    const dataDir = fs.mkdtempSync(
      path.join(process.cwd(), '.patient-release-adversary-'),
    );
    roots.push(dataDir);
    const port = 30000 + Math.floor(Math.random() * 20000);
    const token = 'release-fixture-token';
    let agentCalls = 0;
    server = new GatewayServer({
      port,
      bind: 'loopback',
      auth: { mode: 'token', tokens: [token] },
      dataDir,
    });
    server.setAgentHandler(async () => {
      agentCalls += 1;
      return {
        sessionId: 'fixture-session',
        content: 'should-not-run',
        agentLogs: [],
        finishReason: 'stop',
      };
    });
    await server.start();
    const origin = `http://127.0.0.1:${port}`;

    const evil = await fetch(`${origin}/chat`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_input: 'bypass' }),
    });
    expect(evil.status).toBe(403);

    const unauthorized = await fetch(`${origin}/chat?mutation=1`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_input: 'bypass' }),
    });
    expect(unauthorized.status).toBe(401);

    const malformed = await fetch(`${origin}/chat`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: 'not json',
    });
    expect(malformed.status).toBe(400);
    expect(agentCalls).toBe(0);
  });
});
