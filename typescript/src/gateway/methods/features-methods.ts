import {
  getEffectiveFeatures,
  type EffectiveFeatures,
} from '../../config/features.js';

interface MethodRegistrar {
  registerMethod<P = unknown, R = unknown>(
    name: string,
    handler: (params: P, connection: unknown) => Promise<R>,
    options?: { requiresAuth?: boolean },
  ): void;
}

export interface FeaturesMethodsDeps {
  loadConfig?: () => unknown;
}

export function registerFeaturesMethods(
  server: MethodRegistrar,
  deps?: FeaturesMethodsDeps,
): void {
  server.registerMethod<void, EffectiveFeatures>('features.get', async () => {
    try {
      return getEffectiveFeatures(deps?.loadConfig?.());
    } catch {
      return getEffectiveFeatures(undefined);
    }
  });
}
