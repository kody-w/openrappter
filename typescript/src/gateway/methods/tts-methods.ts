/**
 * Text-to-Speech RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface TtsService {
  getStatus(): { enabled: boolean; provider: string | null };
  listProviders(): Array<{ id: string; name: string; available: boolean }>;
  enable(provider: string): Promise<void>;
  disable(): Promise<void>;
  convert(text: string, options?: Record<string, unknown>): Promise<Buffer>;
}

interface TtsMethodsDeps {
  ttsService?: TtsService;
}

export function registerTtsMethods(
  server: MethodRegistrar,
  deps?: TtsMethodsDeps
): void {
  server.registerMethod('tts.status', async () => {
    const service = deps?.ttsService;
    if (!service) return { enabled: false, provider: null };
    return service.getStatus();
  });

  server.registerMethod('tts.providers', async () => {
    const service = deps?.ttsService;
    if (!service) return { providers: [] };
    return { providers: service.listProviders() };
  });

  server.registerMethod<{ provider: string }, { success: boolean }>(
    'tts.enable',
    async (params) => {
      const service = deps?.ttsService;
      if (!service) throw new Error('TTS service not available');
      await service.enable(params.provider);
      return { success: true };
    }
  );

  server.registerMethod<void, { success: boolean }>('tts.disable', async () => {
    const service = deps?.ttsService;
    if (!service) throw new Error('TTS service not available');
    await service.disable();
    return { success: true };
  });

  server.registerMethod<
    { text: string; options?: Record<string, unknown> },
    { audio: string }
  >('tts.convert', async (params) => {
    const service = deps?.ttsService;
    if (!service) throw new Error('TTS service not available');
    const buffer = await service.convert(params.text, params.options);
    return { audio: buffer.toString('base64') };
  });
}
