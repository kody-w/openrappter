/**
 * BrainstemAgent — ask the local brainstem from inside a chat turn.
 *
 * The brainstem is a separate process speaking `POST /chat`, and both runtimes
 * return the same frozen envelope (rapp-runtime-parity/1.0 §2.4). PR #226 gave a
 * person a dropdown to choose between them, and #229 gave the Python assistant
 * an agent so it could consult the brainstem itself.
 *
 * This is the TypeScript half. Without it the gap is not academic: the web UI
 * and the Bar both talk to this runtime, so the human could switch brains while
 * the assistant they were talking to could not — the useful case, "ask the
 * brainstem and tell me what it said", was the one that did not work.
 *
 * The transport is `gateway/brainstem-client.ts`, already used by `chat.send`
 * when a caller selects the brainstem. Reusing it means discovery, the
 * `user_input` spelling the RAPP kernel requires, envelope validation and
 * cancellation behave identically whether a person or the assistant is asking.
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';
import { askBrainstem, BRAINSTEM_CANDIDATE_URLS } from '../gateway/brainstem-client.js';

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/brainstem',
  version: '1.0.0',
  display_name: 'Brainstem',
  description: 'Asks the local brainstem a question and returns its reply, so a chat turn can consult the other brain without the operator switching.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: [
    'network'
  ],
  tags: [
    'openrappter',
    'brainstem'
  ],
  category: 'research',
  quality_tier: 'official',
  requires_env: []
} as const;

export class BrainstemAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Brainstem',
      description:
        'Ask the local brainstem a question and return its answer. Use this when the user asks what the brainstem knows or thinks, or when a question needs the agents and memory that live there rather than in this runtime.',
      parameters: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'The question to put to the brainstem.',
          },
          session_id: {
            type: 'string',
            description:
              'Optional conversation id, so follow-up questions continue the same brainstem session.',
          },
          base_url: {
            type: 'string',
            description:
              'Optional brainstem address, e.g. http://127.0.0.1:7071. Discovered automatically when omitted.',
          },
        },
        required: ['message'],
      },
    };
    super('Brainstem', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const message = String(kwargs.message ?? '').trim();
    if (!message) {
      return 'No question given. Pass `message` with what to ask the brainstem.';
    }

    const sessionId = String(kwargs.session_id ?? '').trim() || undefined;
    const baseUrl = String(kwargs.base_url ?? '').trim() || undefined;

    let envelope;
    try {
      envelope = await askBrainstem({ message, sessionId, baseUrl });
    } catch (error) {
      // The client already distinguishes "not running" from "answered badly"
      // and says which address it tried, so the message is returned as-is
      // rather than being rewritten into something vaguer.
      const detail = error instanceof Error ? error.message : String(error);
      return baseUrl
        ? detail
        : `${detail}\n\nAddresses tried: ${BRAINSTEM_CANDIDATE_URLS.join(', ')}.`;
    }

    const answer = envelope.response ?? '';
    const model = envelope.model || 'unreported';
    const source = baseUrl ?? 'the local brainstem';

    // Attribute the reply. A brainstem answer and this runtime's own answer are
    // the same shape, so an unlabelled one is indistinguishable from something
    // this assistant worked out itself.
    const lines = [`Brainstem (${source}, model ${model}):`, '', answer];
    if (envelope.session_id) {
      lines.push('', `session_id: ${envelope.session_id}`);
    }
    return lines.join('\n');
  }
}
