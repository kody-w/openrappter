export interface ValidatedMigrationPlan {
  readonly schema: 'rapp-work.import-plan/v1';
  readonly mode: 'review-only';
  readonly authoritative: false;
  readonly requiresAuthorization: true;
  readonly target: { readonly agentId: string; readonly workspaceId: string };
  readonly sourceDisposition: 'leave-unchanged';
  readonly items: readonly {
    readonly recordId: string;
    readonly targetPath: string;
    readonly content: string;
    readonly sha256: string;
    readonly proposedEvent: {
      readonly type: 'migration.import.proposed';
      readonly sourceHash: string;
      readonly sourceModifiedAt: string;
      readonly plannedAt: string;
      readonly targetPath: string;
      readonly artifactHash: string;
      readonly kind: 'agent' | 'task' | 'memory';
      readonly reviewRequired: true;
    };
  }[];
}
export function validateMigrationPlan(input: unknown): ValidatedMigrationPlan;
export function verifySelectedImport(input: unknown, selectedSources: Map<string, Uint8Array>): ValidatedMigrationPlan;
export function readMigrationPlan(filename: string): Promise<ValidatedMigrationPlan>;
