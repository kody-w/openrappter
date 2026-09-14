import { bindMigrationAuthority, type MigrationAuthorityInput } from './migration-authority.js';
import type { MigrationPlan } from './migration-contract.js';
import { MigrationService } from './migration.js';
import { HeadlessRuntime, type RuntimeOptions } from './runtime.js';

export interface MigrationBootstrapOptions {
  directory: string;
  plan: MigrationPlan;
  approvalBytes: string;
  authority: MigrationAuthorityInput;
  capabilityHash: string;
  clock?: RuntimeOptions['clock'];
  migrationFault?: RuntimeOptions['migrationFault'];
}

export async function openMigrationService(options: MigrationBootstrapOptions): Promise<{
  runtime: HeadlessRuntime;
  service: MigrationService;
}> {
  const authority = await bindMigrationAuthority(options.plan, options.approvalBytes, options.authority);
  const runtime = await HeadlessRuntime.open({
    directory: options.directory,
    signatures: authority.signatures,
    signers: authority.signers,
    fixture: authority.mode === 'sanitized-fixture',
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.migrationFault ? { migrationFault: options.migrationFault } : {}),
  });
  return {
    runtime,
    service: new MigrationService(runtime.bots, {
      plan: options.plan, authority, capabilityHash: options.capabilityHash,
    }),
  };
}
