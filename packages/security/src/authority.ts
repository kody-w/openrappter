import { randomUUID } from 'node:crypto';
import {
  AUTHORITY_IDENTITY, arrayItems, assertOptions, canonicalJson, frameHead, hashValue, isVerifiedChain,
  PARTICLE_DOMAIN, snapshotJson, verifyEvidenceLink, type FrameHead, type JsonObject, type VerifiedChain,
} from '@rapp-work/rapp1';
import {
  assertIdentifier, AuthorizationError, operationHash, validateCapabilityRequest, validateOperation,
  type Capability, type CapabilityRequest, type CapabilityView, type ExecutionPermit, type OperationRequest,
  type Permission, type Principal, type PrincipalClaims, type Scope,
} from './contracts.js';
import { approvalFromFrames, assertApprovalForOperation, frameData } from './approval.js';

export interface FrameProof {
  readonly body: VerifiedChain;
  readonly memory: VerifiedChain;
  readonly sourceFrameHash: string;
  readonly evidenceFrameHash: string;
}
export interface PermitReservation {
  readonly expectedBodyHead: FrameHead;
  readonly expectedMemoryHead: FrameHead;
  readonly payload: JsonObject;
}
export type PermitCommitter = (reservation: PermitReservation) => Promise<FrameProof>;
export interface PermitClaims {
  readonly permitId: string;
  readonly operationHash: string;
  readonly request: OperationRequest;
  readonly intentFrameHash: string;
  readonly consumptionFrameHash: string;
  readonly expiresAt: number;
  readonly computer: 'omarchy';
  readonly executionLocation: 'guest';
}
interface AuthorityOptions {
  authenticate: (credential: unknown) => PrincipalClaims | null | Promise<PrincipalClaims | null>;
  authorize: (principal: PrincipalClaims, request: CapabilityRequest) => boolean | Promise<boolean>;
  executionPolicy: (principal: PrincipalClaims, request: OperationRequest) =>
    { allowed: boolean; requiresApproval: boolean } | Promise<{ allowed: boolean; requiresApproval: boolean }>;
  now?: () => number;
}

export class SecurityAuthority {
  readonly #options: AuthorityOptions;
  readonly #principals = new WeakMap<object, PrincipalClaims>();
  readonly #capabilities = new WeakMap<object, { view: CapabilityView; principal: Principal; parent?: Capability }>();
  readonly #permits = new WeakMap<object, { claims: PermitClaims; capability: Capability }>();
  #lastNow = 0;

  constructor(options: AuthorityOptions) {
    assertOptions(options, ['authenticate', 'authorize', 'executionPolicy', 'now'], ['authenticate', 'authorize', 'executionPolicy']);
    if (typeof options.authenticate !== 'function' || typeof options.authorize !== 'function'
      || typeof options.executionPolicy !== 'function' || (options.now !== undefined && typeof options.now !== 'function')) {
      throw new TypeError('Authentication and explicit host authorization policies are mandatory');
    }
    this.#options = Object.freeze({ ...options });
  }

