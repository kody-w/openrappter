import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  AUTHORITY_IDENTITY, buildEvidenceFrame, buildFrame, canonicalJson, frameHead, hashValue,
  isVerifiedChain, parseCanonicalJson, PARTICLE_DOMAIN, snapshotJson,
  type JsonObject, type RappFrame,
} from "@rapp-work/rapp1";
import {
  PERMISSIONS, SecurityAuthority, type Capability, type FrameProof, type Permission,
  type Principal as OwnerPrincipal,
} from "@rapp-work/security";
import {
  isWorkspaceSnapshot, PrivateRoot, WorkspaceStore, type AgentWorkspace, type FaultInjector,
  type WorkspaceHeads, type WorkspaceSnapshot,
} from "@rapp-work/workspace-store";
import {
  WorkService, type AuthorizedEffect, type AuthorizedEffectContext, type CommittedCommand,
  type Heads, type JsonValue, type WorkCommand, type WorkCommitResult, type WorkServicePort,
  type WorkspaceScope,
  type WorkSnapshot,
} from "@rapp-work/work-service";
import { HostError } from "./errors.js";
import {
  idSchema, MAX_WORKSPACE_AGENTS, MAX_WORKSPACE_DEPTH, MAX_WORKSPACES,
  workspaceOrganizationSchema, workspaceSummarySchema, type Area, type WorkEvent, type WorkspaceSummary,
} from "./contracts.js";
import { OWNER_PERMISSIONS, type Permission as HostPermission, type Principal } from "./ports.js";

const scopeSchema = z.strictObject({ agentId: idSchema, workspaceId: idSchema });
const ownerSchema = z.strictObject({
  schema: z.literal("rapp-work/owner/1"), id: idSchema,
  catalog: scopeSchema, computer: scopeSchema,
});
export type LocalOwner = z.infer<typeof ownerSchema>;
export const json = (value: unknown): JsonValue => snapshotJson(value) as JsonValue;
export const digest = (value: unknown): string => hashValue(PARTICLE_DOMAIN, snapshotJson(value));
export const headHashes = (heads: WorkspaceHeads): Heads => ({
  body: heads.body?.frame_hash ?? null, memory: heads.memory?.frame_hash ?? null,
  swarm: heads.swarm?.frame_hash ?? null,
});
export function committed(result: WorkCommitResult | WorkSnapshot["commands"][number]): CommittedCommand {
  if (result.state !== "committed") throw new HostError(-32012, "Persistence or execution is unresolved. This operation will not be replayed.");
  if (result.status !== "succeeded") throw new HostError(-32009, `The operation was ${result.status}.`);
  return result;
}
export const proofReceipt = (result: CommittedCommand): JsonObject => ({
  kind: "canonical-commit", intentRef: result.proof.intentRef, outcomeRef: result.proof.outcomeRef,
  evidenceRef: result.proof.evidenceRef, workspaceId: result.command.scope.workspaceId,
});

interface EffectPermit {
  readonly capability: Capability;
  readonly context: Pick<AuthorizedEffectContext, "command" | "commandHash" | "intentRef">;
  entered: boolean;
  guestConsumed: boolean;
}

/** Owns the only application store. Catalog entries locate, but never authorize, agent state. */
export class LocalPersistence {
  readonly directory: string;
  readonly work: WorkServicePort;
  readonly security: SecurityAuthority;
  private root!: PrivateRoot;
  private store!: WorkspaceStore;
  private principal!: OwnerPrincipal;
  private identity!: LocalOwner;
  private readonly scopes = new Map<string, WorkspaceScope>();
  private readonly parents = new Map<string, string | null>();
  private readonly businesses = new Map<string, WorkspaceScope>();
  private readonly published = new Set<string>();
  private readonly metadata = new Map<string, WorkspaceSummary>();
  private readonly agentIdentities = new WeakMap<object, { workspaceId: string; agentId: string; lineage: string[] }>();
  private readonly humanIdentities = new WeakSet<object>();
  private readonly actor = new AsyncLocalStorage<Principal>();
  private readonly capabilityActors = new WeakMap<object, Principal>();
  private readonly scopedDelegations = new WeakMap<object, Principal>();
  private readonly generations = new Map<string, number>();
  private readonly permits = new WeakMap<object, EffectPermit>();
  private readonly listeners = new Set<(workspaceId: string, event: WorkEvent) => void>();
  private initialized?: Promise<void>;
  private releaseHost: (() => void) | undefined;
  private hostLock: Promise<void> | undefined;
  private opened = false;
  private closed = false;

