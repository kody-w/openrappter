export const ORGANISM_EGG_PROFILE = 'openrappter-organism-egg/1.0' as const;
export const RAPP_EGG_SCHEMA = 'rapp/1-egg' as const;

export type EggMode = 'portable' | 'sealed-backup';
export type ImportSemantics = 'restore' | 'clone';
export type PrivacyClass =
  | 'public-metadata'
  | 'private'
  | 'sensitive-encrypted';

export interface EggProvenance {
  origin: string;
  license: string;
  owned: boolean;
  generated?: boolean;
  generator?: string;
}

export interface OrganismEggFile {
  path: string;
  size: number;
  sha256: string;
  mime: string;
  dimension: string;
  privacy: PrivacyClass;
  provenance: EggProvenance;
}

export interface OrganismDimensions {
  agents: number;
  skills: number;
  memories: number;
  cronJobs: number;
  sessions: number;
  media: number;
  midi: number;
  files: number;
  bytes: number;
}

export interface OrganismEggManifest {
  profile: typeof ORGANISM_EGG_PROFILE;
  profileVersion: '1.0';
  mode: EggMode;
  source: {
    version: string;
    commit: string;
    ring: string;
    platform: NodeJS.Platform;
  };
  organismRappid: string;
  createdUtc: string;
  dimensions: OrganismDimensions;
  files: OrganismEggFile[];
  privacy: {
    default: 'private';
    includesHistory: boolean;
    includesMedia: boolean;
    exclusions: string[];
    reauthentication: string[];
  };
  requiredMigrations: string[];
  rootDigest: string;
}

export interface InventoryFile {
  path: string;
  bytes: Uint8Array;
  mime: string;
  dimension: string;
  privacy: PrivacyClass;
  provenance: EggProvenance;
  destination?: string;
}

export interface InventoryResult {
  rappid: string;
  files: InventoryFile[];
  dimensions: Omit<OrganismDimensions, 'files' | 'bytes'>;
  exclusions: string[];
  reauthentication: string[];
}

export interface EggPublicHeader {
  profile: typeof ORGANISM_EGG_PROFILE;
  mode: EggMode;
  organismRappid: string;
  createdUtc: string;
  rootDigest: string;
  dimensions: OrganismDimensions;
  privacy: OrganismEggManifest['privacy'];
  crypto?: {
    algorithm: 'aes-256-gcm';
    kdf: 'scrypt';
    salt: string;
    iv: string;
    tag: string;
    keyBytes: 32;
    N: number;
    r: number;
    p: number;
  };
}

export interface EggInspection {
  valid: true;
  sealed: boolean;
  header: EggPublicHeader;
  manifest?: OrganismEggManifest;
  files?: OrganismEggFile[];
  decrypted: boolean;
}

export interface EggDiffEntry {
  path: string;
  change: 'add' | 'remove' | 'replace' | 'unchanged';
  beforeSha256?: string;
  afterSha256?: string;
  sizeDelta: number;
}

export interface EggDiff {
  eggDigest: string;
  targetRappid: string;
  baseStateDigest: string;
  semantics: ImportSemantics;
  compatible: boolean;
  reauthentication: string[];
  entries: EggDiffEntry[];
  approvalBinding: string;
}

export interface EggStateAdapter {
  inventory(options: {
    mode?: EggMode;
    includeHistory: boolean;
    includeMedia: boolean;
    acknowledgeUnknownLicense: boolean;
    mediaPaths?: string[];
  }): Promise<InventoryResult>;
  apply(
    files: InventoryFile[],
    context: {
      semantics: ImportSemantics;
      sourceRappid: string;
      mode?: EggMode;
      includesHistory?: boolean;
      includesMedia?: boolean;
    },
  ): Promise<void>;
  healthProbe(): Promise<{ ok: boolean; detail: string }>;
}

export interface ExportEggOptions {
  mode: EggMode;
  output: string;
  passphrase?: string;
  includeHistory?: boolean;
  includeMedia?: boolean;
  acknowledgeUnknownLicense?: boolean;
  mediaPaths?: string[];
  createdUtc?: string;
  sourceVersion: string;
  sourceCommit: string;
  sourceRing: string;
  overwrite?: false;
}

export interface ImportEggOptions {
  eggPath: string;
  passphrase?: string;
  semantics: ImportSemantics;
  approval?: string;
  rollbackPassphrase?: string;
  apply: boolean;
}
