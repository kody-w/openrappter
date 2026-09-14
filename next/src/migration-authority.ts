import {
  buildFrame, canonicalJson, contentHash, isBodyStream, selectSignaturePolicy, signerOf,
  type JsonObject, type RappFrame, type RegistryKey, type SignaturePolicy,
} from './canonical.js';
import type { RootSigner } from './bots.js';
import { object } from './contract.js';
import { Refusal, requireThat } from './errors.js';
import {
  migrationPlan, migrationStream, verifyMigrationApproval, type MigrationPlan,
} from './migration-contract.js';

export const CONTROLLED_MIGRATION_AUTHORITY_SCHEMA = 'rapp-work.controlled-migration-authority/1';
export const CONTROLLED_MIGRATION_HIVE_SCHEMA = 'rapp-work.controlled-migration-hive/1';

export interface ControlledMigrationAuthorityRequest {
  readonly plan: MigrationPlan;
  readonly approval: RappFrame;
  readonly owner: string;
  readonly planHash: string;
  readonly approvalWave: string;
  readonly registryCommitment: string;
  readonly closureCommitment: string;
  readonly rootSelection: readonly string[];
}

export interface ControlledMigrationAuthorityPort {
  verify(input: ControlledMigrationAuthorityRequest): Promise<unknown>;
}

export interface MigrationAuthorityInput {
  readonly registry: readonly RegistryKey[];
  readonly signers: readonly RootSigner[];
  readonly controlledLocal?: ControlledMigrationAuthorityPort;
}

declare const migrationAuthorityBrand: unique symbol;
export interface BoundMigrationAuthority {
  readonly [migrationAuthorityBrand]: true;
  readonly mode: MigrationPlan['mode'];
  readonly planHash: string;
  readonly approval: RappFrame;
  readonly signatures: SignaturePolicy;
  readonly signers: readonly RootSigner[];
  readonly evidence: JsonObject;
}

const bindings = new WeakSet<object>();
const HASH = /^[0-9a-f]{64}$/u;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

function hash(value: unknown, code: string, message: string): string {
  requireThat(typeof value === 'string' && HASH.test(value), code, message);
  return value;
}

export function migrationClosureCommitment(plan: MigrationPlan): string {
  return contentHash({ roots: plan.roots, items: plan.items });
}

function registryPolicy(plan: MigrationPlan, input: MigrationAuthorityInput): {
  registry: readonly RegistryKey[];
  signatures: SignaturePolicy;
  registryCommitment: string;
} {
  requireThat(Array.isArray(input.registry) && input.registry.length > 0,
    'migration-registry-authority', 'An explicit authenticated registry for every selected root is required.');
  let registry: RegistryKey[];
  let signatures: SignaturePolicy;
  try {
    registry = input.registry.map(entry => object(entry,
      ['kid', 'spki_der_b64', 'revoked_utc', 'superseded_utc']) as RegistryKey);
    signatures = selectSignaturePolicy(registry);
  } catch {
    throw new Refusal('migration-registry-authority',
      'The injected operator registry is invalid; no destination profile was opened.');
  }
  requireThat(sameStrings(registry.map(entry => entry.kid), plan.roots)
    && new Set(registry.map(entry => entry.kid)).size === plan.roots.length,
  'migration-registry-authority', 'The injected registry must contain exactly one current entry for every selected root.');
  const selected = [...registry].sort((a, b) => a.kid.localeCompare(b.kid));
  return { registry, signatures, registryCommitment: contentHash(selected) };
}

function signerAuthority(plan: MigrationPlan, input: MigrationAuthorityInput, signatures: SignaturePolicy): readonly RootSigner[] {
  requireThat(Array.isArray(input.signers) && input.signers.length === plan.roots.length,
    'migration-signer-authority', 'An independently custodied signer is required for every selected root.');
  const signers = [...input.signers];
  requireThat(signers.every(entry => isBodyStream(entry.root))
    && new Set(signers.map(entry => entry.root)).size === plan.roots.length
    && sameStrings(signers.map(entry => entry.root), plan.roots),
  'migration-signer-authority', 'Injected signer custody must match the exact selected root set.');
  const utc = new Date().toISOString();
  for (const [index, entry] of signers.entries()) {
    try {
      const probe = buildFrame({
        kind: 'memory.save', streamId: migrationStream(entry.root), utc, head: null,
        payload: { schema: 'rapp-work.migration-signer-probe/1', root: entry.root, planHash: contentHash(plan), index },
        signer: entry.signer, signatures,
      });
      requireThat(signerOf(probe) === entry.root, 'migration-signer-authority',
        'An injected signer does not control its selected root.');
    } catch {
      throw new Refusal('migration-signer-authority',
        'An injected signer is absent, invalid, revoked or not trusted by the selected registry.');
    }
  }
  return Object.freeze(signers);
}

