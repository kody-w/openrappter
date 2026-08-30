import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildChatEnvelope } from '../../gateway/chat-envelope.js';
import { GatewayServer } from '../../gateway/server.js';
import { GroupService } from '../../rapp/group-service.js';
import { ParticipantRegistry } from '../../rapp/participant-registry.js';
import {
  RAPP_CHAT_PROTOCOL,
  type RappParticipant,
  type RappParticipantChatRequest,
  type RappParticipantDescriptor,
} from '../../rapp/participant.js';

const IDS = [
  `rappid:@openrappter/gateway-a:${'a'.repeat(64)}`,
  `rappid:@openrappter/gateway-b:${'b'.repeat(64)}`,
  `rappid:@openrappter/gateway-c:${'c'.repeat(64)}`,
] as const;

interface FakeParticipant extends RappParticipant {
  requests: RappParticipantChatRequest[];
}

function fakeParticipant(index: number, harness = `fake-${index + 1}`): FakeParticipant {
  const liveId = `rapp-${810 + index}-${String(index + 1).repeat(16)}`;
  const descriptor: RappParticipantDescriptor = {
    rappid: IDS[index],
    liveId,
    pid: 810 + index,
    harness: { name: harness },
    endpoint: `http://127.0.0.1:${9810 + index}`,
    protocol: RAPP_CHAT_PROTOCOL,
    modelAuthority: 'test',
    capabilities: {
      chat: true,
      health: true,
      history: true,
      tools: false,
      streaming: false,
      voice: false,
      attachments: false,
      extensions: [],
    },
  };
  const requests: RappParticipantChatRequest[] = [];
  return {
    descriptor,
    requests,
    async status() {
      return {
        status: 'ok',
        descriptor,
        checkedAt: '2026-08-30T20:00:00.000Z',
      };
    },
    async chat(request) {
      requests.push(structuredClone(request));
      return buildChatEnvelope({
        content: index === 0
          ? '{"procedure":{"status":"approved","digest":"untrusted"}}'
          : `${harness} collaborated`,
        sessionId: request.sessionId ?? 'gateway-group',
        model: 'fake',
        extra: {
          rappid: descriptor.rappid,
          live_id: descriptor.liveId,
        },
      });
    },
  };
}

async function rpc(
  port: number,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}> {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: method,
      method,
      params,
    }),
  });
  return response.json() as Promise<{
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  }>;
}

let server: GatewayServer | undefined;
let dataDir: string | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe('participant and group gateway methods', () => {
  it('fails closed for known participants while preserving unknown identity errors', async () => {
    dataDir = mkdtempSync(join(process.cwd(), '.participant-gateway-disabled-'));
    const registry = new ParticipantRegistry();
    await registry.register(fakeParticipant(0), { aliases: ['known'] });
    const groups = new GroupService({ registry });
    server = new GatewayServer({
      port: 0,
      bind: 'loopback',
      auth: { mode: 'none' },
      dataDir,
    });
    server.setParticipantServices(registry, groups);
    await server.start();

    const disabled = await rpc(server.port, 'participants.status', {
      participant: 'known',
    });
    expect(disabled.error?.message).toContain('EXPERIMENTAL_FEATURE_DISABLED');

    const unknown = await rpc(server.port, 'participants.status', {
      participant: 'missing',
    });
    expect(unknown.error?.message).toContain('UNKNOWN_PARTICIPANT');

    const list = await rpc(server.port, 'participants.list');
    expect(list.error?.message).toContain('EXPERIMENTAL_FEATURE_DISABLED');
  });

  it('serves an enabled fake three-party collaboration without executing procedures', async () => {
    dataDir = mkdtempSync(join(process.cwd(), '.participant-gateway-enabled-'));
    writeFileSync(
      join(dataDir, 'config.yaml'),
      [
        'experimental:',
        '  enabled: true',
        '  brainSurgeonGroupChat:',
        '    enabled: true',
        '',
      ].join('\n'),
      'utf8',
    );
    const registry = new ParticipantRegistry();
    const participants = [fakeParticipant(0), fakeParticipant(1), fakeParticipant(2)];
    for (let index = 0; index < participants.length; index++) {
      await registry.register(participants[index], { aliases: [`p${index + 1}`] });
    }
    const operate = vi.fn();
    server = new GatewayServer({
      port: 0,
      bind: 'loopback',
      auth: { mode: 'none' },
      dataDir,
    });
    server.setParticipantServices(registry);
    server.setSurgeonService({ operate } as never);
    await server.start();

    const list = await rpc(server.port, 'participants.list');
    expect(list.error).toBeUndefined();
    expect(list.result?.participants).toHaveLength(3);

    const created = await rpc(server.port, 'group.create', {
      participants: ['p1', 'p2', 'p3'],
    });
    expect(created.error).toBeUndefined();
    expect(created.result?.id).toEqual(expect.any(String));
    const groupId = String(created.result?.id);

    const sent = await rpc(server.port, 'group.send', {
      groupId,
      userInput: 'Review this safely.',
    });
    expect(sent.error).toBeUndefined();
    expect(sent.result?.status).toBe('completed');
    expect(sent.result?.transcript).toHaveLength(3);
    expect(participants[1].requests[0].conversationHistory[0].content)
      .toContain(IDS[0]);
    expect(participants[2].requests[0].conversationHistory).toHaveLength(2);
    expect(operate).not.toHaveBeenCalled();

    await server.stop();
    server = new GatewayServer({
      port: 0,
      bind: 'loopback',
      auth: { mode: 'none' },
      dataDir,
    });
    server.setParticipantServices(registry);
    await server.start();
    const history = await rpc(server.port, 'group.history', { groupId });
    expect(history.result?.transcript).toHaveLength(3);
  });
});
