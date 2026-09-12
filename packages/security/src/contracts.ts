import {
  arrayItems, assertOptions, canonicalJson, hashValue, isUtc, PARTICLE_DOMAIN,
  snapshotJson, type JsonObject,
} from '@rapp-work/rapp1';

export const PERMISSIONS = Object.freeze([
  'workspace.create', 'workspace.read', 'workspace.append', 'artifact.read', 'artifact.write',
  'agent.manage', 'task.manage', 'schedule.manage', 'message.write', 'approval.decide',
  'run.execute', 'computer.observe',
] as const);
export type Permission = typeof PERMISSIONS[number];
export const GUEST_OPERATIONS = Object.freeze([
  'guest.shell', 'guest.files.read', 'guest.files.write', 'guest.git', 'guest.browser',
  'guest.research', 'guest.document',
] as const);
export type GuestOperation = typeof GUEST_OPERATIONS[number];

export interface PrincipalClaims {
  readonly id: string;
  readonly kind: 'human' | 'host';
  readonly expiresAt: number;
}
declare const principalBrand: unique symbol;
export interface Principal { readonly [principalBrand]: true }
declare const capabilityBrand: unique symbol;
export interface Capability { readonly [capabilityBrand]: true }
declare const permitBrand: unique symbol;
export interface ExecutionPermit { readonly [permitBrand]: true }

export interface Scope {
  readonly agentId: string;
  readonly workspaceId: string;
  readonly taskId: string | null;
}
export interface CapabilityRequest extends Scope {
  readonly permissions: readonly Permission[];
  readonly resources: readonly string[];
  readonly expiresAt: number;
}
export interface CapabilityView extends CapabilityRequest { readonly principal: PrincipalClaims }

export interface OperationRequest extends JsonObject {
  schema: 'rapp-work/operation/1';
  operation_id: string;
  principal_id: string;
  agent_id: string;
  workspace_id: string;
  task_id: string;
  run_id: string;
  operation: GuestOperation;
  resources: string[];
  params: JsonObject;
  expires_utc: string;
}

export class AuthorizationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AuthorizationError'; }
}

export function assertIdentifier(value: unknown, label = 'identifier'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || value.normalize('NFC') !== value
    || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError(`Invalid ${label}`);
}

export function artifactPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || value.length === 0
    || value.normalize('NFC') !== value || value.includes('\\') || value.includes('%') || value.includes(':')
    || value.split('/').some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))) {
    throw new AuthorizationError('artifact-path', 'Invalid relative artifact capability path');
  }
  return value;
}

export function resourceList(value: unknown): readonly string[] {
  const items = arrayItems(value, 256);
  if (!items.length) throw new TypeError('At least one explicit resource is required');
  const result: string[] = [];
  let previous = '';
  for (const item of items) {
    assertIdentifier(item, 'resource');
    if (item.includes('*') || item <= previous) throw new TypeError('Resources must be sorted, unique and exact');
    previous = item;
    result.push(item);
  }
  return Object.freeze(result);
}

export function validateOperation(value: unknown): OperationRequest {
  const request = snapshotJson(value);
  assertOptions(request, [
    'schema', 'operation_id', 'principal_id', 'agent_id', 'workspace_id', 'task_id',
    'run_id', 'operation', 'resources', 'params', 'expires_utc',
  ]);
  for (const key of ['operation_id', 'principal_id', 'agent_id', 'workspace_id', 'task_id', 'run_id'] as const) {
    assertIdentifier(request[key], key);
  }
  if (request.schema !== 'rapp-work/operation/1' || typeof request.operation !== 'string'
    || !GUEST_OPERATIONS.includes(request.operation as GuestOperation) || !isUtc(request.expires_utc)) {
    throw new TypeError('Invalid guest-only operation or expiry');
  }
  assertOptions(request.params, Object.keys(request.params as object));
  const resources = resourceList(request.resources);
  if (!resources.includes('computer:omarchy')) throw new TypeError('Guest operations must explicitly name computer:omarchy');
  canonicalJson(request);
  return request as unknown as OperationRequest;
}

export function operationHash(request: OperationRequest): string {
  return hashValue(PARTICLE_DOMAIN, validateOperation(request));
}

export function validateCapabilityRequest(value: unknown): CapabilityRequest {
  const request = snapshotJson(value);
  assertOptions(request, ['agentId', 'workspaceId', 'taskId', 'permissions', 'resources', 'expiresAt']);
  assertIdentifier(request.agentId, 'agentId');
  assertIdentifier(request.workspaceId, 'workspaceId');
  if (request.taskId !== null) assertIdentifier(request.taskId, 'taskId');
  if (typeof request.expiresAt !== 'number' || !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= 0) {
    throw new TypeError('Invalid capability expiry');
  }
  const permissions = arrayItems(request.permissions);
  if (!permissions.length || new Set(permissions).size !== permissions.length
    || permissions.some((permission) => !PERMISSIONS.includes(permission as Permission))) {
    throw new TypeError('Invalid explicit permissions');
  }
  resourceList(request.resources);
  return request as unknown as CapabilityRequest;
}
