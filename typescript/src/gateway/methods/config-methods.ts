/**
 * Configuration RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

// Mock config schema for demonstration
const configSchema = {
  type: 'object',
  properties: {
    server: {
      type: 'object',
      properties: {
        port: { type: 'number', minimum: 1024, maximum: 65535 },
        host: { type: 'string' },
        tls: { type: 'boolean' },
      },
    },
    agents: {
      type: 'object',
      properties: {
        maxConcurrent: { type: 'number', minimum: 1 },
        timeout: { type: 'number', minimum: 1000 },
      },
    },
    providers: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: {
          apiKey: { type: 'string' },
          baseUrl: { type: 'string', format: 'uri' },
          enabled: { type: 'boolean' },
        },
      },
    },
  },
};

// In-memory config store (in real implementation, would use ConfigManager)
let currentConfig: Record<string, unknown> = {
  server: { port: 3000, host: '127.0.0.1', tls: false },
  agents: { maxConcurrent: 10, timeout: 30000 },
  providers: {},
};

export function registerConfigMethods(server: MethodRegistrar): void {
  server.registerMethod<
    { updates: Record<string, unknown> },
    { success: boolean; config: Record<string, unknown> }
  >('config.patch', async (params) => {
    const { updates } = params;

    // Merge updates into current config (shallow merge for demo)
    currentConfig = {
      ...currentConfig,
      ...updates,
    };

    return {
      success: true,
      config: currentConfig,
    };
  });

  server.registerMethod<void, { schema: unknown }>('config.schema', async () => {
    return { schema: configSchema };
  });
}
