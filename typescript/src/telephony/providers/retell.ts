/**
 * Retell AI provider.
 *
 * Retell owns the media path: it holds the PSTN leg, runs speech-to-text and
 * text-to-speech, and streams events over a websocket. This adapter drives the
 * REST surface for dialling and hanging up, and consumes a transcript stream
 * that the gateway feeds in from Retell's webhook.
 *
 * Set RETELL_API_KEY and RETELL_AGENT_ID (or RETELL_FROM_NUMBER) to use it.
 */

import type { CallHandle, CallProvider, DialRequest } from '../types.js';

const API = 'https://api.retellai.com';

export interface RetellOptions {
  apiKey?: string;
  agentId?: string;
  fromNumber?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Supplies the next thing the other party said. The gateway pushes Retell's
   * `update-only`/`transcript` webhook events into this queue.
   */
  transcriptSource?: (callId: string, timeoutMs: number) => Promise<string | null>;
}

export class RetellProvider implements CallProvider {
  readonly name = 'retell';

  private readonly apiKey?: string;
  private readonly agentId?: string;
  private readonly fromNumber?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transcriptSource?: RetellOptions['transcriptSource'];

  constructor(options: RetellOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.RETELL_API_KEY;
    this.agentId = options.agentId ?? process.env.RETELL_AGENT_ID;
    this.fromNumber = options.fromNumber ?? process.env.RETELL_FROM_NUMBER;
    this.baseUrl = options.baseUrl ?? API;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.transcriptSource = options.transcriptSource;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && (this.agentId || this.fromNumber) && this.fetchImpl);
  }

  private async request(path: string, body: unknown): Promise<Record<string, unknown>> {
    if (!this.apiKey) throw new Error('RETELL_API_KEY is not set');

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`retell ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async dial(request: DialRequest): Promise<CallHandle> {
    const payload = await this.request('/v2/create-phone-call', {
      from_number: request.from ?? this.fromNumber,
      to_number: request.to,
      override_agent_id: this.agentId,
      retell_llm_dynamic_variables: {
        objective: request.objective?.goal ?? '',
        constraints: (request.objective?.constraints ?? []).map((c) => c.label ?? c.kind).join('; '),
        ...(request.metadata ?? {}),
      },
    });

    const externalId = String(payload.call_id ?? payload.callId ?? '');
    return { id: externalId || `retell_${Date.now()}`, provider: this.name, to: request.to, direction: 'outbound', externalId };
  }

  /**
   * Retell's agent speaks from its own LLM config. When openrappter is driving
   * the words instead, they are injected as an agent-side message.
   */
  async say(handle: CallHandle, text: string): Promise<void> {
    await this.request('/v2/create-agent-message', { call_id: handle.externalId ?? handle.id, message: text });
  }

  async listen(handle: CallHandle, timeoutMs = 30_000): Promise<string | null> {
    if (!this.transcriptSource) {
      throw new Error('RetellProvider needs a transcriptSource to receive the other party (wire it to the webhook)');
    }
    return this.transcriptSource(handle.externalId ?? handle.id, timeoutMs);
  }

  async hangup(handle: CallHandle): Promise<void> {
    await this.request('/v2/end-call', { call_id: handle.externalId ?? handle.id });
  }
}