  constructor(directory: string, private readonly credential: string, private readonly fault?: FaultInjector) {
    this.directory = resolve(directory);
    this.security = new SecurityAuthority({
      authenticate: (credential) => credential === this.credential && this.identity
        ? { id: this.identity.id, kind: "human", expiresAt: Number.MAX_SAFE_INTEGER } : null,
      authorize: (principal, scope) => principal.id === this.identity.id
        && this.scopes.get(scope.agentId)?.workspaceId === scope.workspaceId
        && scope.resources.includes(`workspace:${scope.workspaceId}`),
      // Arbitrary guest execution is always sensitive, including under on-risk policy.
      executionPolicy: (_principal, operation) => ({
        allowed: operation.operation === "guest.shell" || operation.operation === "guest.files.read",
        requiresApproval: operation.operation === "guest.shell" || operation.params.approvalRequired === true,
      }),
    });
    const service = new WorkService({
      canonical: {
        digest,
        scan: (raw, scope) => {
          if (!isWorkspaceSnapshot(raw) || raw.identity.agent_id !== scope.agentId
            || raw.identity.workspace_id !== scope.workspaceId || raw.identity.principal_id !== this.identity.id) {
            throw new Error("A committed, owner-bound filesystem scan is required.");
          }
          this.generations.set(scope.workspaceId, raw.generation);
          return {
            scope, heads: headHashes(raw.heads),
            frames: (["body", "memory", "swarm"] as const).flatMap((stream) =>
              raw.streams[stream].frames.map((frame) => ({ ref: frame.frame_hash, stream, value: frame.payload }))),
          };
        },
      },
      history: {
        withExclusive: async (capability, scope, action) => {
          this.assert(capability, scope, "workspace.read");
          const workspace = await this.store.open(capability as Capability);
          return workspace.withExclusive(async (transaction) => action({
            readCommitted: () => transaction.scan(),
            append: async (events, expectedHeads) => {
              const before = await transaction.scan();
              if (canonicalJson(headHashes(before.heads)) !== canonicalJson(expectedHeads)) throw new Error("Stale committed heads.");
              let head = before.heads.body;
              const frames: RappFrame[] = [];
              for (const event of events) {
                const frame = buildFrame({
                  kind: "body.pulse", streamId: before.identity.body_stream,
                  utc: this.utc(before), head, payload: event,
                });
                frames.push(frame); head = frameHead(frame);
              }
              await transaction.compareAndAppend({ expectedHeads: before.heads, frames });
            },
          }));
        },
      },
      authorization: {
        authorizeRead: async (capability, scope) => { this.assert(capability, scope, "workspace.read"); },
        authorizeCommand: async (capability, request) => {
          const { command } = request;
          const delegated = this.scopedDelegations.get(capability);
          if (delegated?.kind === "agent" && /(?:approval|provider|settings|computer|workspace\.update|agent\.define)/.test(command.operation)) {
            throw new HostError(-32003, "Protected operations require the existing human authorization gates.");
          }
          const grant = this.assert(capability, command.scope, "workspace.append",
            command.resources.map((resource) => `${resource.kind}:${resource.id}`));
          const permission: Permission = command.operation.includes("approval") ? "approval.decide"
            : command.operation.startsWith("agent.define") ? "agent.manage"
            : command.operation.includes("task") ? "task.manage"
            : /^(model|tool|agent\.run|computer)\./.test(command.operation) ? "run.execute" : "workspace.append";
          this.assert(capability, command.scope, permission);
          const actor = this.capabilityActors.get(capability);
          return { principalId: actor?.id ?? grant.principal.id };
        },
        issuePermit: async (capability, request) => {
          this.assert(capability, request.command.scope, "workspace.append");
          const scanned = await (await this.store.open(capability as Capability)).scan();
          const intent = scanned.streams.body.frames.find((frame) => frame.frame_hash === request.intentRef);
          if (!intent || intent.payload.type !== "work.intent" || intent.payload.commandHash !== request.commandHash
            || digest(intent.payload.command) !== digest(request.command)
            || scanned.streams.body.frames.some((frame) => frame.payload.type === "work.outcome"
              && frame.payload.intentRef === request.intentRef)) throw new Error("No unspent canonical write-ahead intent.");
          const permit = Object.freeze(Object.create(null)) as object;
          this.permits.set(permit, {
            capability: capability as Capability, context: request, entered: false, guestConsumed: false,
          });
          return permit;
        },
      },
    });
    this.work = {
      read: service.read.bind(service), project: service.project.bind(service),
      commit: async (capability, command, effect, options) => {
        const result = await service.commit(capability, command, async (context) => {
          const permit = this.permits.get(context.permit);
          if (!permit || permit.entered || permit.capability !== capability
            || permit.context.intentRef !== context.intentRef || permit.context.commandHash !== context.commandHash) {
            throw new Error("Foreign or spent effect permit.");
          }
          this.assert(capability, command.scope, "workspace.append");
          permit.entered = true;
          return effect(context);
        }, options);
        if (result.state === "committed" && !result.replayed) {
          if (result.status === "succeeded") for (const event of result.events) {
            if (event.type === "workspace.saved" && this.metadata.has(command.scope.workspaceId)) {
              this.registerWorkspace(workspaceSummarySchema.parse(event.workspace));
            } else if (event.type === "workspace.evolved" && this.metadata.has(command.scope.workspaceId)) {
              const previous = this.metadata.get(command.scope.workspaceId)!;
              this.metadata.set(previous.id, { ...previous, organization: workspaceOrganizationSchema.parse(event.organization),
                updatedAt: String(event.at) });
            }
          }
          this.changed("work", this.entity(command), command.scope);
          const parent = this.parents.get(command.scope.workspaceId);
          if (parent && result.events.some((event) => String(event.type).startsWith("ui."))) {
            const scope = this.businesses.get(parent);
            if (scope) this.changed("work", this.entity(command), scope);
          }
        }
        return result;
      },
    };
  }

