/**
 * Models-related RPC methods
 */

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean }
  ): void;
}

interface ProviderRegistry {
  list(): string[];
  listProviders(): Array<{
    id: string;
    type: string;
    models: string[];
    status: 'ready' | 'error' | 'disabled';
  }>;
}

interface ModelsMethodsDeps {
  providerRegistry?: ProviderRegistry;
}

interface ModelInfo {
  id: string;
  provider: string;
  type: string;
  status: 'ready' | 'error' | 'disabled';
}

export function registerModelsMethods(
  server: MethodRegistrar,
  deps?: ModelsMethodsDeps
): void {
  // List all available models
  server.registerMethod<void, { models: ModelInfo[] }>(
    'models.list',
    async () => {
      const registry = deps?.providerRegistry;

      if (!registry) {
        return { models: [] };
      }

      const providers = registry.listProviders();
      const models: ModelInfo[] = [];

      for (const provider of providers) {
        for (const modelId of provider.models) {
          models.push({
            id: modelId,
            provider: provider.id,
            type: provider.type,
            status: provider.status,
          });
        }
      }

      return { models };
    }
  );
}
