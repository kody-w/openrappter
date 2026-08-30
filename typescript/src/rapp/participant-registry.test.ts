import { describe, expect, it, vi } from 'vitest';

import { buildChatEnvelope } from '../gateway/chat-envelope.js';
import type {
  EffectiveFeatures,
} from '../config/features.js';
import {
  ParticipantRegistry,
  ParticipantRegistryError,
} from './participant-registry.js';
import {
  RAPP_CHAT_PROTOCOL,
  RappParticipantIdentityDriftError,
  type RappParticipant,
  type RappParticipantDescriptor,
} from './participant.js';

const RAPPID_A = `rappid:@openrappter/alpha:${'a'.repeat(64)}`;
const RAPPID_B = `rappid:@openrappter/beta:${'b'.repeat(64)}`;
const LIVE_A = 'rapp-101-aaaaaaaaaaaaaaaa';
const LIVE_A_2 = 'rapp-202-bbbbbbbbbbbbbbbb';
const LIVE_B = 'rapp-303-cccccccccccccccc';

const FEATURES: EffectiveFeatures = {
  experimental: true,
  harnessAdapters: true,
  hermes: true,
  pi: true,
  grok: true,
  brainSurgeonGroupChat: true,
};

function descriptor(
  rappid: string,
  liveId: string,
  harness = 'openrappter',
): RappParticipantDescriptor {
  return {
    rappid,
    liveId,
    pid: Number(/^rapp-(\d+)-/.exec(liveId)?.[1]),
    harness: { name: harness },
    endpoint: `http://127.0.0.1:${Number(/^rapp-(\d+)-/.exec(liveId)?.[1])}`,
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
}

function participant(initial: RappParticipantDescriptor): RappParticipant & {
  current: RappParticipantDescriptor;
} {
  return {
    current: initial,
    get descriptor() {
      return this.current;
    },
    async status() {
      return {
        status: 'ok' as const,
        descriptor: this.current,
        checkedAt: '2026-08-30T20:00:00.000Z',
      };
    },
    async chat(request) {
      return buildChatEnvelope({
        content: `${this.current.harness?.name}: ${request.userInput}`,
        sessionId: request.sessionId ?? 'registry-test',
        model: 'test',
        extra: {
          rappid: this.current.rappid,
          live_id: this.current.liveId,
        },
      });
    },
  };
}

describe('ParticipantRegistry identity and routing', () => {
  it('keys logical participants by RAPPID and active processes by liveId', async () => {
    const registry = new ParticipantRegistry();
    await registry.register(participant(descriptor(RAPPID_A, LIVE_A)), {
      aliases: ['alpha', 'primary'],
    });

    expect(registry.get(RAPPID_A)?.rappid).toBe(RAPPID_A);
    expect(registry.getByLiveId(LIVE_A)?.rappid).toBe(RAPPID_A);
    expect(registry.resolveExplicit('PRIMARY', FEATURES).rappid).toBe(RAPPID_A);
    expect(registry.list(FEATURES)[0]).toMatchObject({
      rappid: RAPPID_A,
      liveId: LIVE_A,
      state: 'active',
      metadata: {
        aliases: ['alpha', 'primary'],
      },
    });
  });

  it('requires an explicit replacement for a new live binding', async () => {
    const registry = new ParticipantRegistry();
    await registry.register(participant(descriptor(RAPPID_A, LIVE_A)));

    await expect(
      registry.register(participant(descriptor(RAPPID_A, LIVE_A_2))),
    ).rejects.toMatchObject({
      code: 'PARTICIPANT_REPLACEMENT_REQUIRED',
    });

    await registry.replace(participant(descriptor(RAPPID_A, LIVE_A_2)));
    expect(registry.getByLiveId(LIVE_A)).toBeUndefined();
    expect(registry.getByLiveId(LIVE_A_2)?.rappid).toBe(RAPPID_A);
  });

  it('quarantines a participant when its stable or live identity drifts', async () => {
    const registry = new ParticipantRegistry();
    const drifting = participant(descriptor(RAPPID_A, LIVE_A));
    await registry.register(drifting);
    drifting.current = descriptor(RAPPID_B, LIVE_B);

    await expect(registry.status(RAPPID_A, FEATURES)).rejects.toBeInstanceOf(
      RappParticipantIdentityDriftError,
    );
    expect(registry.get(RAPPID_A)).toMatchObject({
      state: 'quarantined',
    });
    expect(registry.getByLiveId(LIVE_A)).toBeUndefined();
    expect(() => registry.resolveExplicit(RAPPID_A, FEATURES)).toThrow(
      expect.objectContaining({ code: 'PARTICIPANT_QUARANTINED' }),
    );
  });

  it('distinguishes disabled known participants from unknown IDs', async () => {
    const registry = new ParticipantRegistry();
    await registry.register(participant(descriptor(RAPPID_A, LIVE_A, 'hermes')), {
      feature: 'hermes',
      aliases: ['hermes'],
    });
    const disabled = { ...FEATURES, hermes: false };

    expect(() => registry.resolveExplicit('hermes', disabled)).toThrow(
      expect.objectContaining({ code: 'EXPERIMENTAL_FEATURE_DISABLED' }),
    );
    expect(() => registry.resolveExplicit('not-admitted', disabled)).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_PARTICIPANT' }),
    );
  });

  it('uses only the configured admitted default before Brainstem and local fallback', async () => {
    const brainstem = participant(descriptor(RAPPID_A, LIVE_A, 'brainstem'));
    const local = participant(descriptor(RAPPID_B, LIVE_B, 'openrappter'));
    const configured = participant(descriptor(
      `rappid:@openrappter/configured:${'c'.repeat(64)}`,
      'rapp-404-dddddddddddddddd',
      'configured',
    ));
    const hermes = participant(descriptor(
      `rappid:@openrappter/hermes:${'d'.repeat(64)}`,
      'rapp-505-eeeeeeeeeeeeeeee',
      'hermes',
    ));
    const registry = new ParticipantRegistry({
      brainstemFallback: brainstem,
      localFallback: local,
    });
    await registry.register(hermes, { aliases: ['hermes'], feature: 'hermes' });

    expect((await registry.resolveDefault(FEATURES)).source).toBe('brainstem');

    await registry.register(configured, { aliases: ['configured'] });
    registry.setConfiguredDefault('configured');
    expect((await registry.resolveDefault(FEATURES))).toMatchObject({
      source: 'configured-default',
      rappid: configured.descriptor.rappid,
    });

    registry.setConfiguredDefault(null);
    const brainstemStatus = vi.spyOn(brainstem, 'status')
      .mockRejectedValueOnce(new Error('offline'));
    expect((await registry.resolveDefault(FEATURES)).source).toBe('local');
    expect(brainstemStatus).toHaveBeenCalledOnce();
  });

  it('returns an actionable error after every default route is unavailable', async () => {
    const unavailable = participant(descriptor(RAPPID_A, LIVE_A));
    vi.spyOn(unavailable, 'status').mockRejectedValue(new Error('offline'));
    const registry = new ParticipantRegistry({
      brainstemFallback: unavailable,
      localFallback: unavailable,
    });

    await expect(registry.resolveDefault(FEATURES)).rejects.toEqual(
      expect.objectContaining<Partial<ParticipantRegistryError>>({
        code: 'PARTICIPANT_UNAVAILABLE',
        message: expect.stringContaining('Start Brainstem'),
      }),
    );
  });
});