  get owner(): LocalOwner {
    if (!this.opened || this.closed) throw new Error("Application persistence is not open.");
    return structuredClone(this.identity);
  }
  get privateRoot(): PrivateRoot { this.owner; return this.root; }
  async initialize(): Promise<void> {
    this.initialized ??= this.open();
    return this.initialized;
  }
  private async open(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.root = await PrivateRoot.open(this.directory);
    await this.root.lock(async () => {
      if (await this.root.stat("owner.json") === null) {
        await this.root.writeAtomic("owner.json", canonicalJson({
          schema: "rapp-work/owner/1", id: `owner-${randomUUID().replaceAll("-", "")}`,
          catalog: { agentId: "work-owner", workspaceId: `catalog-${randomUUID()}` },
          computer: { agentId: "work-computer", workspaceId: `computer-${randomUUID()}` },
        }));
      }
      this.identity = ownerSchema.parse(parseCanonicalJson(await this.root.read("owner.json")));
      await this.root.mkdir("workspaces");
      await this.root.mkdir("host-lock");
    }, 5000);
    const lockRoot = await this.root.child("host-lock");
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    const lifetime = new Promise<void>((resolve) => { this.releaseHost = resolve; });
    this.hostLock = lockRoot.lock(async () => { acquired(); await lifetime; }, 5000);
    await Promise.race([ready, this.hostLock]);
    this.register(this.identity.catalog); this.register(this.identity.computer);
    this.principal = await this.security.authenticate(this.credential);
    this.store = await WorkspaceStore.open({
      root: join(this.directory, "workspaces"), security: this.security,
      ...(this.fault ? { fault: this.fault } : {}),
    });
    this.opened = true;
    for (const scope of [this.identity.catalog, this.identity.computer]) {
      await this.store.create(await this.capability(scope), { owner: this.identity.id, slug: scope.agentId });
    }
    await this.refreshCatalog();
  }
  async refreshCatalog(): Promise<void> {
    const verified = new Set<string>();
    const cache = new Map<string, WorkSnapshot>();
    const read = async (scope: WorkspaceScope) => {
      const history = cache.get(scope.workspaceId) ?? await this.read(scope);
      cache.set(scope.workspaceId, history); return history;
    };
    const linked = (history: WorkSnapshot, receipt: JsonObject) => history.commands.find((entry) =>
      entry.state === "committed" && entry.status === "succeeded" && entry.proof.evidenceRef === receipt.evidenceRef
      && entry.proof.intentRef === receipt.intentRef && entry.proof.outcomeRef === receipt.outcomeRef);
    const visit = async (birth: WorkspaceSummary, parent: WorkspaceSummary | null, command: CommittedCommand): Promise<void> => {
      if (verified.has(birth.id) || verified.size >= MAX_WORKSPACES || birth.parentWorkspaceId !== (parent?.id ?? null)) {
        throw new Error("Workspace lineage contains a duplicate, cycle or foreign parent.");
      }
      this.registerWorkspace(birth, false);
      const history = await read(birth.catalogScope);
      const bootstrap = history.commands.find((entry) => entry.state === "committed" && entry.status === "succeeded"
        && entry.command.operation === "host.workspace.bootstrap" && command.receipts.some((receipt) =>
          receipt.kind === "canonical-commit" && receipt.workspaceId === birth.id && linked(history, receipt) === entry));
      if (!bootstrap || bootstrap.state !== "committed" || !bootstrap.events.some((event) =>
        event.type === "workspace.saved" && digest(event.workspace) === digest(birth))
        || !bootstrap.events.some((event) => event.type === "twin.identity.saved"
          && event.parentWorkspaceId === birth.id && digest(event.identity) === digest(birth.twin))) {
        throw new Error("Every workspace requires a parent-linked complete canonical bootstrap.");
      }
      const children = new Map<string, { birth: WorkspaceSummary; command: CommittedCommand }>();
      const agents = new Map<string, WorkspaceScope>();
      for (const entry of history.commands) {
        if (entry.state !== "committed" || entry.status !== "succeeded") continue;
        for (const event of entry.events) {
          if (event.type === "catalog.workspace") {
            const child = workspaceSummarySchema.parse(event.workspace);
            if (children.has(child.id)) throw new Error("A dedicated workspace may be published only once.");
            children.set(child.id, { birth: child, command: entry });
          } else if (event.type === "catalog.agent") {
            if (event.parentWorkspaceId !== birth.id) throw new Error("Agent parent ownership differs.");
            const scope = scopeSchema.parse(event.scope);
            this.register(scope, birth.id); agents.set(scope.agentId, scope);
          }
        }
      }
      if (agents.size > MAX_WORKSPACE_AGENTS || children.size !== agents.size) throw new Error("An agent and its dedicated child must be published together.");
      for (const child of children.values()) {
        if (agents.get(child.birth.ownerAgentId!)?.workspaceId !== child.birth.id) throw new Error("A child workspace has no owning agent.");
        this.registerWorkspace(child.birth, false);
      }
      for (const receipt of bootstrap.receipts) {
        if (receipt.kind !== "canonical-commit") throw new Error("Bootstrap effects require canonical workspace proofs.");
        const scope = receipt.workspaceId === birth.id ? birth.catalogScope : children.get(String(receipt.workspaceId))?.birth.catalogScope;
        if (!scope || !linked(await read(scope), receipt)) {
          this.published.delete(birth.id);
          throw new Error("The complete bootstrap child evidence could not be verified.");
        }
      }
      if (birth.ownerType === "agent") {
        if (!history.commands.some((entry) => entry.state === "committed" && entry.status === "succeeded"
          && entry.events.some((event) => event.type === "ui.agent.saved"
            && (event.agent as { id?: string; workspaceId?: string })?.id === birth.ownerAgentId
            && (event.agent as { workspaceId?: string }).workspaceId === birth.id))) throw new Error("The owning agent has no canonical definition.");
      } else if (!agents.has(birth.leadAgentId)) throw new Error("A human workspace requires a lead agent and its dedicated child.");
      verified.add(birth.id);
      for (const child of children.values()) await visit(child.birth, birth, child.command);
      for (const entry of history.commands) {
        if (entry.state !== "committed" || entry.status !== "succeeded") continue;
        for (const event of entry.events) {
          if (event.type === "workspace.saved") this.registerWorkspace(workspaceSummarySchema.parse(event.workspace));
          if (event.type === "workspace.evolved") {
            const current = this.metadata.get(birth.id)!;
            this.metadata.set(birth.id, { ...current, organization: workspaceOrganizationSchema.parse(event.organization), updatedAt: String(event.at) });
          }
        }
      }
    };
    try {
      for (const command of (await read(this.identity.catalog)).commands) {
        if (command.state !== "committed" || command.status !== "succeeded") continue;
        for (const event of command.events) if (event.type === "catalog.workspace") {
          await visit(workspaceSummarySchema.parse(event.workspace), null, command);
        }
      }
      this.published.clear();
      for (const id of verified) this.published.add(id);
    } catch (error) {
      this.published.clear();
      throw error;
    }
  }
  register(scope: WorkspaceScope, parentWorkspaceId: string | null = null): void {
    scopeSchema.parse(scope);
    const existing = this.scopes.get(scope.agentId);
    if (existing && existing.workspaceId !== scope.workspaceId) throw new Error("An agent cannot change its minted workspace.");
    if ([...this.scopes.values()].some((item) => item.workspaceId === scope.workspaceId && item.agentId !== scope.agentId)) {
      throw new Error("A workspace has exactly one state owner.");
    }
    if (this.parents.has(scope.workspaceId) && this.parents.get(scope.workspaceId) !== parentWorkspaceId) {
      throw new Error("A workspace cannot change its parent ownership.");
    }
    this.scopes.set(scope.agentId, Object.freeze({ ...scope }));
    this.parents.set(scope.workspaceId, parentWorkspaceId);
  }
  private registerWorkspace(raw: WorkspaceSummary, update = true): void {
    const workspace = workspaceSummarySchema.parse(raw);
    if (workspace.ownerId !== this.identity.id) throw new Error("Workspace belongs to a different root owner.");
    const previous = this.metadata.get(workspace.id);
    const identity = (item: WorkspaceSummary) => ({
      id: item.id, ownerId: item.ownerId, ownerType: item.ownerType, ownerAgentId: item.ownerAgentId,
      parentWorkspaceId: item.parentWorkspaceId, rootWorkspaceId: item.rootWorkspaceId,
      lineage: item.lineage, depth: item.depth, catalogScope: item.catalogScope,
    });
    if (previous && digest(identity(previous)) !== digest(identity(workspace))) throw new Error("Workspace lineage and owner are mint-once.");
    if (workspace.parentWorkspaceId !== null) {
      const parent = this.metadata.get(workspace.parentWorkspaceId);
      if (!parent || workspace.depth !== parent.depth + 1 || workspace.depth > MAX_WORKSPACE_DEPTH
        || digest(workspace.lineage) !== digest([...parent.lineage, workspace.id])
        || workspace.rootWorkspaceId !== parent.rootWorkspaceId) throw new Error("The exact parent lineage is required.");
    }
    this.register(workspace.catalogScope, workspace.parentWorkspaceId);
    this.businesses.set(workspace.id, Object.freeze({ ...workspace.catalogScope }));
    if (update || !previous) this.metadata.set(workspace.id, structuredClone(workspace));
  }
  ownsBusiness(workspaceId: string): boolean { return this.published.has(workspaceId); }
  businessScope(workspaceId: string): WorkspaceScope {
    if (!this.ownsBusiness(workspaceId)) throw new HostError(-32003, "This business workspace is not authorized.");
    return { ...this.businesses.get(workspaceId)! };
  }
  businessIds(): string[] {
    return [...this.published].sort((a, b) => {
      const left = this.metadata.get(a)!.lineage.join("/"), right = this.metadata.get(b)!.lineage.join("/");
      return left.localeCompare(right);
    });
  }
  workspaceInfo(workspaceId: string): WorkspaceSummary {
    this.businessScope(workspaceId);
    return structuredClone(this.metadata.get(workspaceId)!);
  }
  childrenOf(workspaceId: string): string[] {
    return this.businessIds().filter((id) => this.parents.get(id) === workspaceId);
  }
  activeLineage(workspaceId: string): boolean {
    const metadata = this.workspaceInfo(workspaceId);
    return metadata.lineage.every((id) => this.published.has(id) && this.metadata.get(id)?.status === "active");
  }
  parentBusiness(scope: WorkspaceScope): string | null {
    if (this.scopes.get(scope.agentId)?.workspaceId !== scope.workspaceId) throw new Error("Unknown workspace scope.");
    if (this.metadata.get(scope.workspaceId)?.ownerType === "human") return scope.workspaceId;
    const parent = this.parents.get(scope.workspaceId);
    return parent && this.businesses.has(parent) ? parent : null;
  }
  assertChild(scope: WorkspaceScope, workspaceId: string): void {
    if (this.scopes.get(scope.agentId)?.workspaceId !== scope.workspaceId
      || this.parents.get(scope.workspaceId) !== workspaceId) {
      throw new HostError(-32003, "This agent workspace does not belong to the selected business.");
    }
  }
  assertExecutionScope(scope: WorkspaceScope, workspaceId: string): void {
    const workspace = this.workspaceInfo(workspaceId);
    if (scope.workspaceId === workspace.id && scope.agentId === workspace.catalogScope.agentId) return;
    this.assertChild(scope, workspaceId);
  }
  hasAgent(agentId: string): boolean { return this.scopes.has(agentId); }
  async mintWorkspace(workspace: WorkspaceSummary): Promise<void> {
    if (this.metadata.has(workspace.id) || this.metadata.size >= MAX_WORKSPACES) throw new HostError(-32009, "Workspace identity is already reserved or the workspace limit was reached.");
    this.registerWorkspace(workspace);
    await this.store.create(await this.capability(workspace.catalogScope), {
      owner: this.identity.id, slug: `${workspace.ownerType === "agent" ? "agent" : "business"}-${randomUUID()}`,
    });
  }
  async capability(scope: WorkspaceScope, resources: readonly string[] = []): Promise<Capability> {
    this.owner;
    const capability = await this.security.authorize(this.principal, {
      ...scope, taskId: null, permissions: [...PERMISSIONS],
      resources: [...new Set([`agent:${scope.agentId}`, `workspace:${scope.workspaceId}`, ...resources])].sort(),
      expiresAt: Date.now() + 3_600_000,
    });
    const actor = this.actor.getStore();
    if (actor) this.capabilityActors.set(capability, actor);
    return capability;
  }
  assert(capability: object, scope: WorkspaceScope, permission: Permission, resources: readonly string[] = []) {
    this.owner;
    const grant = this.security.assertCapability(capability as Capability, permission, { ...scope, taskId: null }, resources);
    const delegated = this.scopedDelegations.get(capability);
    if (delegated && !this.canAccess(delegated, scope.workspaceId, permission === "workspace.read" || permission === "artifact.read" ? "work:read" : "work:write")) {
      throw new HostError(-32003, "The capability's exact workspace lineage is no longer authorized.");
    }
    return grant;
  }
  isHuman(principal: Principal): boolean {
    return !this.closed && this.humanIdentities.has(principal) && principal.kind === "human"
      && principal.id === this.identity.id && principal.workspaceId === this.identity.catalog.workspaceId;
  }
  humanPrincipal(): Principal {
    const owner = this.owner;
    const principal: Principal = Object.freeze({
      id: owner.id, workspaceId: owner.catalog.workspaceId, kind: "human", permissions: OWNER_PERMISSIONS,
    });
    this.humanIdentities.add(principal);
    return principal;
  }
  isAgent(principal: Principal): boolean {
    const claims = this.agentIdentities.get(principal);
    const workspace = claims ? this.metadata.get(claims.workspaceId) : undefined;
    return Boolean(claims && principal.kind === "agent" && principal.id === claims.agentId && principal.agentId === claims.agentId
      && principal.workspaceId === claims.workspaceId && workspace?.ownerAgentId === claims.agentId
      && digest(workspace.lineage) === digest(claims.lineage) && this.published.has(workspace.id)
      && this.activeLineage(workspace.id));
  }
  canAccess(principal: Principal, workspaceId: string | null, permission: HostPermission): boolean {
    if (!principal.permissions.includes(permission)) return false;
    if (this.isHuman(principal)) return workspaceId === null || this.published.has(workspaceId);
    if (workspaceId === null || !this.isAgent(principal) || !this.published.has(workspaceId)) return false;
    const own = this.agentIdentities.get(principal)!;
    const target = this.metadata.get(workspaceId)!;
    if (workspaceId === own.workspaceId) return true;
    if (!permission.endsWith(":read") || target.lineage.length <= own.lineage.length
      || !own.lineage.every((id, index) => target.lineage[index] === id)) return false;
    return target.lineage.slice(own.lineage.length).every((id) => this.metadata.get(id)?.parentAccess === "inspect");
  }
  issueAgentPrincipal(parentCapability: object, parentScope: WorkspaceScope, childScope: WorkspaceScope): Principal {
    this.assert(parentCapability, parentScope, "agent.manage");
    this.assertChild(childScope, parentScope.workspaceId);
    const workspace = this.workspaceInfo(childScope.workspaceId);
    if (workspace.ownerAgentId !== childScope.agentId || !this.activeLineage(workspace.id)) {
      throw new HostError(-32003, "Only an active, published owning agent may receive a scoped identity.");
    }
    const permissions: readonly HostPermission[] = Object.freeze([
      "work:read", "work:write", "agents:read", "agents:write", "automations:read", "automations:write",
      "settings:read", "computer:read", "runtime:execute", "events:read", "diagnostics:read",
    ]);
    const principal: Principal = Object.freeze({
      id: childScope.agentId, agentId: childScope.agentId, kind: "agent", workspaceId: workspace.id, permissions,
    });
    this.agentIdentities.set(principal, { workspaceId: workspace.id, agentId: childScope.agentId, lineage: [...workspace.lineage] });
    return principal;
  }
  async scopedCapability(principal: Principal, workspaceId: string, permission: HostPermission): Promise<Capability> {
    if (!this.canAccess(principal, workspaceId, permission)) throw new HostError(-32003, "The exact workspace lineage is not authorized.");
    const scope = this.businessScope(workspaceId);
    const readOnly = permission.endsWith(":read");
    const permissions: Permission[] = readOnly ? ["workspace.read", "artifact.read"]
      : ["workspace.read", "workspace.append", "workspace.create", "agent.manage", "task.manage", "run.execute", "artifact.read", "artifact.write"];
    const capability = await this.security.authorize(this.principal, {
      ...scope, taskId: null, permissions, expiresAt: Date.now() + 300_000,
      resources: [`agent:${scope.agentId}`, ...this.workspaceInfo(workspaceId).lineage.map((id) => `workspace:${id}`)],
    });
    this.scopedDelegations.set(capability, principal);
    this.capabilityActors.set(capability, principal);
    return capability;
  }
  withActor<T>(principal: Principal, action: () => Promise<T>): Promise<T> {
    if (!this.isHuman(principal) && !this.isAgent(principal)) throw new HostError(-32003, "An authenticated workspace actor is required.");
    return this.actor.run(principal, action);
  }
  async workspace(scope: WorkspaceScope, capability?: object): Promise<AgentWorkspace> {
    const selected = capability ?? await this.capability(scope);
    this.assert(selected, scope, "workspace.read");
    return this.store.open(selected as Capability);
  }
  read(scope: WorkspaceScope) {
    return this.capability(scope).then((capability) => this.work.read(capability, scope));
  }
  revision(scope: WorkspaceScope): number { return this.generations.get(scope.workspaceId) ?? 0; }
  async commit(
    scope: WorkspaceScope, key: string, operation: string, payload: unknown, effect: AuthorizedEffect,
    resources: WorkCommand["resources"] = [], signal?: AbortSignal, expectedHeads?: Heads,
  ): Promise<WorkCommitResult> {
    const selected = [
      { kind: "agent" as const, id: scope.agentId }, { kind: "workspace" as const, id: scope.workspaceId }, ...resources,
    ];
    return this.work.commit(await this.capability(scope, selected.map((item) => `${item.kind}:${item.id}`)), {
      scope, idempotencyKey: key, operation, payload: json(payload), resources: selected,
    }, effect, { ...(signal ? { signal } : {}), ...(expectedHeads ? { expectedHeads } : {}) });
  }
  utc(snapshot: WorkspaceSnapshot): string {
    return new Date(Math.max(Date.now(), ...Object.values(snapshot.heads).map((head) => head ? Date.parse(head.utc) : 0))).toISOString();
  }
  async appendSecurity(
    scope: WorkspaceScope, capability: object, data: JsonObject, subject: string, refs: readonly string[] = [],
    expected?: WorkspaceHeads,
  ): Promise<FrameProof> {
    this.assert(capability, scope, "workspace.append");
    const workspace = await this.workspace(scope, capability);
    return workspace.withExclusive(async (transaction) => {
      const before = await transaction.scan();
      const heads = expected ?? before.heads;
      const source = buildFrame({
        kind: data.type === "approval.requested" ? "memory.save" : "memory.tool-call",
        streamId: workspace.identity.memory_stream, utc: this.utc(before), head: heads.memory,
        payload: { subject, data, protocol_revision: AUTHORITY_IDENTITY },
      });
      const evidence = buildEvidenceFrame({
        streamId: workspace.identity.body_stream, utc: source.utc, head: heads.body,
        subject, eventKind: String(data.type), dataHash: digest(data),
        referenceHashes: [...new Set([source.frame_hash, source.payload_hash, ...refs])].sort(),
      });
      const after = await transaction.compareAndAppend({ expectedHeads: heads, frames: [source, evidence] });
      return this.frameProof(after, source.frame_hash, evidence.frame_hash);
    });
  }
  frameProof(snapshot: WorkspaceSnapshot, sourceFrameHash: string, evidenceFrameHash: string): FrameProof {
    if (!isVerifiedChain(snapshot.streams.body) || !isVerifiedChain(snapshot.streams.memory)) throw new Error("Missing scanned security streams.");
    return { body: snapshot.streams.body, memory: snapshot.streams.memory, sourceFrameHash, evidenceFrameHash };
  }
  consumeGuestTransport(permit: object, scope: WorkspaceScope, intentRef: string, input: unknown): void {
    const selected = this.permits.get(permit);
    if (!selected?.entered || selected.guestConsumed || selected.context.intentRef !== intentRef
      || selected.context.command.operation !== "computer.execute") throw new Error("No scoped guest transport permit.");
    const payload = selected.context.command.payload as JsonObject;
    const request = input as { argv: readonly string[]; cwd: string; timeoutMs: number; readOnly?: boolean };
    if (canonicalJson(payload.owner) !== canonicalJson(scope) || canonicalJson(payload.argv) !== canonicalJson(request.argv)
      || payload.cwd !== request.cwd || payload.timeoutMs !== request.timeoutMs
      || payload.readOnly !== (request.readOnly ?? false)) throw new Error("Guest transport arguments differ from the committed intent.");
    this.assert(selected.capability, this.identity.computer, "run.execute");
    selected.guestConsumed = true;
  }
  subscribe(listener: (workspaceId: string, event: WorkEvent) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  changed(area: Area, entityId: string, scope: WorkspaceScope): void {
    if (!this.opened || this.closed) return;
    const event: WorkEvent = { id: randomUUID(), area, entityId, kind: "updated", at: new Date().toISOString() };
    for (const listener of this.listeners) {
      try { listener(scope.workspaceId === this.identity.computer.workspaceId ? this.identity.catalog.workspaceId : scope.workspaceId, event); } catch { /* A projection listener cannot change canonical commit status. */ }
    }
  }
  private entity(command: WorkCommand): string {
    return command.resources.find((item) => item.kind === "task")?.id ?? command.scope.agentId;
  }
  async check() {
    if (!this.opened || this.closed) return { state: "unavailable" as const, detail: "Canonical workspace persistence is not open." };
    await (await this.workspace(this.identity.catalog)).scan();
    return { state: "ready" as const, detail: "Private agent workspaces; canonical frames scanned from committed manifests." };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true; this.listeners.clear(); this.security.revokePrincipal(this.principal);
    this.releaseHost?.();
    await this.hostLock;
  }
}
