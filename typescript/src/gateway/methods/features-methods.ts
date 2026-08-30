import {
  getEffectiveFeatures,
  getFeatureReleaseMatrix,
  type EffectiveFeatures,
  type FeatureConfigEvidence,
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
  loadFeatureConfig?: () => {
    config: unknown;
    evidence: FeatureConfigEvidence;
  };
}

export function registerFeaturesMethods(
  server: MethodRegistrar,
  deps?: FeaturesMethodsDeps,
): void {
  const loadConfig = (): {
    config: unknown;
    evidence: FeatureConfigEvidence;
  } => {
    try {
      return deps?.loadFeatureConfig?.() ?? {
        config: undefined,
        evidence: {
          configHash: null,
          configValid: false,
        },
      };
    } catch {
      return {
        config: undefined,
        evidence: {
          configHash: null,
          configValid: false,
        },
      };
    }
  };

  server.registerMethod<void, EffectiveFeatures>('features.get', async () => {
    return getEffectiveFeatures(loadConfig().config);
  });

  server.registerMethod<void, FeatureReleaseMatrix>('features.status', async () => {
    const snapshot = loadConfig();
    return getFeatureReleaseMatrix(snapshot.config, snapshot.evidence);
  });
}
