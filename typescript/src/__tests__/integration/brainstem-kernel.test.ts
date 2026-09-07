import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrainstemKernel,
  LocalStorageManager,
  type BrainstemLlmResult,
  type BrainstemMessage,
} from '../../brainstem.js';

const WORK = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../../.test-work',
  `brainstem-kernel-${process.pid}`,
);

const DROP_IN = `
import { BasicAgent } from './BasicAgent.js';
export class DropInAgent extends BasicAgent {
  constructor() {
    super('DropIn', {
      name: 'DropIn',
      description: 'A standalone RAPP TypeScript drop-in.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Text to echo.' } },
        required: [],
      },
    });
  }
  async perform(kwargs = {}) {
    return JSON.stringify({ status: 'success', echo: kwargs.query ?? '' });
  }
}
`;

async function request(
  base: string,
  route: string,
  init?: RequestInit,
): Promise<{ status: number; json?: Record<string, unknown>; text: string }> {
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  let json: Record<string, unknown> | undefined;
  try { json = JSON.parse(text); } catch { /* raw source */ }
  return { status: response.status, json, text };
}

function multipart(filename: string, content: string): { body: string; contentType: string } {
  const boundary = '----openrappter-ts-boundary';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body:
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
      + 'Content-Type: text/typescript\r\n\r\n'
      + `${content}\r\n--${boundary}--\r\n`,
  };
}

describe('TypeScript brainstem kernel', () => {
  let kernel: BrainstemKernel;
  let base: string;
  let replies: (
    messages: BrainstemMessage[],
  ) => Promise<BrainstemLlmResult>;

  beforeEach(async () => {
    await fs.rm(WORK, { recursive: true, force: true });
    const agentsPath = path.join(WORK, 'agents');
    const packaged = path.join(WORK, 'packaged');
    await fs.mkdir(agentsPath, { recursive: true });
    await fs.mkdir(packaged, { recursive: true });
    await fs.writeFile(path.join(WORK, 'soul.md'), 'You are the test soul.');
    replies = async () => ({
      message: { role: 'assistant', content: 'ok' },
      servedModel: 'gpt-test',
      requestedModel: 'gpt-test',
    });
    kernel = new BrainstemKernel({
      home: WORK,
      agentsPath,
      packagedAgentsPath: packaged,
      soulPath: path.join(WORK, 'soul.md'),
      port: 0,
      env: {},
      llmChat: (messages) => replies(messages),
    });
    await kernel.start();
    base = `http://127.0.0.1:${kernel.port}`;
  });

  afterEach(async () => {
    await kernel.stop();
    await fs.rm(WORK, { recursive: true, force: true });
  });

  it('serves health, version, models, and the root descriptor', async () => {
    const health = await request(base, '/health');
    expect(health.status).toBe(200);
    expect(health.json).toMatchObject({
      status: 'ok',
      agents: [],
      brainstem_dir: WORK,
      soul: path.join(WORK, 'soul.md'),
      model: 'claude-sonnet-5',
      copilot: '✗',
    });
    expect((await request(base, '/version')).json).toHaveProperty('version');
    expect((await request(base, '/models')).json).toEqual({
      models: ['claude-sonnet-5'],
      active: 'claude-sonnet-5',
    });
    expect((await request(base, '/')).json).toHaveProperty('name', 'OpenRappter Brainstem');
  });

  it('imports, hot-loads, lists, exports, and deletes a standalone TypeScript agent', async () => {
    const form = multipart('drop_in.ts', DROP_IN);
    const imported = await request(base, '/agents/import', {
      method: 'POST',
      headers: { 'content-type': form.contentType },
      body: form.body,
    });
    expect(imported.status).toBe(200);
    expect(imported.json).toMatchObject({ status: 'ok' });
    expect(imported.json?.message).toContain('drop_inAgent.ts');

    const health = await request(base, '/health');
    expect(health.json?.agents).toContain('DropIn');
    const listing = await request(base, '/agents');
    expect(listing.json?.files).toContainEqual({
      filename: 'drop_inAgent.ts',
      agents: ['DropIn'],
    });
    const exported = await request(base, '/agents/export/drop_inAgent.ts');
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('class DropInAgent');
    expect((await request(base, '/agents/drop_inAgent.ts', { method: 'DELETE' })).json)
      .toMatchObject({ status: 'ok' });
    expect((await request(base, '/agents/export/drop_inAgent.ts')).status).toBe(404);
  });

  it('matches the frozen chat request and response envelopes', async () => {
    expect((await request(base, '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([]),
    })).json).toEqual({
      schema: 'rapp-chat/1.0',
      status: 'error',
      error: 'Request body must be a JSON object',
    });
    expect((await request(base, '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_input: '', conversation_history: 'bad' }),
    })).json?.error).toBe('conversation_history must be an array');

    replies = async messages => ({
      message: { role: 'assistant', content: String(messages.at(-1)?.content) },
      servedModel: 'gpt-test',
      requestedModel: 'gpt-test',
    });
    const response = await request(base, '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_input: 'canonical',
        message: 'alias',
        session_id: 'session',
      }),
    });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      schema: 'rapp-chat/1.0',
      status: 'success',
      response: 'canonical',
      content: 'canonical',
      session_id: 'session',
      sessionId: 'session',
      agent_logs: '',
      voice_mode: false,
      model: 'gpt-test',
      requested_model: 'gpt-test',
    });
    expect(response.json).not.toHaveProperty('assistant_response');
  });

  it('runs tools for no more than three rounds and returns ordered agent logs', async () => {
    await fs.writeFile(path.join(kernel.agentsPath, 'drop_in_agent.ts'), DROP_IN);
    let calls = 0;
    replies = async messages => {
      calls++;
      if (calls === 1) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'DropIn', arguments: '{"query":"ping"}' },
            }],
          },
          servedModel: 'gpt-test',
          requestedModel: 'gpt-test',
        };
      }
      const tool = messages.find(message => message.role === 'tool');
      expect(tool).toMatchObject({ name: 'DropIn', tool_call_id: 'call-1' });
      return {
        message: { role: 'assistant', content: 'DropIn echoed ping.' },
        servedModel: 'gpt-test',
        requestedModel: 'gpt-test',
      };
    };
    const response = await request(base, '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user_input: 'use DropIn' }),
    });
    expect(response.json?.response).toBe('DropIn echoed ping.');
    expect(response.json?.agent_logs).toContain('[DropIn]');
    expect(response.json?.agent_logs).toContain('ping');
    expect(calls).toBe(2);
  });

  it('deduplicates idempotent turns and rejects conflicting reuse', async () => {
    let calls = 0;
    replies = async () => {
      calls++;
      return {
        message: { role: 'assistant', content: 'once' },
        servedModel: 'gpt-test',
        requestedModel: 'gpt-test',
      };
    };
    const body = {
      message: 'run once',
      session_id: 'session',
      idempotency_key: 'same-key',
    };
    const first = await request(base, '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const second = await request(base, '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(second.json).toEqual(first.json);
    expect(calls).toBe(1);
    const conflict = await request(base, '/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, message: 'different' }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json?.error).toBe('Idempotency key conflicts with another request');
  });

  it('provides the local Azure storage migration shim', async () => {
    const storage = new LocalStorageManager(path.join(WORK, 'storage'));
    expect(storage.current_guid).toBeNull();
    storage.set_memory_context('person');
    expect(storage.current_guid).toBe('person');
    expect(await storage.update_json(current => ({ ...current, fact: 'remembered' })))
      .toEqual({ fact: 'remembered' });
    expect(await storage.read_json()).toEqual({ fact: 'remembered' });
  });
});