  #now(): number {
    const now = (this.#options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now <= 0 || now < this.#lastNow) {
      throw new AuthorizationError('clock', 'Authorization clock is invalid or regressed');
    }
    this.#lastNow = now;
    return now;
  }

  async authenticate(credential: unknown): Promise<Principal> {
    const raw = await this.#options.authenticate(credential);
    if (raw === null) throw new AuthorizationError('unauthenticated', 'Authentication failed');
    const claims = snapshotJson(raw);
    assertOptions(claims, ['id', 'kind', 'expiresAt']);
    assertIdentifier(claims.id, 'principal');
    if (!['human', 'host'].includes(claims.kind as string) || typeof claims.expiresAt !== 'number'
      || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= this.#now()) {
      throw new AuthorizationError('unauthenticated', 'Invalid or expired principal');
    }
    const handle = Object.freeze(Object.create(null)) as Principal;
    this.#principals.set(handle, claims as unknown as PrincipalClaims);
    return handle;
  }

  inspectPrincipal(principal: Principal): PrincipalClaims {
    const claims = this.#principals.get(principal);
    if (!claims || claims.expiresAt <= this.#now()) throw new AuthorizationError('principal', 'Foreign, revoked or expired principal');
    return claims;
  }

  async authorize(principal: Principal, input: CapabilityRequest): Promise<Capability> {
    const claims = this.inspectPrincipal(principal);
    const request = validateCapabilityRequest(input);
    if (request.expiresAt > claims.expiresAt || request.expiresAt <= this.#now()
      || await this.#options.authorize(claims, request) !== true) {
      throw new AuthorizationError('denied', 'The requested scope is not authorized');
    }
    this.inspectPrincipal(principal);
    if (request.expiresAt <= this.#now()) throw new AuthorizationError('expired', 'Authorization expired during policy evaluation');
    const handle = Object.freeze(Object.create(null)) as Capability;
    this.#capabilities.set(handle, { principal, view: Object.freeze({ ...request, principal: claims }) });
    return handle;
  }

  inspectCapability(capability: Capability, permission?: Permission): CapabilityView {
    const record = this.#capabilities.get(capability);
    if (!record) throw new AuthorizationError('capability', 'Caller IDs or lookalikes are not capabilities');
    if (record.parent !== undefined) this.inspectCapability(record.parent);
    this.inspectPrincipal(record.principal);
    if (record.view.expiresAt <= this.#now()) throw new AuthorizationError('expired', 'Capability expired');
    if (permission !== undefined && !record.view.permissions.includes(permission)) {
      throw new AuthorizationError('permission', `Capability lacks ${permission}`);
    }
    return record.view;
  }

  assertCapability(capability: Capability, permission: Permission, scope: Scope, resources: readonly string[] = []): CapabilityView {
    assertOptions(scope, ['agentId', 'workspaceId', 'taskId']);
    const checked = arrayItems(resources, 256);
    for (const resource of checked) assertIdentifier(resource, 'resource');
    const view = this.inspectCapability(capability, permission);
    if (view.agentId !== scope.agentId || view.workspaceId !== scope.workspaceId
      || (view.taskId !== null && view.taskId !== scope.taskId)
      || checked.some((resource) => !view.resources.includes(resource as string))) {
      throw new AuthorizationError('scope', 'Capability does not authorize the exact resources');
    }
    return view;
  }

  async attenuate(capability: Capability, request: CapabilityRequest): Promise<Capability> {
    const parent = this.inspectCapability(capability);
    const child = validateCapabilityRequest(request);
    if (child.agentId !== parent.agentId || child.workspaceId !== parent.workspaceId
      || (parent.taskId !== null && child.taskId !== parent.taskId) || child.expiresAt > parent.expiresAt
      || child.permissions.some((value) => !parent.permissions.includes(value))
      || child.resources.some((value) => !parent.resources.includes(value)) || child.expiresAt <= this.#now()) {
      throw new AuthorizationError('amplification', 'A capability can only be narrowed');
    }
    const handle = Object.freeze(Object.create(null)) as Capability;
    const principal = this.#capabilities.get(capability)!.principal;
    this.#capabilities.set(handle, { principal, parent: capability, view: Object.freeze({ ...child, principal: parent.principal }) });
    return handle;
  }

  revokePrincipal(principal: Principal): void { this.#principals.delete(principal); }
  revokeCapability(capability: Capability): void { this.#capabilities.delete(capability); }

  async issuePermit(capability: Capability, input: {
    request: OperationRequest; intent: FrameProof; approvalId: string | null; commit: PermitCommitter;
  }): Promise<ExecutionPermit> {
    assertOptions(input, ['request', 'intent', 'approvalId', 'commit']);
    if (typeof input.commit !== 'function') throw new TypeError('Durable permit committer is mandatory');
    assertOptions(input.intent, ['body', 'memory', 'sourceFrameHash', 'evidenceFrameHash']);
    input = Object.freeze({
      request: validateOperation(input.request), intent: Object.freeze({ ...input.intent }),
      approvalId: input.approvalId, commit: input.commit,
    });
    const request = validateOperation(input.request);
    const view = this.assertCapability(capability, 'run.execute', {
      agentId: request.agent_id, workspaceId: request.workspace_id, taskId: request.task_id,
    }, request.resources);
    if (view.principal.id !== request.principal_id) throw new AuthorizationError('principal-binding', 'Operation names another principal');
    const policy = await this.#options.executionPolicy(view.principal, request);
    assertOptions(policy, ['allowed', 'requiresApproval']);
    if (policy.allowed !== true || typeof policy.requiresApproval !== 'boolean') throw new AuthorizationError('operation-denied', 'Guest operation denied');
    if (policy.requiresApproval && input.approvalId === null) throw new AuthorizationError('approval-required', 'This exact operation requires approval');
    const proof = input.intent;
    assertOptions(proof, ['body', 'memory', 'sourceFrameHash', 'evidenceFrameHash']);
    if (!isVerifiedChain(proof.memory) || !isVerifiedChain(proof.body)) {
      throw new AuthorizationError('untrusted-intent', 'Write-ahead intent must be scanned');
    }
    const intent = proof.memory.frames.find((frame) => frame.frame_hash === proof.sourceFrameHash);
    if (!intent || intent.kind !== 'memory.tool-call') throw new AuthorizationError('intent-missing', 'No canonical intent');
    const data = frameData(intent);
    assertOptions(data, [
      'type', 'agent_id', 'workspace_id', 'task_id', 'run_id', 'intent_id', 'request', 'approval_id',
    ]);
    if (data.type !== 'intent.accepted' || canonicalJson(data.request) !== canonicalJson(request)
      || data.agent_id !== request.agent_id || data.workspace_id !== request.workspace_id
      || data.task_id !== request.task_id || data.run_id !== request.run_id || data.approval_id !== input.approvalId) {
      throw new AuthorizationError('intent-binding', 'Intent is not bound to this exact operation');
    }
    assertIdentifier(data.intent_id, 'intent');
    verifyEvidenceLink({
      body: proof.body, source: proof.memory, sourceFrameHash: proof.sourceFrameHash,
      evidenceFrameHash: proof.evidenceFrameHash, subject: intent.payload.subject as string,
      eventKind: 'intent.accepted', data, requiredReferences: [operationHash(request)],
    });
    for (const frame of proof.memory.frames) {
      const value = frame.payload.data as JsonObject | undefined;
      if (value && (value.intent_id === data.intent_id || value.operation_hash === operationHash(request))
        && ['intent.permitted', 'outcome.recorded'].includes(value.type as string)) {
        throw new AuthorizationError('already-reserved', 'Operation was already permitted or has a terminal outcome; do not replay');
      }
    }
    let expiresAt = Math.min(view.expiresAt, Date.parse(request.expires_utc));
    if (input.approvalId !== null) {
      assertIdentifier(input.approvalId, 'approval');
      const approval = approvalFromFrames(proof.memory, proof.body, input.approvalId);
      assertApprovalForOperation(approval, request, this.#now());
      expiresAt = Math.min(expiresAt, Date.parse(approval.expiresUtc));
    }
    if (expiresAt <= this.#now()) throw new AuthorizationError('expired', 'Operation is expired');
    const permitId = randomUUID();
    const permitted: JsonObject = {
      type: 'intent.permitted', agent_id: request.agent_id, workspace_id: request.workspace_id,
      task_id: request.task_id, run_id: request.run_id, intent_id: data.intent_id,
      intent_frame_hash: intent.frame_hash, permit_id: permitId, operation_hash: operationHash(request),
      approval_id: input.approvalId, principal_id: request.principal_id, expires_utc: new Date(expiresAt).toISOString(),
    };
    const payload = snapshotJson({
      subject: intent.payload.subject, data: permitted, protocol_revision: AUTHORITY_IDENTITY,
    }) as JsonObject;
    this.inspectCapability(capability, 'run.execute');
    // The committer must atomically compare BOTH heads and append/read back this exact receipt.
    // An exception or uncertain persistence never creates an executable handle.
    const committed = await input.commit(Object.freeze({
      expectedBodyHead: proof.body.head, expectedMemoryHead: proof.memory.head, payload,
    }));
    assertOptions(committed, ['body', 'memory', 'sourceFrameHash', 'evidenceFrameHash']);
    if (!isVerifiedChain(committed.memory) || !isVerifiedChain(committed.body)) throw new AuthorizationError('commit-proof', 'Permit commit did not return scanned chains');
    for (const [chain, expected] of [[committed.body, proof.body.head], [committed.memory, proof.memory.head]] as const) {
      const old = chain.frames.find((frame) => frame.seq === expected.seq);
      if (!old || canonicalJson(frameHead(old)) !== canonicalJson(expected)) throw new AuthorizationError('commit-cas', 'Permit commit changed its basis');
    }
    const consumption = committed.memory.frames.find((frame) => frame.frame_hash === committed.sourceFrameHash);
    if (!consumption || consumption.seq <= proof.memory.head.seq || consumption.kind !== 'memory.tool-call'
      || consumption.payload_hash !== hashValue(PARTICLE_DOMAIN, payload) || consumption.utc >= new Date(expiresAt).toISOString()) {
      throw new AuthorizationError('commit-binding', 'The canonical single-use receipt is missing or expired');
    }
    verifyEvidenceLink({
      body: committed.body, source: committed.memory, sourceFrameHash: committed.sourceFrameHash,
      evidenceFrameHash: committed.evidenceFrameHash, subject: payload.subject as string,
      eventKind: 'intent.permitted', data: permitted, requiredReferences: [intent.frame_hash, intent.payload_hash, operationHash(request)],
    });
    const reservations = committed.memory.frames.filter((frame) => {
      const value = frame.payload.data as JsonObject | undefined;
      return value?.type === 'intent.permitted' && (value.intent_id === data.intent_id || value.operation_hash === operationHash(request));
    });
    if (reservations.length !== 1) throw new AuthorizationError('permit-reused', 'Duplicate operation reservation');
    if (input.approvalId !== null && approvalFromFrames(committed.memory, committed.body, input.approvalId).consumedBy !== permitId) {
      throw new AuthorizationError('approval-consumption', 'Approval consumption is not canonical');
    }
    this.inspectCapability(capability, 'run.execute');
    if (expiresAt <= this.#now()) throw new AuthorizationError('expired', 'Permit expired during commit');
    const handle = Object.freeze(Object.create(null)) as ExecutionPermit;
    this.#permits.set(handle, {
      capability, claims: Object.freeze({
        permitId, operationHash: operationHash(request), request, intentFrameHash: intent.frame_hash,
        consumptionFrameHash: consumption.frame_hash, expiresAt, computer: 'omarchy', executionLocation: 'guest',
      }),
    });
    return handle;
  }

  /** Consume synchronously BEFORE invoking a broker. A failed execution cannot reuse the permit. */
  consumePermit(permit: ExecutionPermit, request: OperationRequest): PermitClaims {
    const selected = this.#permits.get(permit);
    if (!selected) throw new AuthorizationError('permit', 'Foreign, spent or unavailable permit');
    if (operationHash(request) !== selected.claims.operationHash) throw new AuthorizationError('permit-binding', 'Permit does not cover these exact arguments');
    this.inspectCapability(selected.capability, 'run.execute');
    if (selected.claims.expiresAt <= this.#now()) throw new AuthorizationError('expired', 'Execution permit expired');
    this.#permits.delete(permit);
    return selected.claims;
  }
}
