/**
 * Channel management RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface ChannelRegistry {
  getStatusList(): Array<Record<string, unknown>>;
  connectChannel(type: string): Promise<void>;
  disconnectChannel(type: string): Promise<void>;
  probeChannel(type: string): Promise<{ ok: boolean; latencyMs: number }>;
  configureChannel(type: string, config: Record<string, unknown>): void;
  sendMessage?(params: {
    channelId: string;
    conversationId: string;
    content: string;
    replyTo?: string;
  }): Promise<{ sent: boolean }>;
}

interface ChannelsMethodsDeps {
  channelRegistry?: ChannelRegistry;
}

export function registerChannelsMethods(
  server: MethodRegistrar,
  deps?: ChannelsMethodsDeps
): void {
  server.registerMethod<void, Array<Record<string, unknown>>>(
    'channels.list',
    async () => {
      if (!deps?.channelRegistry) return [];
      return deps.channelRegistry.getStatusList();
    }
  );

  server.registerMethod<{ type: string }, { connected: boolean }>(
    'channels.connect',
    async (params) => {
      if (!deps?.channelRegistry) throw new Error('Channel registry not configured');
      await deps.channelRegistry.connectChannel(params.type);
      return { connected: true };
    }
  );

  server.registerMethod<{ type: string }, { disconnected: boolean }>(
    'channels.disconnect',
    async (params) => {
      if (!deps?.channelRegistry) throw new Error('Channel registry not configured');
      await deps.channelRegistry.disconnectChannel(params.type);
      return { disconnected: true };
    }
  );

  server.registerMethod<{ type: string }, { ok: boolean; latencyMs: number }>(
    'channels.probe',
    async (params) => {
      if (!deps?.channelRegistry) throw new Error('Channel registry not configured');
      return deps.channelRegistry.probeChannel(params.type);
    }
  );

  server.registerMethod<
    { type: string; config: Record<string, unknown> },
    { configured: boolean }
  >(
    'channels.configure',
    async (params) => {
      if (!deps?.channelRegistry) throw new Error('Channel registry not configured');
      deps.channelRegistry.configureChannel(params.type, params.config);
      return { configured: true };
    }
  );

  server.registerMethod<
    { channelId: string; conversationId: string; content: string; replyTo?: string },
    { sent: boolean }
  >(
    'channels.send',
    async (params) => {
      if (!deps?.channelRegistry) throw new Error('Channel registry not configured');
      if (!deps.channelRegistry.sendMessage) {
        throw new Error('Channel registry does not support sendMessage');
      }
      return deps.channelRegistry.sendMessage(params);
    }
  );
}
