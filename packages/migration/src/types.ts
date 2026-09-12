export type LegacyKind = "agent" | "task" | "memory";
export type InertValue = null | boolean | number | string | readonly InertValue[] | { readonly [key: string]: InertValue };

export interface LegacySource {
  readonly id: string;
  readonly root: string;
  readonly relativePath: string;
  readonly format: "json" | "jsonl";
  readonly kind: LegacyKind;
}

export interface InertLegacyReaderPort {
  /** Only called by an explicit migration inventory operation. */
  discover(roots: readonly string[]): Promise<readonly LegacySource[]>;
  read(source: LegacySource, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly modifiedAt: string }>;
}

export interface InventoryFile {
  readonly source: LegacySource;
  readonly status: "reviewable" | "rejected" | "unreadable";
  readonly sourceHash?: string;
  readonly modifiedAt?: string;
  readonly reason?: string;
}

export interface ReviewRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceHash: string;
  readonly sourceModifiedAt: string;
  readonly index: number;
  readonly kind: LegacyKind;
  readonly data: Readonly<Record<string, InertValue>>;
  readonly warnings: readonly string[];
}

export interface MigrationInventory {
  readonly schema: "rapp-work.migration-inventory/v1";
  readonly authoritative: false;
  readonly files: readonly InventoryFile[];
  readonly records: readonly ReviewRecord[];
}

export interface ImportPlanItem {
  readonly recordId: string;
  readonly targetPath: string;
  readonly content: string;
  readonly sha256: string;
  readonly proposedEvent: Readonly<Record<string, InertValue>>;
}

export interface ImportPlan {
  readonly schema: "rapp-work.import-plan/v1";
  readonly mode: "review-only";
  readonly authoritative: false;
  readonly requiresAuthorization: true;
  readonly target: { readonly agentId: string; readonly workspaceId: string };
  readonly items: readonly ImportPlanItem[];
  readonly sourceDisposition: "leave-unchanged";
}

export class MigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MigrationError";
  }
}
