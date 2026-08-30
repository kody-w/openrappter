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
  grok: boolean;
  brainSurgeonGroupChat: boolean;
}

export const FEATURE_PROMOTION_ORDER = [
  'frontier-experimental',
  'frontier',
  'brainstem-experimental',
  'brainstem-regular',
] as const;

export type FeatureMaturity = (typeof FEATURE_PROMOTION_ORDER)[number];
export const FEATURE_RING_ORDER = [
  'canary',
  'nightly',
  'alpha',
  'beta',
  'grail',
] as const;
export type FeatureReleaseRing = (typeof FEATURE_RING_ORDER)[number];
export type FeatureReleaseNode =
  `${FeatureMaturity}:${FeatureReleaseRing}`;
export type PromotableFeature =
  | 'hermes'
  | 'pi'
  | 'grok'
  | 'brainSurgeonGroupChat';
export type FeatureBlockingGate =
  | 'experimental.enabled'
  | 'experimental.harnessAdapters.enabled';

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
  grok: {
    configPath: 'experimental.harnessAdapters.grok',
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
  requested: boolean;
  enabled: boolean;
  blockedBy: FeatureBlockingGate[];
}

export interface FeatureConfigEvidence {
  configHash: string | null;
  configValid: boolean;
}

export interface FeatureTrackLattice {
  id: FeatureMaturity;
  ringOrder: FeatureReleaseRing[];
}

export interface FeatureCrossTrackEdge {
  from: FeatureReleaseNode;
  to: FeatureReleaseNode;
}

export interface FeatureReleaseMatrix {
  evidence: FeatureConfigEvidence;
  promotionOrder: FeatureMaturity[];
  tracks: FeatureTrackLattice[];
  crossTrackEdges: FeatureCrossTrackEdge[];
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
    grok: harnessAdaptersEnabled && harnessAdapters?.grok === true,
    brainSurgeonGroupChat:
      experimentalEnabled && brainSurgeonGroupChat?.enabled === true,
  };
}

export function getFeatureGateStatus(
  config: unknown,
): Record<
  PromotableFeature,
  {
    requested: boolean;
    enabled: boolean;
    blockedBy: FeatureBlockingGate[];
  }
> {
  const root = record(config);
  const experimental = record(root?.experimental);
  const harnessAdapters = record(experimental?.harnessAdapters);
  const group = record(experimental?.brainSurgeonGroupChat);
  const experimentalEnabled = experimental?.enabled === true;
  const harnessEnabled = harnessAdapters?.enabled === true;
  const effective = getEffectiveFeatures(config);

  const adapterStatus = (
    feature: 'hermes' | 'pi' | 'grok',
  ): {
    requested: boolean;
    enabled: boolean;
    blockedBy: FeatureBlockingGate[];
  } => {
    const requested = harnessAdapters?.[feature] === true;
    const blockedBy: FeatureBlockingGate[] = [];
    if (requested && !experimentalEnabled) {
      blockedBy.push('experimental.enabled');
    }
    if (requested && !harnessEnabled) {
      blockedBy.push('experimental.harnessAdapters.enabled');
    }
    return {
      requested,
      enabled: effective[feature],
      blockedBy,
    };
  };

  const groupRequested = group?.enabled === true;
  return {
    hermes: adapterStatus('hermes'),
    pi: adapterStatus('pi'),
    grok: adapterStatus('grok'),
    brainSurgeonGroupChat: {
      requested: groupRequested,
      enabled: effective.brainSurgeonGroupChat,
      blockedBy:
        groupRequested && !experimentalEnabled
          ? ['experimental.enabled']
          : [],
    },
  };
}

export function getFeatureReleaseMatrix(
  config: unknown,
  evidence: FeatureConfigEvidence = {
    configHash: null,
    configValid: true,
  },
): FeatureReleaseMatrix {
  const gateStatus = getFeatureGateStatus(config);
  const featureIds: PromotableFeature[] = [
    'hermes',
    'pi',
    'grok',
    'brainSurgeonGroupChat',
  ];
  const promotionOrder = [...FEATURE_PROMOTION_ORDER];
  const tracks = promotionOrder.map(id => ({
    id,
    ringOrder: [...FEATURE_RING_ORDER],
  }));
  const crossTrackEdges = promotionOrder.slice(0, -1).map((track, index) => ({
    from: `${track}:grail` as FeatureReleaseNode,
    to: `${promotionOrder[index + 1]}:canary` as FeatureReleaseNode,
  }));

  return {
    evidence: { ...evidence },
    promotionOrder,
    tracks,
    crossTrackEdges,
    features: featureIds.map(id => ({
      id,
      ...FEATURE_RELEASE_METADATA[id],
      ...gateStatus[id],
    })),
  };
}
