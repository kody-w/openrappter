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
