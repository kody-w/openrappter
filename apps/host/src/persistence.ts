import { randomUUID } from "node:crypto";
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
} from "@rapp-work/work-service";
import { HostError } from "./errors.js";
import { idSchema, type Area, type WorkEvent } from "./contracts.js";

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
export function committed(result: WorkCommitResult): CommittedCommand {
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
          const grant = this.assert(capability, command.scope, "workspace.append",
            command.resources.map((resource) => `${resource.kind}:${resource.id}`));
          const permission: Permission = command.operation.includes("approval") ? "approval.decide"
            : command.operation.startsWith("agent.define") ? "agent.manage"
            : command.operation.includes("task") ? "task.manage"
            : /^(model|tool|agent\.run|computer)\./.test(command.operation) ? "run.execute" : "workspace.append";
          this.assert(capability, command.scope, permission);
          return { principalId: grant.principal.id };
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
        if (result.state === "committed" && !result.replayed) this.changed("work", this.entity(command));
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
    for (const command of (await this.read(this.identity.catalog)).commands) {
      if (command.state !== "committed" || command.status !== "succeeded") continue;
      for (const event of command.events) {
        if (event.type === "catalog.agent") this.register(scopeSchema.parse(event.scope));
      }
    }
  }
  register(scope: WorkspaceScope): void {
    scopeSchema.parse(scope);
    const existing = this.scopes.get(scope.agentId);
    if (existing && existing.workspaceId !== scope.workspaceId) throw new Error("An agent cannot change its minted workspace.");
    if ([...this.scopes.values()].some((item) => item.workspaceId === scope.workspaceId && item.agentId !== scope.agentId)) {
      throw new Error("A workspace has exactly one state owner.");
    }
    this.scopes.set(scope.agentId, Object.freeze({ ...scope }));
  }
  async mint(scope: WorkspaceScope): Promise<void> {
    this.register(scope);
    await this.store.create(await this.capability(scope), { owner: this.identity.id, slug: `agent-${randomUUID()}` });
  }
  async capability(scope: WorkspaceScope, resources: readonly string[] = []): Promise<Capability> {
    this.owner;
    return this.security.authorize(this.principal, {
      ...scope, taskId: null, permissions: [...PERMISSIONS],
      resources: [...new Set([`agent:${scope.agentId}`, `workspace:${scope.workspaceId}`, ...resources])].sort(),
      expiresAt: Date.now() + 3_600_000,
    });
  }
  assert(capability: object, scope: WorkspaceScope, permission: Permission, resources: readonly string[] = []) {
    this.owner;
    return this.security.assertCapability(capability as Capability, permission, { ...scope, taskId: null }, resources);
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
    resources: WorkCommand["resources"] = [], signal?: AbortSignal,
  ): Promise<WorkCommitResult> {
    const selected = [
      { kind: "agent" as const, id: scope.agentId }, { kind: "workspace" as const, id: scope.workspaceId }, ...resources,
    ];
    return this.work.commit(await this.capability(scope, selected.map((item) => `${item.kind}:${item.id}`)), {
      scope, idempotencyKey: key, operation, payload: json(payload), resources: selected,
    }, effect, signal ? { signal } : {});
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
  changed(area: Area, entityId: string): void {
    if (!this.opened || this.closed) return;
    const event: WorkEvent = { id: randomUUID(), area, entityId, kind: "updated", at: new Date().toISOString() };
    for (const listener of this.listeners) {
      try { listener(this.identity.catalog.workspaceId, event); } catch { /* A projection listener cannot change canonical commit status. */ }
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
