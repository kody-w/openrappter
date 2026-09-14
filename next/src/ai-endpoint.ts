import type { Readable } from 'node:stream';
import { canonicalJson, parseJson, type JsonObject, type JsonValue } from './canonical.js';
import { label, object, text } from './contract.js';
import { publicError, Refusal, requireThat } from './errors.js';
import { AI_LIMITS, AI_PROJECTION_SCHEMA } from './ai-contract.js';
import { AiProjectionApi } from './ai-api.js';
import { ProjectionStreams } from './ai-stream.js';
import { boundedLines, BoundedWriter } from './bounded-stdio.js';

export const MCP_PROTOCOL = '2025-11-25';
const ROOT_PROPERTY = { type: 'string', description: 'The exact root RAPPID supplied by its owner.' };
const CURSOR_PROPERTY = { type: ['object', 'null'], description: 'An exact canonical cursor returned by this endpoint.' };
function schema(required: string[], properties: JsonObject): JsonObject {
  return { type: 'object', required: ['root', ...required], additionalProperties: false, properties: { root: ROOT_PROPERTY, ...properties } };
}
export const AI_TOOLS = Object.freeze([
  { name: 'rapp_work_read', description: 'Read the authorized canonical root projection; no model call or mutation.',
    inputSchema: schema([], {}) },
  { name: 'rapp_work_context', description: 'Read bounded canonical proposal context and its exact revision for this capability scope; no model call or mutation.',
    inputSchema: schema([], { scope: { type: 'string' } }) },
  { name: 'rapp_work_catch_up', description: 'Deterministic read-only fast-forward timeline with recorded/reconstructed/unavailable grades, canonical source hashes and state digests. Never reruns models or tools.',
    inputSchema: schema([], { from: CURSOR_PROPERTY, to: CURSOR_PROPERTY, limit: { type: 'integer', minimum: 1, maximum: 16 },
      guest: { type: 'object', required: ['enabled', 'dataClass', 'visibility', 'policyWave'], additionalProperties: false,
        properties: { enabled: { const: true }, dataClass: { const: 'godd' }, visibility: { const: 'private' }, policyWave: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } }) },
  { name: 'rapp_work_publish', description: 'Publish attributed public work and optional closed declarative view hints. No arbitrary UI code or external effects.',
    inputSchema: schema(['requestId', 'publication'], { requestId: { type: 'string' }, publication: { type: 'object' } }) },
  { name: 'rapp_work_propose', description: 'Publish a validated structured Draft bound to an exact context revision. It remains review-only until exact owner confirmation.',
    inputSchema: schema(['requestId', 'proposal'], { requestId: { type: 'string' }, proposal: { type: 'object' } }) },
  { name: 'rapp_work_history', description: 'Read a bounded canonical history page for replay; controls expose references only.',
    inputSchema: schema([], { cursor: CURSOR_PROPERTY, limit: { type: 'integer', minimum: 1, maximum: AI_LIMITS.pageEvents } }) },
  { name: 'rapp_work_artifact', description: 'Read an already-authorized canonical artifact, never a filesystem path or arbitrary URL.',
    inputSchema: schema(['artifact'], { artifact: { type: 'string' } }) },
  { name: 'rapp_work_subscribe', description: 'Create a bounded disposable event resource; subscribe/read it for real-time transforms. A cursor requests replay.',
    inputSchema: schema([], { cursor: CURSOR_PROPERTY }) },
  { name: 'rapp_work_unsubscribe', description: 'Close only this connection’s disposable subscription; canonical work remains.',
    inputSchema: schema(['subscription'], { subscription: { type: 'string' } }) },
]);

export class AiEndpoint {
  readonly streams: ProjectionStreams;
  readonly #owned = new Map<string, { uri: string; notify: boolean; notified: string | null }>();
  readonly #recent: number[] = [];
  #initialized: 'new' | 'negotiated' | 'ready' = 'new';
  constructor(readonly api: AiProjectionApi, readonly root: string, readonly capability: string,
    readonly mode: 'stdio' | 'mcp', readonly send: (message: unknown) => void,
    streams?: ProjectionStreams) {
    this.streams = streams ?? new ProjectionStreams(api);
  }

  #rate(): void {
    const now = Date.now();
    while (this.#recent[0] !== undefined && this.#recent[0] <= now - 60_000) this.#recent.shift();
    requireThat(this.#recent.length < AI_LIMITS.requestsPerMinute, 'transport-rate', 'The bounded connection request rate is exhausted.');
    this.#recent.push(now);
  }
  async #call(method: string, value: unknown): Promise<unknown> {
    const p = object(value);
    requireThat(p.root === this.root, 'client-unauthorized', 'The connection cannot select or impersonate another root GUID.');
    const exact = (required: string[], optional: string[] = []): void => { object(p, ['root', ...required], optional); };
    switch (method) {
      case 'rapp_work_read':
        exact([]);
        return this.api.read(this.root, this.capability);
      case 'rapp_work_context':
        exact([], ['scope']);
        return this.api.context(this.root, this.capability, p.scope);
      case 'rapp_work_catch_up':
        exact([], ['from', 'to', 'limit', 'guest']);
        return this.api.catchUp(this.root, this.capability,
          Object.fromEntries(['from', 'to', 'limit', 'guest'].filter(k => p[k] !== undefined).map(k => [k, p[k]])));
      case 'rapp_work_publish':
        exact(['requestId', 'publication']);
        return this.api.publish(this.root, this.capability, p.publication, label(p.requestId));
      case 'rapp_work_propose':
        exact(['requestId', 'proposal']);
        return this.api.propose(this.root, this.capability, p.proposal, label(p.requestId));
      case 'rapp_work_history':
        exact([], ['cursor', 'limit']);
        requireThat(p.limit === undefined || typeof p.limit === 'number', 'page-bound', 'History limit must be an integer.');
        return this.api.history(this.root, this.capability, p.cursor ?? null, p.limit === undefined ? AI_LIMITS.pageEvents : Number(p.limit));
      case 'rapp_work_artifact':
        exact(['artifact']);
        return this.api.artifact(this.root, this.capability, label(p.artifact));
      case 'rapp_work_subscribe': {
        exact([], ['cursor']);
        const sub = await this.streams.subscribe(this.root, this.capability, p.cursor ?? null);
        const id = String(sub.subscription);
        const uri = `rapp-work://projection/${id}`;
        this.#owned.set(id, { uri, notify: this.mode === 'stdio', notified: null });
        return { ...sub, uri };
      }
      case 'rapp_work_unsubscribe': {
        exact(['subscription']);
        const id = text(p.subscription, 64);
        requireThat(this.#owned.has(id), 'subscription-not-found', 'Only a subscription owned by this connection can be closed.');
        this.streams.unsubscribe(id);
        this.#owned.delete(id);
        return { closed: true };
      }
      default: throw new Refusal('method-unavailable', 'Only scoped context, proposal and public-work projection methods are exposed; owner confirmation, grants, shell, deletion and external approvals are not AI tools.');
    }
  }

  async handle(line: string): Promise<void> {
    this.#rate();
    if (this.mode === 'stdio') {
      let id: string | null = null;
      try {
        const request = object(parseJson(line), ['id', 'method', 'params']);
        id = label(request.id);
        this.send({ interface: AI_PROJECTION_SCHEMA, id, result: await this.#call(text(request.method, 80), request.params) });
      } catch (error) { this.send({ interface: AI_PROJECTION_SCHEMA, id, error: publicError(error) }); }
      return;
    }
    let id: JsonValue | null = null;
    let notification = false;
    try {
      const request = object(parseJson(line), ['jsonrpc', 'method'], ['id', 'params']);
      requireThat(request.jsonrpc === '2.0', 'mcp-contract', 'MCP uses JSON-RPC 2.0.');
      notification = request.id === undefined;
      if (!notification) {
        requireThat(typeof request.id === 'string' || (typeof request.id === 'number' && Number.isSafeInteger(request.id)),
          'mcp-contract', 'A request requires a bounded string or integer JSON-RPC ID.');
        if (typeof request.id === 'string') text(request.id, 100);
        id = request.id!;
      }
      const method = text(request.method, 80);
      const params = object(request.params ?? {});
      if (method === 'initialize') {
        requireThat(!notification && this.#initialized === 'new', 'mcp-lifecycle', 'Initialize once before using this connection.');
        object(params, ['protocolVersion', 'capabilities', 'clientInfo']);
        text(params.protocolVersion, 30); object(params.capabilities); object(params.clientInfo);
        this.#initialized = 'negotiated';
        this.send({ jsonrpc: '2.0', id, result: {
          protocolVersion: MCP_PROTOCOL, serverInfo: { name: 'rapp-work-bot', version: '0.2.0' },
          capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: false } },
          instructions: 'Use the owner-provided exact root and connection capability. Read canonical context before publishing a structured proposal. Proposal publication never grants confirmation or mutation authority. No model sampling, native scanning, owner administration or executable UI is exposed.',
        } });
        return;
      }
      if (method === 'notifications/initialized') {
        requireThat(notification && this.#initialized === 'negotiated', 'mcp-lifecycle', 'The initialization response must precede readiness.');
        this.#initialized = 'ready';
        return;
      }
      if (method === 'ping' && !notification) { this.send({ jsonrpc: '2.0', id, result: {} }); return; }
      requireThat(this.#initialized === 'ready', 'mcp-lifecycle', 'Complete MCP initialization before requesting work.');
      if (notification) return;
      let result: unknown;
      if (method === 'tools/list') {
        object(params, []);
        result = { tools: AI_TOOLS };
      } else if (method === 'tools/call') {
        object(params, ['name', 'arguments'], ['_meta']);
        try {
          const value = await this.#call(text(params.name, 80), params.arguments);
          result = { content: [{ type: 'text', text: canonicalJson(value) }], structuredContent: value, isError: false };
        } catch (error) {
          result = { content: [{ type: 'text', text: canonicalJson(publicError(error)) }], isError: true };
        }
      } else if (method === 'resources/list') {
        object(params, []);
        await this.api.authority.authorize(this.root, this.capability, ['projection.read']);
        result = { resources: [...this.#owned].map(([id, resource]) => ({ uri: resource.uri, name: id,
          mimeType: 'application/json', description: 'Bounded canonical projection events; disposable, never state authority.' })) };
      } else if (['resources/read', 'resources/subscribe', 'resources/unsubscribe'].includes(method)) {
        object(params, ['uri']);
        const entry = [...this.#owned].find(([, r]) => r.uri === params.uri);
        requireThat(entry, 'subscription-not-found', 'Only this connection’s authorized event resource can be accessed.');
        const [subId, resource] = entry;
        await this.api.authority.authorize(this.root, this.capability, ['projection.read', 'projection.subscribe']);
        if (method === 'resources/subscribe') { resource.notify = true; result = {}; }
        else if (method === 'resources/unsubscribe') { resource.notify = false; result = {}; }
        else {
          const events = await this.streams.take(subId);
          result = { contents: [{ uri: resource.uri, mimeType: 'application/json', text: canonicalJson({ events }) }] };
        }
      } else throw new Refusal('method-unavailable', 'This MCP method is not exposed.');
      this.send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      if (!notification) this.send({ jsonrpc: '2.0', id, error: { code: -32600, message: publicError(error).message, data: publicError(error) } });
    }
  }

  async tick(): Promise<void> {
    await this.streams.poll();
    for (const [id, resource] of [...this.#owned]) {
      if (!resource.notify) continue;
      try {
        const status = this.streams.status(id);
        if (Number(status.events) === 0) continue;
        if (this.mode === 'mcp') {
          const pending = canonicalJson(status);
          if (resource.notified !== pending) {
            this.send({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: resource.uri } });
            resource.notified = pending;
          }
          if (status.closed) resource.notify = false;
        } else {
          const events = await this.streams.take(id, Math.min(Number(status.events), AI_LIMITS.queuedEvents));
          for (const event of events) this.send({ interface: AI_PROJECTION_SCHEMA, event });
          if (events.some(e => e.type === 'resync-required')) this.#owned.delete(id);
        }
      } catch (error) {
        if (error instanceof Refusal && error.code === 'subscription-not-found') { this.#owned.delete(id); continue; }
        throw error;
      }
    }
  }
  close(): void {
    for (const id of this.#owned.keys()) this.streams.unsubscribe(id);
    this.#owned.clear();
  }
}

export async function serveAi(endpoint: AiEndpoint, input: Readable, writer: BoundedWriter): Promise<void> {
  let ticking = false;
  let failed: unknown = null;
  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try { await endpoint.tick(); }
    catch (error) { failed = error; input.destroy(); }
    finally { ticking = false; }
  };
  const timer = setInterval(() => { void tick(); }, AI_LIMITS.pollMs);
  try {
    for await (const line of boundedLines(input)) {
      await endpoint.handle(line);
      await tick();
      if (failed) throw failed;
    }
    await writer.flush();
  } finally { clearInterval(timer); endpoint.close(); }
}
