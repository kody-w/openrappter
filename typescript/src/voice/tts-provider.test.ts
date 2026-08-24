import { describe, expect, it, vi } from 'vitest';
import { TTSService, createTTSService } from './tts.js';
import type { TTSProvider } from './types.js';

function provider(name: string, outcome: 'success' | 'error'): TTSProvider {
  return {
    name,
    isAvailable: async () => true,
    getVoices: async () => [{ id: `${name}-voice`, name, language: 'en' }],
    synthesize: vi.fn(async () => {
      if (outcome === 'error') throw new Error(`${name} failed`);
      return Buffer.from(name);
    }),
  };
}

describe('TTS provider registration and fallback', () => {
  it('does not register ElevenLabs without a secure credential callback', async () => {
    const service = createTTSService({ useEdge: false });
    expect(await service.getVoices()).toEqual([]);
  });

  it('registers ElevenLabs only through the provider abstraction', async () => {
    const fetchImpl = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/v1/user/subscription') {
        return new Response(JSON.stringify({ character_count: 0, character_limit: 100 }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path === '/v1/voices') {
        return new Response(JSON.stringify({
          voices: [{ voice_id: 'voice_123', name: 'Voice', labels: { language: 'en' } }],
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify([{
        model_id: 'eleven_flash_v2_5',
        name: 'Flash',
        can_do_text_to_speech: true,
      }]), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const service = createTTSService({
      useEdge: false,
      elevenlabs: {
        getApiKey: async () => `sk_${'d'.repeat(40)}`,
        fetchImpl,
      },
    });
    expect((await service.getVoices()).map((voice) => voice.provider)).toEqual(['elevenlabs']);
  });

  it('falls back to an existing local provider after an optional provider fails', async () => {
    const service = new TTSService();
    const remote = provider('elevenlabs', 'error');
    const local = provider('local', 'success');
    service.addProvider(remote);
    service.addProvider(local);
    service.selectProvider('elevenlabs');
    await expect(service.synthesize('assistant output')).resolves.toEqual(Buffer.from('local'));
    expect(remote.synthesize).toHaveBeenCalledTimes(1);
    expect(local.synthesize).toHaveBeenCalledTimes(1);
  });

  it('does not fall back when the caller explicitly disables fallback', async () => {
    const service = new TTSService();
    service.addProvider(provider('elevenlabs', 'error'));
    service.addProvider(provider('local', 'success'));
    await expect(service.synthesize('assistant output', {
      provider: 'elevenlabs',
      fallback: false,
    })).rejects.toThrow('elevenlabs failed');
  });
});
