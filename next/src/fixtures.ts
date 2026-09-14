import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CopilotSession, SessionConfig } from '@github/copilot-sdk';
import {
  createFrameSigner, keyedIdentity, parseJson, selectSignaturePolicy, sha256, type JsonObject, type RegistryKey,
} from './canonical.js';
import type { RootSigner } from './bots.js';
import type { BrainstemBinding, BotInterpreter } from './spine.js';
import { object, text } from './contract.js';
import type { CopilotTransport } from './copilot.js';
import type { PrivateChannelPort } from './channel.js';
import { requireThat } from './errors.js';

export const FIXTURE_WARNING = 'Synthetic fixture adapters only: no live inference, private scanning, iMessage or external Brainstem execution.';

export async function readFixture(name: 'copilot-builder' | 'rapp-up' | 'recurring-work' | 'global-estate' | 'monorepo'): Promise<JsonObject> {
  return object(parseJson(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url))));
}

export function fixtureSigners(count = 2): { signers: RootSigner[]; registry: RegistryKey[]; signatures: ReturnType<typeof selectSignaturePolicy> } {
  requireThat(Number.isSafeInteger(count) && count > 0 && count <= 256, 'fixture', 'Choose a bounded positive fixture signer count.');
  const registry: RegistryKey[] = [];
  const names = ['builder', 'reviewer', ...Array.from({ length: Math.max(0, count - 2) },
    (_, index) => `capacity-${String(index + 3).padStart(3, '0')}`)].slice(0, count);
  const signers = names.map(name => {
    // Publicly reproducible test keys; never production credentials.
    const seed = Buffer.from(sha256(`PUBLIC-RAPP-WORK-NEXT-FIXTURE-${name}`), 'hex');
    const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(privateKey);
    const root = keyedIdentity('fixture', name, publicKey);
    registry.push({ kid: root, spki_der_b64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      revoked_utc: null, superseded_utc: null });
    return { root, signer: createFrameSigner({ kid: root, privateKey }) };
  });
  return { signers, registry, signatures: selectSignaturePolicy(registry) };
}

export class FixtureBrainstem implements BrainstemBinding {
  readonly available = true;
  readonly hotloads: string[] = [];
  readonly closes: string[] = [];
  async hotload(input: Parameters<BrainstemBinding['hotload']>[0]): Promise<BotInterpreter> {
    this.hotloads.push(input.root);
    requireThat(sha256(input.bytes) === input.capability.sha256, 'fixture-capability', 'Fixture bytes differ from the admitted capability.');
    return {
      root: input.root,
      publicResponse: async (request, provider) => {
        requireThat(request.root === input.root, 'root-isolation', 'A fixture interpreter cannot serve another root.');
        return provider.complete(request);
      },
      close: async () => { this.closes.push(input.root); },
    };
  }
}

export class FixtureCopilotTransport implements CopilotTransport {
  readonly configs: SessionConfig[] = [];
  readonly requests: JsonObject[] = [];
  disconnects = 0;
  aborts = 0;
  readonly responses: (JsonObject | Error)[] = [];
  unavailable = false;
  async createSession(config: SessionConfig): Promise<Pick<CopilotSession, 'sendAndWait' | 'abort' | 'disconnect'>> {
    this.configs.push(config);
    const sendAndWait = async (input: string | { prompt: string }) => {
      const request = object(parseJson(typeof input === 'string' ? input : input.prompt));
      this.requests.push(request);
      if (this.unavailable) throw new Error('fixture provider unavailable');
      let answer = this.responses.shift();
      if (answer instanceof Error) throw answer;
      if (!answer) answer = await this.#answer(request);
      return { type: 'assistant.message', data: { content: JSON.stringify(answer) } };
    };
    return {
      sendAndWait: sendAndWait as CopilotSession['sendAndWait'],
      abort: async () => { this.aborts++; },
      disconnect: async () => { this.disconnects++; },
    };
  }