function controlledEvidence(value: unknown, request: ControlledMigrationAuthorityRequest): JsonObject {
  const evidence = object(value, [
    'schema', 'owner', 'planHash', 'approvalWave', 'registryCommitment', 'closureCommitment',
    'rootSelection', 'ownerAnchorWave', 'domain', 'domainDeclarationWave', 'closureWave', 'hive',
  ]);
  requireThat(evidence.schema === CONTROLLED_MIGRATION_AUTHORITY_SCHEMA
    && evidence.owner === request.owner && evidence.planHash === request.planHash
    && evidence.approvalWave === request.approvalWave
    && evidence.registryCommitment === request.registryCommitment
    && canonicalJson(evidence.rootSelection) === canonicalJson(request.rootSelection),
  'migration-owner-authority', 'The operator authority did not bind the exact owner, plan, approval and signer registry.');
  requireThat(evidence.closureCommitment === request.closureCommitment,
    'migration-closure-authority', 'The adopted closure authority does not match the complete selected source closure.');
  requireThat(['godd', 'dogg', 'both'].includes(String(evidence.domain)),
    'migration-domain-authority', 'Controlled migration requires an adopted GODD, DOGG or combined domain declaration.');
  const ownerAnchorWave = hash(evidence.ownerAnchorWave, 'migration-owner-authority', 'A signed out-of-band owner anchor is required.');
  const domainDeclarationWave = hash(evidence.domainDeclarationWave,
    'migration-domain-authority', 'A signed adopted domain declaration is required.');
  const closureWave = hash(evidence.closureWave, 'migration-closure-authority', 'A signed complete closure acceptance is required.');
  const hive = object(evidence.hive, [
    'schema', 'hive', 'owner', 'acceptedPlanHash', 'registrySeq', 'registryCommitment',
    'acceptanceWave', 'checkpointWave',
  ]);
  requireThat(hive.schema === CONTROLLED_MIGRATION_HIVE_SCHEMA && isBodyStream(hive.hive)
    && hive.owner === request.owner && hive.acceptedPlanHash === request.planHash
    && Number.isSafeInteger(hive.registrySeq) && Number(hive.registrySeq) >= 0,
  'migration-hive-authority', 'The Private Hive acceptance did not bind this owner and exact migration plan.');
  hash(hive.registryCommitment, 'migration-hive-authority', 'A fresh authenticated Hive registry commitment is required.');
  hash(hive.acceptanceWave, 'migration-hive-authority', 'A signed Hive acceptance wave is required.');
  hash(hive.checkpointWave, 'migration-hive-authority', 'A monotonic Hive checkpoint wave is required.');
  return {
    schema: CONTROLLED_MIGRATION_AUTHORITY_SCHEMA,
    mode: 'controlled-local',
    source: 'operator-injected-authority-port',
    owner: request.owner,
    planHash: request.planHash,
    approvalWave: request.approvalWave,
    registryCommitment: request.registryCommitment,
    closureCommitment: request.closureCommitment,
    rootSelection: [...request.rootSelection],
    ownerAnchorWave,
    domain: String(evidence.domain),
    domainDeclarationWave,
    closureWave,
    hive,
    cutover: 'pending-external-acceptance',
    factualTruth: false,
  };
}

export async function bindMigrationAuthority(planValue: MigrationPlan, approvalBytes: string,
  input: MigrationAuthorityInput): Promise<BoundMigrationAuthority> {
  const plan = migrationPlan(planValue);
  const planHash = contentHash(plan);
  const { signatures, registryCommitment } = registryPolicy(plan, input);
  const signers = signerAuthority(plan, input, signatures);
  const approval = verifyMigrationApproval(plan, approvalBytes, signatures);
  const closureCommitment = migrationClosureCommitment(plan);
  let evidence: JsonObject;
  if (plan.mode === 'sanitized-fixture') {
    requireThat(plan.roots.every(root => root.startsWith('rappid:@fixture/')) && input.controlledLocal === undefined,
      'migration-adoption-unavailable', 'Sanitized fixture authority cannot be relabeled or combined with controlled-local adoption.');
    evidence = {
      schema: 'rapp-work.fixture-migration-authority/1',
      mode: plan.mode,
      source: 'synthetic-fixture',
      owner: plan.owner,
      planHash,
      approvalWave: approval.frame_hash,
      registryCommitment,
      closureCommitment,
      cutover: 'pending-external-authority',
      factualTruth: false,
    };
  } else {
    requireThat(plan.roots.every(root => !root.startsWith('rappid:@fixture/')) && input.controlledLocal,
      'migration-adoption-unavailable',
      'Controlled-local migration requires a non-fixture selection and an explicitly injected operator authority verifier.');
    const request: ControlledMigrationAuthorityRequest = Object.freeze({
      plan, approval, owner: plan.owner, planHash, approvalWave: approval.frame_hash,
      registryCommitment, closureCommitment, rootSelection: Object.freeze([...plan.roots]),
    });
    let verified: unknown;
    try {
      verified = await input.controlledLocal.verify(request);
    } catch {
      throw new Refusal('migration-adoption-unavailable',
        'The injected owner/domain/closure/Hive authority verifier did not authorize this exact migration.');
    }
    evidence = controlledEvidence(verified, request);
  }
  const binding = Object.freeze({
    mode: plan.mode, planHash, approval, signatures, signers, evidence: Object.freeze(evidence),
  }) as BoundMigrationAuthority;
  bindings.add(binding);
  return binding;
}

export function requireMigrationAuthority(binding: BoundMigrationAuthority, plan: MigrationPlan): BoundMigrationAuthority {
  requireThat(typeof binding === 'object' && binding !== null && bindings.has(binding)
    && binding.mode === plan.mode && binding.planHash === contentHash(plan),
  'migration-authority', 'Use the exact prevalidated migration authority binding for this plan.');
  return binding;
}
