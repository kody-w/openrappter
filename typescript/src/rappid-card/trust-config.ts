import { lstat, readFile } from 'node:fs/promises';

import { CardTrustStore, rappidValid } from './contract.js';

export const RAPPID_CARD_TRUST_CONFIG_SCHEMA =
  'openrappter-rappid-card-trust/1';
export const RAPPID_CARD_TRUST_CONFIG_ENV =
  'OPENRAPPTER_RAPPID_CARD_TRUST_CONFIG';

export interface RappidCardTrustConfig {
  schema: typeof RAPPID_CARD_TRUST_CONFIG_SCHEMA;
  runtime_policy_authority: string;
  keys: Array<{ kid: string; spki_der_b64: string }>;
}

export async function loadRappidCardTrustConfig(
  explicitPath?: string,
): Promise<{
  path: string;
  config: RappidCardTrustConfig;
  trust: CardTrustStore;
}> {
  const path = explicitPath ?? process.env[RAPPID_CARD_TRUST_CONFIG_ENV];
  if (!path) {
    throw new Error(
      `production trust config unavailable; pass --trust-config or set ${RAPPID_CARD_TRUST_CONFIG_ENV}`,
    );
  }
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error('production trust config must be a regular non-symlink file');
  }
  if ((status.mode & 0o077) !== 0) {
    throw new Error('production trust config permissions must be mode 0600');
  }
  const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (
    raw === null
    || typeof raw !== 'object'
    || Array.isArray(raw)
    || Object.keys(raw).sort().join(',')
      !== 'keys,runtime_policy_authority,schema'
  ) {
    throw new Error('production trust config has the wrong closed schema');
  }
  const config = raw as RappidCardTrustConfig;
  if (
    config.schema !== RAPPID_CARD_TRUST_CONFIG_SCHEMA
    || !rappidValid(config.runtime_policy_authority)
    || !Array.isArray(config.keys)
    || config.keys.length === 0
  ) {
    throw new Error('production trust config is invalid');
  }
  const keys: Record<string, Buffer> = {};
  for (const entry of config.keys) {
    if (
      entry === null
      || typeof entry !== 'object'
      || Object.keys(entry).sort().join(',') !== 'kid,spki_der_b64'
      || !rappidValid(entry.kid)
      || typeof entry.spki_der_b64 !== 'string'
    ) {
      throw new Error('production trust config key entry is invalid');
    }
    if (keys[entry.kid]) throw new Error('production trust config contains a duplicate key');
    keys[entry.kid] = Buffer.from(entry.spki_der_b64, 'base64');
  }
  return {
    path,
    config,
    trust: new CardTrustStore(keys, config.runtime_policy_authority),
  };
}
