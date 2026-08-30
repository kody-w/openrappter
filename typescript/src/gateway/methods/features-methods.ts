import {
  getEffectiveFeatures,
  getFeatureReleaseMatrix,
  type EffectiveFeatures,
  type FeatureReleaseMatrix,
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
  const loadConfig = (): unknown => {
    try {
      return deps?.loadConfig?.();
    } catch {
      return undefined;
    }
  };

  server.registerMethod<void, EffectiveFeatures>('features.get', async () => {
    return getEffectiveFeatures(loadConfig());
  });

  server.registerMethod<void, FeatureReleaseMatrix>('features.status', async () => {
    return getFeatureReleaseMatrix(loadConfig());
  });
}
