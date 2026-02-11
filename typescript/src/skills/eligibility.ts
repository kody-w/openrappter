/**
 * Skill Eligibility System
 * Checks whether a skill's requirements are satisfied (binaries, env vars, config, OS).
 */

import { execSync } from 'child_process';
import { platform } from 'os';

export type SkillEligibility = 'eligible' | 'blocked';

export interface SkillRequirements {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: string[];
}

export interface SkillMetadata {
  emoji?: string;
  skillKey?: string;
  primaryEnv?: string;
  os?: string[];
  requires?: SkillRequirements;
  install?: SkillInstallSpec[];
}

export interface SkillInstallSpec {
  id: string;
  kind: string;
  formula?: string;
  module?: string;
  bins?: string[];
  label: string;
}

export interface EligibilityResult {
  eligible: SkillEligibility;
  blocked: boolean;
  missing: string[];
}

/**
 * Check if a binary exists on $PATH
 */
export function hasBinary(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse the metadata.openclaw field from frontmatter.
 * Accepts either a pre-parsed object or a JSON/JSON5 string.
 */
export function resolveSkillMetadata(
  frontmatter: Record<string, unknown>
): SkillMetadata | null {
  const raw = frontmatter.metadata;
  if (!raw) return null;

  let metaObj: Record<string, unknown>;

  if (typeof raw === 'string') {
    try {
      metaObj = JSON.parse(raw);
    } catch {
      return null;
    }
  } else if (typeof raw === 'object' && raw !== null) {
    metaObj = raw as Record<string, unknown>;
  } else {
    return null;
  }

  // The openclaw key wraps the actual metadata
  const openclaw = (metaObj.openclaw ?? metaObj.openrappter ?? metaObj) as Record<string, unknown>;
  if (!openclaw || typeof openclaw !== 'object') return null;

  return {
    emoji: openclaw.emoji as string | undefined,
    skillKey: openclaw.skillKey as string | undefined,
    primaryEnv: openclaw.primaryEnv as string | undefined,
    os: openclaw.os as string[] | undefined,
    requires: openclaw.requires as SkillRequirements | undefined,
    install: openclaw.install as SkillInstallSpec[] | undefined,
  };
}

/**
 * Check whether a skill's requirements are met.
 *
 * @param metadata - Parsed skill metadata (from resolveSkillMetadata)
 * @param config - Optional config object for checking config key paths
 */
export function checkSkillEligibility(
  metadata: SkillMetadata | null,
  config?: Record<string, unknown>
): EligibilityResult {
  if (!metadata) {
    return { eligible: 'eligible', blocked: false, missing: [] };
  }

  const missing: string[] = [];

  // OS check
  if (metadata.os && metadata.os.length > 0) {
    const currentPlatform = platform();
    if (!metadata.os.includes(currentPlatform)) {
      missing.push(`os:${currentPlatform} (needs ${metadata.os.join('|')})`);
    }
  }

  const requires = metadata.requires;
  if (!requires) {
    return missing.length > 0
      ? { eligible: 'blocked', blocked: true, missing }
      : { eligible: 'eligible', blocked: false, missing: [] };
  }

  // Required binaries (all must exist)
  if (requires.bins) {
    for (const bin of requires.bins) {
      if (!hasBinary(bin)) {
        missing.push(`bin:${bin}`);
      }
    }
  }

  // Any binaries (at least one must exist)
  if (requires.anyBins && requires.anyBins.length > 0) {
    const hasAny = requires.anyBins.some((bin) => hasBinary(bin));
    if (!hasAny) {
      missing.push(`anyBin:${requires.anyBins.join('|')}`);
    }
  }

  // Environment variables
  if (requires.env) {
    for (const envVar of requires.env) {
      if (!process.env[envVar]) {
        missing.push(`env:${envVar}`);
      }
    }
  }

  // Config paths (dot-notation lookup)
  if (requires.config && config) {
    for (const configPath of requires.config) {
      if (!resolveConfigPath(config, configPath)) {
        missing.push(`config:${configPath}`);
      }
    }
  } else if (requires.config && !config) {
    for (const configPath of requires.config) {
      missing.push(`config:${configPath}`);
    }
  }

  return {
    eligible: missing.length === 0 ? 'eligible' : 'blocked',
    blocked: missing.length > 0,
    missing,
  };
}

/**
 * Resolve a dot-notation path in a config object.
 */
function resolveConfigPath(
  config: Record<string, unknown>,
  path: string
): unknown {
  const parts = path.split('.');
  let current: unknown = config;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Get install instructions for a skill's missing requirements
 */
export function getSkillInstallInstructions(
  metadata: SkillMetadata | null
): SkillInstallSpec[] {
  if (!metadata?.install) return [];
  return metadata.install;
}