  async #answer(request: JsonObject): Promise<JsonObject> {
    if (request.purpose === 'perspective') return {
      summary: 'Independent reviewer perspective: preserve native pointers and confirm bounded internal work before acting.',
      disagreements: ['Do not normalize the native stores into a new shared workspace database.'],
      unknowns: ['Live external Brainstem and channel permission bindings have not been established.'],
    };
    if (request.purpose === 'synthesis') return {
      summary: 'Two distinct public perspectives support a reviewed pointer-first plan; no external action is authorized.',
      disagreements: [], unknowns: [],
    };
    const thought = text(request.thought);
    if (/every monday|weekly/iu.test(thought)) return object((await readFixture('recurring-work')).draft);
    if (/rapp up/iu.test(thought)) {
      const context = object(request.canonicalContext);
      const discovery = (context.discovery as JsonObject[]).at(-1);
      requireThat(discovery, 'fixture-discovery', 'Record sanitized discovery evidence before RAPP Up.');
      const pointers = discovery.pointers as JsonObject[];
      return {
        summary: 'Establish one complete Local Projects world inside this bot, keeping every native provider shape as a pointer.',
        tradeoffs: ['Discovery is historical metadata, not current native-store truth or ownership.',
          'One visible bot and one Librarian remain; no native data is copied, normalized, mounted or modified.'],
        questions: [],
        actions: [
          { type: 'scope.create', scope: { id: 'local-projects', parent: 'local-estate', kind: 'world',
            name: 'Local Projects', description: 'Reviewed pointer federation of the discovered native AI estate.' } },
          ...pointers.map(p => ({ type: 'pointer.register', id: `native-${String(p.provider)}`, scope: 'local-projects',
            evidenceWave: String(object(discovery.source).frame_hash), pointerId: String(p.id) })),
        ],
      };
    }
    if (/external|send a message/iu.test(thought)) return {
      summary: 'Prepare a bounded message request, without sending it.',
      tradeoffs: ['Confirming organization only records this request. A second exact local approval is required to call an external adapter.'],
      questions: [],
      actions: [{ type: 'external.request', id: 'message-request', scope: 'tasks', operation: 'send-message',
        target: 'fixture-contact:operator', content: 'Synthetic reviewed update.' }],
    };
    return readFixture('copilot-builder');
  }
}

export class SyntheticIMessage implements PrivateChannelPort {
  readonly channel = 'imessage';
  readonly idempotentDelivery = true;
  available = false;
  readonly sent = new Map<string, { root: string; contactRef: string; text: string }>();
  async preflight(input: Parameters<PrivateChannelPort['preflight']>[0]): Promise<{ status: 'ready' | 'unavailable' | 'deferred' }> {
    return { status: input.signal.aborted ? 'deferred' : this.available ? 'ready' : 'unavailable' };
  }
  async send(input: Parameters<PrivateChannelPort['send']>[0]): Promise<{ receipt: string }> {
    requireThat(this.available && !input.signal.aborted, 'channel-unavailable', 'Synthetic outage or cancelled dispatch.');
    const previous = this.sent.get(input.deliveryId);
    if (previous) requireThat(previous.root === input.root && previous.contactRef === input.contactRef && previous.text === input.text,
      'channel-idempotency', 'A delivery ID cannot be rebound.');
    else this.sent.set(input.deliveryId, { root: input.root, contactRef: input.contactRef, text: input.text });
    return { receipt: `fixture:${input.deliveryId}` };
  }
  async verifyIncoming(envelope: unknown): Promise<{ contactRef: string; messageId: string; text: string }> {
    requireThat(this.available, 'channel-unavailable', 'Synthetic outage.');
    const value = object(envelope, ['contactRef', 'messageId', 'text', 'fixtureAuthenticated']);
    requireThat(value.fixtureAuthenticated === true, 'channel-authentication', 'Only synthetic authenticated fixture input is accepted.');
    return { contactRef: text(value.contactRef, 64), messageId: text(value.messageId, 200), text: text(value.text) };
  }
}
