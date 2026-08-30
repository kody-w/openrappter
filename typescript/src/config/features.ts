/**
 * Effective experimental feature gates.
 *
 * This helper deliberately reads unknown input rather than relying on parsed
 * defaults. A malformed, missing, or partially configured gate must fail
 * closed, and only the literal boolean `true` enables a feature.
 */

export interface EffectiveFeatures {
  experimental: boolean;
  harnessAdapters: boolean;
  hermes: boolean;
  pi: boolean;
  brainSurgeonGroupChat: boolean;
}

export const FEATURE_PROMOTION_ORDER = [
  'frontier-experimental',
  'frontier',
  'brainstem-experimental',
  'grail-stable',
] as const;

export type FeatureMaturity = (typeof FEATURE_PROMOTION_ORDER)[number];
export type PromotableFeature =
  | 'hermes'
  | 'pi'
  | 'brainSurgeonGroupChat';

export interface FeatureReleaseMetadata {
  configPath: string;
  maturity: FeatureMaturity;
  defaultEnabled: boolean;
}

export const FEATURE_RELEASE_METADATA = {
  hermes: {
    configPath: 'experimental.harnessAdapters.hermes',
    maturity: 'frontier-experimental',
    defaultEnabled: false,
  },
  pi: {
    configPath: 'experimental.harnessAdapters.pi',
    maturity: 'frontier-experimental',
    defaultEnabled: false,
  },
  brainSurgeonGroupChat: {
    configPath: 'experimental.brainSurgeonGroupChat.enabled',
    maturity: 'frontier-experimental',
    defaultEnabled: false,
  },
} as const satisfies Record<PromotableFeature, FeatureReleaseMetadata>;

export interface FeatureReleaseStatus extends FeatureReleaseMetadata {
  id: PromotableFeature;
  enabled: boolean;
}

export interface FeatureConfigEvidence {
  configHash: string | null;
  configValid: boolean;
}

export interface FeatureReleaseMatrix {
  evidence: FeatureConfigEvidence;
  promotionOrder: FeatureMaturity[];
  features: FeatureReleaseStatus[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function getEffectiveFeatures(config: unknown): EffectiveFeatures {
  const root = record(config);
  const experimental = record(root?.experimental);
  const experimentalEnabled = experimental?.enabled === true;
  const harnessAdapters = record(experimental?.harnessAdapters);
  const harnessAdaptersEnabled =
    experimentalEnabled && harnessAdapters?.enabled === true;
  const brainSurgeonGroupChat = record(experimental?.brainSurgeonGroupChat);

  return {
    experimental: experimentalEnabled,
    harnessAdapters: harnessAdaptersEnabled,
    hermes: harnessAdaptersEnabled && harnessAdapters?.hermes === true,
    pi: harnessAdaptersEnabled && harnessAdapters?.pi === true,
    brainSurgeonGroupChat:
      experimentalEnabled && brainSurgeonGroupChat?.enabled === true,
  };
}

export function getFeatureReleaseMatrix(
  config: unknown,
  evidence: FeatureConfigEvidence = {
    configHash: null,
    configValid: true,
  },
): FeatureReleaseMatrix {
  const effective = getEffectiveFeatures(config);
  const featureIds: PromotableFeature[] = [
    'hermes',
    'pi',
    'brainSurgeonGroupChat',
  ];

  return {
    evidence: { ...evidence },
    promotionOrder: [...FEATURE_PROMOTION_ORDER],
    features: featureIds.map(id => ({
      id,
      ...FEATURE_RELEASE_METADATA[id],
      enabled: effective[id],
    })),
  };
}
