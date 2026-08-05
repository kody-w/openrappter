/**
 * Say something to a neighbour, from inside a running rappter.
 *
 * The architecture: "through a neighborhood they **all interact** over /twin
 * and /chat, and none of them can tell whether a peer is a rappter, a
 * brainstem, or a person."
 *
 * They did not interact. A human did it for them. `sendTwin` had exactly one
 * caller — `twin/cli.ts` — so every exchange happened because someone typed
 * `openrappter twin say`. Asked directly, the alpha said so itself:
 *
 *   Q: can you send another rappter or the brainstem a message right now?
 *   A: "No, I cannot ... I can check their status, list their agents, or
 *       delegate tasks, but not initiate direct messages."
 *
 * That is #100 one level up: that issue was "a rappter can be spoken to and
 * cannot speak", and its fix gave the HUMAN a sender. #126
 *
 * WHY THIS DELEGATES RATHER THAN IMPLEMENTS
 *
 * It calls the same `sendTwin` the CLI calls, so the /twin-then-/chat fallback
 * (#125), the `console` refusal, the rappid handling and the wire labelling all
 * come along instead of being written a second time. Every recurring defect of
 * this mandate has been two derivations of one thing drifting apart — the port
 * against the lock (#101/#111), the roster against the sender (#107/#118), one
 * route at a time (#113/#119), an alias around the registry (#121). A second
 * way to contact a peer would be the next one.
 *
 * WHY A NAME AND NEVER A URL
 *
 * With the #125 fallback, an agent taking a URL would hand a model a general
 * HTTP POST primitive, which is an SSRF vector — #84 is already open about DNS
 * rebinding here. Names resolve through the roster to loopback ports on this
 * device, which is the whole neighborhood the architecture describes.
 *
 * This is not the #122 mouth question. A neighbour is a peer on this machine,
 * not a single-owner outbound resource like the phone line or the owner's
 * Google Voice number.
 */

import { BasicAgent } from './BasicAgent.js';
import type { AgentMetadata } from './types.js';

export const __manifest__ = {
  schema: 'rapp-agent/1.0',
  name: '@openrappter/neighbor',
  version: '1.0.0',
  display_name: 'Neighbor',
  description: 'Say something to another rappter or brainstem on this device.',
  author: 'Kody Wildfeuer',
  ring: 'ga',
  capabilities: ['network'],
  tags: ['openrappter', 'neighborhood', 'twin'],
  category: 'neighborhood',
  quality_tier: 'official',
  requires_env: [],
} as const;

/** The brainstem's well-known port. It does not appear in the rappter roster. */
const BRAINSTEM_PORT = 7071;

export class NeighborAgent extends BasicAgent {
  constructor() {
    const metadata: AgentMetadata = {
      name: 'Neighbor',
      description:
        'Say something to another rappter or the brainstem on this device, and get '
        + 'their reply. Use `list` to see who is reachable. Peers are addressed by '
        + 'name — never by URL.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'What to do.',
            enum: ['list', 'say'],
          },
          to: {
            type: 'string',
            description:
              "Who to say it to: a hatched twin's name, 'alpha', or 'brainstem'. "
              + 'Run `list` first if unsure.',
          },
          text: { type: 'string', description: 'What to say.' },
        },
        required: ['action'],
      },
    };
    super('Neighbor', metadata);
  }

  async perform(kwargs: Record<string, unknown>): Promise<string> {
    const action = typeof kwargs.action === 'string' ? kwargs.action : 'list';

    try {
      if (action === 'list') return await this.list();
      if (action === 'say') return await this.say(kwargs);
      return JSON.stringify({ status: 'error', message: `Unsupported action: ${action}` });
    } catch (error) {
      return JSON.stringify({ status: 'error', message: (error as Error).message });
    }
  }

  private async list(): Promise<string> {
    const { listRappters } = await import('../infra/roster.js');
    const rows = await listRappters();
    const reachable = rows
      .filter((r) => r.running)
      .map((r) => ({ name: r.name, port: r.port }));

    // The brainstem is a neighbour and is not a rappter, so the roster does not
    // know about it. Report it only if it actually answers — a name offered
    // here that cannot be reached is worse than one omitted.
    if (await this.brainstemAnswers()) {
      reachable.push({ name: 'brainstem', port: BRAINSTEM_PORT });
    }

    return JSON.stringify({ status: 'success', action: 'list', reachable });
  }

  private async say(kwargs: Record<string, unknown>): Promise<string> {
    const to = typeof kwargs.to === 'string' ? kwargs.to.trim() : '';
    const text = typeof kwargs.text === 'string' ? kwargs.text : '';
    if (!to) return JSON.stringify({ status: 'error', message: 'say requires `to`' });
    if (!text.trim()) return JSON.stringify({ status: 'error', message: 'say requires `text`' });

    // A URL is refused rather than resolved. See the header: this must not
    // become a general HTTP POST primitive.
    if (/^[a-z]+:\/\//i.test(to) || to.includes('/')) {
      return JSON.stringify({
        status: 'error',
        message: 'Address a neighbour by name, not by URL. Use `list` to see who is reachable.',
      });
    }

    const url = await this.resolve(to);
    if (!url) {
      return JSON.stringify({
        status: 'error',
        message: `No neighbour named "${to}" is running on this device. Use \`list\`.`,
      });
    }

    const { deviceRappid, sendTwin } = await import('../twin/send.js');
    const { canonicalInstanceKey } = await import('../infra/gateway-lock.js');
    const slug = canonicalInstanceKey(to);

    const out = await sendTwin({
      to: url,
      fromRappid: deviceRappid('kody-w', 'alpha'),
      toRappid: deviceRappid('kody-w', slug),
      text,
    });

    if (out.status === 200 && out.said) {
      return JSON.stringify({
        status: 'success',
        action: 'say',
        to: slug,
        // Which wire answered. A /chat reply carries no rappid, so saying
        // otherwise would claim an identity exchange that did not happen. #125
        wire: out.wire,
        said: out.said,
      });
    }

    return JSON.stringify({
      status: 'error',
      action: 'say',
      to: slug,
      peer_status: out.status,
      // A refusal is information; never dress it up as a reply.
      detail: out.rawBody ?? out.body,
    });
  }

  /** A neighbour's loopback URL, or undefined when nothing of that name runs. */
  private async resolve(to: string): Promise<string | undefined> {
    if (to.toLowerCase() === 'brainstem') {
      return (await this.brainstemAnswers())
        ? `http://127.0.0.1:${BRAINSTEM_PORT}`
        : undefined;
    }
    const { listRappters } = await import('../infra/roster.js');
    const { canonicalInstanceKey } = await import('../infra/gateway-lock.js');
    const name = canonicalInstanceKey(to);
    const peer = (await listRappters()).find(
      (r) => r.running && (r.name === name || (name === 'alpha' && r.isAlpha)),
    );
    return peer ? `http://127.0.0.1:${peer.port}` : undefined;
  }

  private async brainstemAnswers(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(`http://127.0.0.1:${BRAINSTEM_PORT}/version`, {
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      return res.ok;
    } catch {
      return false;
    }
  }
}
