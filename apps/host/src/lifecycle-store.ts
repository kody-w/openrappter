import {
  buildLifecyclePayload, EVENT_REFERENCE_SCHEMA, LIFECYCLE_RECEIPT, LIFECYCLE_SCHEMA, RESULT_REFERENCE_SCHEMA,
  lifecycleKind, validateLifecyclePayload, validateSourceReference, verifyLifecycleSource,
  type LifecycleData, type LifecycleEvent, type LifecycleEventType, type LifecycleIntent, type LifecycleOutcome, type SourceReference,
} from "@rapp-work/domain";
import {
  buildEvidenceFrame, buildFrame, canonicalJson, EVIDENCE_SCHEMA, frameHead, HEX64, isVerifiedChain, snapshotJson,
  prepareEvidenceContext, type EvidenceContext, type JsonObject, type RappFrame,
} from "@rapp-work/rapp1";
import type { AgentWorkspace, WorkspaceSnapshot, WorkspaceTransaction } from "@rapp-work/workspace-store";
import type { AuthorizationRequest, CommittedCommand, EffectOutcome, WorkspaceScope } from "@rapp-work/work-service";
import {
  agentSchema, automationSchema, taskSchema, twinDraftSchema, twinTurnSchema, workspaceOrganizationSchema, workspaceSummarySchema,
} from "./contracts.js";
import { HostError } from "./errors.js";

type Request = AuthorizationRequest & { intentRef: string };
interface Dependencies {
  workspace(capability: object, scope: WorkspaceScope): Promise<AgentWorkspace>;
  digest(value: unknown): string;
  observe(snapshot: WorkspaceSnapshot): void;
  utc(snapshot: WorkspaceSnapshot): string;
  isConcierge(scope: WorkspaceScope): boolean;
}
const json = (value: unknown) => snapshotJson(value);
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const references = (value: unknown): string[] => {
  const hashes = new Set<string>();
  const visit = (item: unknown, depth: number) => {
    if (depth > 16) return;
    if (typeof item === "string" && HEX64.test(item)) hashes.add(item);
    else if (Array.isArray(item)) for (const nested of item) visit(nested, depth + 1);
    else if (object(item)) for (const nested of Object.values(item)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return [...hashes].sort().slice(0, 240);
};
const unique = (...sets: readonly string[][]): string[] => [...new Set(sets.flat())].sort();

export function eventType(event: JsonObject, operation: string): LifecycleEventType {
  switch (event.type) {
    case "twin.turn": return "message.recorded";
    case "twin.proposal": return (event.proposal as JsonObject).kind === "clarification" ? "twin.clarified" : "twin.proposed";
    case "twin.event": {
      const kind = (event.event as JsonObject).kind;
      return kind === "accept" ? event.edited === true ? "proposal.edited" : "proposal.applied" : kind === "dismiss" ? "proposal.dismissed" : "state.recorded";
    }
    case "workspace.saved": {
      const workspace = event.workspace as JsonObject;
      return operation === "host.workspace.bootstrap" ? "workspace.created" : workspace.status === "archived" ? "workspace.archived"
        : workspace.status === "paused" ? "workspace.paused" : event.change === "renamed" ? "workspace.renamed" : "workspace.updated";
    }
    case "workspace.evolved": return "workspace.evolved";
    case "catalog.workspace": return "workspace.linked";
    case "ui.agent.saved": return (event.agent as JsonObject).retiredAt ? "agent.retired" : event.change === "created" ? "agent.created" : "agent.configured";
    case "catalog.agent": case "catalog.agent.retired": return "agent.linked";
    case "ui.automation.saved":
      return operation === "host.automation.fire" ? "routine.fired" : (event.automation as JsonObject).enabled ? "routine.enabled"
        : event.change === "paused" || operation.includes("quarantine") ? "routine.paused" : "routine.drafted";
    case "catalog.automation": return "routine.linked";
    case "routine.fired": return "routine.fired";
    case "ui.task.saved": return operation === "task.create" ? "task.created" : "task.updated";
    case "catalog.task": return "task.linked";
    case "catalog.task.removed": return "task.released";
    case "ui.run.saved": return "run.updated";
    case "ui.approval.saved": return "approval.updated";
    case "ui.artifact.saved": return "artifact.registered";
    default: return String(event.type).startsWith("computer.") ? "computer.updated" : "state.recorded";
  }
}

/** Source/evidence pairs are authority. Work triples contain references, not a second event store. */
export class LifecycleStore {
  private readonly evidenceContexts = new WeakMap<WorkspaceSnapshot, EvidenceContext>();
  constructor(private readonly dependencies: Dependencies) {}

  private common(snapshot: WorkspaceSnapshot, request: Request) {
    const intent = snapshot.streams.body.frames.find((frame) => frame.frame_hash === request.intentRef);
    if (!intent || intent.payload.type !== "work.intent" || intent.payload.commandHash !== request.commandHash
      || this.dependencies.digest(intent.payload.command) !== this.dependencies.digest(request.command)) {
      throw new Error("Lifecycle source has no matching canonical request intent.");
    }
    return {
      schema: LIFECYCLE_SCHEMA, agent_id: request.command.scope.agentId, workspace_id: request.command.scope.workspaceId,
      principal_id: String(intent.payload.principalId), request_hash: request.commandHash,
      work_intent_hash: request.intentRef, operation: request.command.operation,
    } as const;
  }
  private verify(snapshot: WorkspaceSnapshot, reference: SourceReference, request: Request) {
    if (!isVerifiedChain(snapshot.streams.body) || !isVerifiedChain(snapshot.streams.memory)) throw new Error("Canonical source and evidence streams are unavailable.");
    let evidenceContext = this.evidenceContexts.get(snapshot);
    if (!evidenceContext) {
      evidenceContext = prepareEvidenceContext(snapshot.streams.body, snapshot.streams.memory);
      this.evidenceContexts.set(snapshot, evidenceContext);
    }
    return verifyLifecycleSource({
      body: snapshot.streams.body, memory: snapshot.streams.memory, reference,
      agentId: request.command.scope.agentId, workspaceId: request.command.scope.workspaceId,
      requestHash: request.commandHash, intentHash: request.intentRef,
      evidenceContext,
    });
  }
  private findIntent(snapshot: WorkspaceSnapshot, request: Request): SourceReference | null {
    const matches = snapshot.streams.memory.frames.filter((frame) => {
      const data = frame.payload.data;
      return object(data) && data.schema === LIFECYCLE_SCHEMA && data.type === "operation.intent" && data.request_hash === request.commandHash;
    });
    if (matches.length > 1) throw new Error("A canonical request has multiple lifecycle intents.");
    const source = matches[0];
    if (!source) return null;
    const proofs = snapshot.streams.body.frames.filter((frame) => frame.payload.schema === EVIDENCE_SCHEMA
      && frame.payload.event_kind === "operation.intent" && Array.isArray(frame.payload.reference_hashes)
      && frame.payload.reference_hashes.includes(source.frame_hash) && frame.payload.reference_hashes.includes(source.payload_hash));
    if (proofs.length !== 1) throw new Error("The lifecycle intent evidence is missing or ambiguous.");
    const reference: SourceReference = {
      schema: EVENT_REFERENCE_SCHEMA, source_frame_hash: source.frame_hash, evidence_frame_hash: proofs[0]!.frame_hash,
      event_kind: "operation.intent", ordinal: 0,
    };
    const verified = this.verify(snapshot, reference, request);
    if (verified.payload.data.type !== "operation.intent"
      || this.dependencies.digest(verified.payload.data.request) !== this.dependencies.digest(request.command)) {
      throw new Error("The lifecycle intent request was substituted.");
    }
    return reference;
  }
  private batch(snapshot: WorkspaceSnapshot) {
    let body = snapshot.heads.body, memory = snapshot.heads.memory;
    const frames: RappFrame[] = [];
    const append = (data: LifecycleData): SourceReference => {
      const payload = buildLifecyclePayload(data);
      const source = buildFrame({ kind: lifecycleKind(data.type), streamId: snapshot.identity.memory_stream,
        utc: this.dependencies.utc(snapshot), head: memory, payload });
      memory = frameHead(source);
      const evidence = buildEvidenceFrame({ streamId: snapshot.identity.body_stream, utc: source.utc, head: body,
        eventKind: data.type, subject: payload.subject, dataHash: this.dependencies.digest(data),
        referenceHashes: unique(data.reference_hashes, [source.frame_hash, source.payload_hash]) });
      body = frameHead(evidence);
      frames.push(source, evidence);
      return { schema: EVENT_REFERENCE_SCHEMA, source_frame_hash: source.frame_hash, evidence_frame_hash: evidence.frame_hash,
        event_kind: data.type, ordinal: typeof data.ordinal === "number" ? data.ordinal : 0 };
    };
    return { frames, append };
  }
  private async append(transaction: WorkspaceTransaction, before: WorkspaceSnapshot, frames: RappFrame[]) {
    const after = await transaction.compareAndAppend({ expectedHeads: before.heads, frames });
    this.dependencies.observe(after);
    return after;
  }
  private triggeringConversation(snapshot: WorkspaceSnapshot, event: JsonObject, request: Request): void {
    const source = snapshot.streams.memory.frames.find((frame) => frame.frame_hash === event.conversationFrameHash);
    if (!source || source.kind !== "memory.chat-turn") throw new Error("Evolution has no canonical triggering user turn.");
    const data = validateLifecyclePayload(source.payload).data;
    if (data.type !== "message.recorded" || data.operation !== "twin.user" || (data.event.turn as JsonObject).role !== "user"
      || data.workspace_id !== request.command.scope.workspaceId || (data.event.turn as JsonObject).id !== event.triggerTurnId) {
      throw new Error("Evolution references another conversation.");
    }
    this.verify(snapshot, {
      schema: EVENT_REFERENCE_SCHEMA, source_frame_hash: source.frame_hash, evidence_frame_hash: String(event.conversationEvidenceHash),
      event_kind: "message.recorded", ordinal: data.ordinal,
    }, { command: request.command, commandHash: data.request_hash, intentRef: data.work_intent_hash, heads: request.heads });
    const publication = snapshot.streams.body.frames.find((frame) => frame.frame_hash === event.conversationPublicationHash);
    const intent = snapshot.streams.body.frames.find((frame) => frame.frame_hash === data.work_intent_hash);
    const userRequest = intent?.payload.command as JsonObject | undefined;
    if (!publication || publication.payload.type !== "work.evidence" || publication.payload.commandHash !== data.request_hash
      || publication.payload.intentRef !== data.work_intent_hash || !userRequest
      || String(userRequest.idempotencyKey).replace("twin/user/", "twin/message/") !== request.command.idempotencyKey
      || this.dependencies.digest(userRequest.payload) !== this.dependencies.digest(request.command.payload)) {
      throw new Error("Evolution requires the exact committed triggering request, not a success flag or unrelated turn.");
    }
  }
  async recordIntent(capability: object, request: Request): Promise<SourceReference> {
    const workspace = await this.dependencies.workspace(capability, request.command.scope);
    return workspace.withExclusive(async (transaction) => {
      const before = await transaction.scan(); this.dependencies.observe(before);
      const existing = this.findIntent(before, request);
      if (existing) return existing;
      const data: LifecycleIntent = {
        ...this.common(before, request), type: "operation.intent", request: json(request.command) as JsonObject,
        reference_hashes: [request.intentRef],
      };
      const batch = this.batch(before), reference = batch.append(data);
      const after = await this.append(transaction, before, batch.frames);
      this.verify(after, reference, request);
      return reference;
    });
  }
  async recordOutcome(capability: object, request: Request, outcome: EffectOutcome): Promise<EffectOutcome> {
    const workspace = await this.dependencies.workspace(capability, request.command.scope);
    return workspace.withExclusive(async (transaction) => {
      const before = await transaction.scan(); this.dependencies.observe(before);
      const common = this.common(before, request), batch = this.batch(before);
      let intent = this.findIntent(before, request);
      if (!intent) {
        if (!["denied", "cancelled"].includes(outcome.status) || !outcome.receipts.every((receipt) => receipt.kind === "no-effect")) {
          throw new Error("An executed effect cannot manufacture a missing write-ahead source after the fact.");
        }
        intent = batch.append({ ...common, type: "operation.intent", request: json(request.command) as JsonObject, reference_hashes: [request.intentRef] });
      }
      const events: SourceReference[] = [];
      const normalized: JsonObject[] = [];
      for (const [ordinal, original] of outcome.events.entries()) {
        let event = json(original) as JsonObject;
        if (event.type === "workspace.evolved") {
          const proposalIndex = normalized.findIndex((candidate) => candidate.type === "twin.proposal"
            && (candidate.proposal as JsonObject).id === event.proposalId);
          if (proposalIndex < 0 || typeof event.conversationFrameHash !== "string" || typeof event.proposalHash !== "string") {
            throw new Error("Workspace evolution requires exact conversation and proposal references.");
          }
          this.triggeringConversation(before, event, request);
          const proposal = normalized[proposalIndex]!.proposal as JsonObject;
          if ((proposal.basis as JsonObject).proposalHash !== event.proposalHash) throw new Error("Evolution proposal hash differs.");
          event = { ...event, proposalFrameHash: events[proposalIndex]!.source_frame_hash };
        }
        if (event.type === "twin.event" && (event.event as JsonObject).kind === "evolution") {
          const index = normalized.findIndex((candidate) => candidate.type === "workspace.evolved");
          if (index < 0) throw new Error("An evolution receipt requires its canonical workspace transition.");
          const evolution = normalized[index]!;
          event = { ...event, event: { ...(event.event as JsonObject), references: {
            conversationFrameHash: evolution.conversationFrameHash!, proposalFrameHash: evolution.proposalFrameHash!,
            proposalHash: evolution.proposalHash!, evolutionFrameHash: events[index]!.source_frame_hash,
          } } };
        }
        this.validateEvent(event, request.command.scope);
        const data: LifecycleEvent = {
          ...common, type: eventType(event, request.command.operation), intent_frame_hash: intent.source_frame_hash,
          ordinal, event, reference_hashes: unique([request.intentRef, intent.source_frame_hash, intent.evidence_frame_hash], references(event)),
        };
        const reference = batch.append(data);
        events.push(reference); normalized.push(event);
      }
      let resultSource: LifecycleOutcome["result_source"] = null;
      for (const [index, event] of normalized.entries()) {
        for (const [field, value] of Object.entries(event)) if (this.dependencies.digest(value) === this.dependencies.digest(outcome.value)) {
          resultSource = { source_frame_hash: events[index]!.source_frame_hash, field };
          break;
        }
        if (resultSource) break;
      }
      const data: LifecycleOutcome = {
        ...common, type: "operation.outcome", intent_frame_hash: intent.source_frame_hash, status: outcome.status,
        result: resultSource ? null : json(outcome.value), result_source: resultSource, events,
        receipts: outcome.receipts.map((receipt) => json(receipt) as JsonObject),
        reference_hashes: unique([request.intentRef, intent.source_frame_hash, intent.evidence_frame_hash],
          events.flatMap((event) => [event.source_frame_hash, event.evidence_frame_hash]), references(outcome.receipts)),
      };
      const terminal = batch.append(data);
      const after = await this.append(transaction, before, batch.frames);
      for (const reference of [intent, ...events, terminal]) this.verify(after, reference, request);
      return {
        status: outcome.status,
        value: { schema: RESULT_REFERENCE_SCHEMA, source_frame_hash: terminal.source_frame_hash },
        events, receipts: [{ kind: LIFECYCLE_RECEIPT, intent, outcome: terminal, events }],
      };
    });
  }
  private publicationHeads(snapshot: WorkspaceSnapshot, command: CommittedCommand) {
    const body = snapshot.streams.body.frames.find((frame) => frame.frame_hash === command.proof.evidenceRef);
    if (!body) throw new Error("Canonical command publication evidence is missing.");
    const earlier = new Set(snapshot.streams.body.frames.filter((frame) => frame.seq <= body.seq)
      .flatMap((frame) => Array.isArray(frame.payload.reference_hashes) ? frame.payload.reference_hashes as string[] : []));
    const memory = [...snapshot.streams.memory.frames].reverse().find((frame) => earlier.has(frame.frame_hash));
    return { body: body.frame_hash, memory: memory?.frame_hash ?? null, swarm: snapshot.heads.swarm?.frame_hash ?? null };
  }
  project(command: CommittedCommand, snapshot: WorkspaceSnapshot): CommittedCommand {
    if (snapshot.identity.agent_id !== command.command.scope.agentId || snapshot.identity.workspace_id !== command.command.scope.workspaceId) {
      throw new Error("The source scan belongs to another workspace.");
    }
    const receipt = command.receipts.find((receipt) => receipt.kind === LIFECYCLE_RECEIPT);
    if (!receipt || command.receipts.length !== 1 || !object(command.value)
      || command.value.schema !== RESULT_REFERENCE_SCHEMA) {
      throw new HostError(-32012, "Canonical lifecycle sources are missing. Body-only history is unresolved, not projection authority.");
    }
    const intent = validateSourceReference(receipt.intent), terminal = validateSourceReference(receipt.outcome);
    const request: Request = { command: command.command, commandHash: command.commandHash, heads: command.proof.heads, intentRef: command.proof.intentRef };
    const intentSource = this.verify(snapshot, intent, request), outcomeSource = this.verify(snapshot, terminal, request);
    if (intentSource.payload.data.type !== "operation.intent" || outcomeSource.payload.data.type !== "operation.outcome") throw new Error("Wrong lifecycle intent/outcome kind.");
    const data = outcomeSource.payload.data;
    if (data.intent_frame_hash !== intent.source_frame_hash || data.status !== command.status
      || data.principal_id !== command.principalId || data.operation !== command.command.operation
      || command.value.source_frame_hash !== terminal.source_frame_hash
      || this.dependencies.digest(intentSource.payload.data.request) !== this.dependencies.digest(command.command)
      || canonicalJson(data.events) !== canonicalJson(command.events)
      || canonicalJson(receipt.events) !== canonicalJson(data.events)) {
      throw new Error("Request-bound lifecycle intent, outcome or source references differ.");
    }
    const sources = new Map<string, JsonObject>();
    const events = data.events.map((reference, ordinal) => {
      const source = this.verify(snapshot, reference, request);
      const event = source.payload.data;
      if (event.type === "operation.intent" || event.type === "operation.outcome" || event.ordinal !== ordinal
        || event.intent_frame_hash !== intent.source_frame_hash || event.operation !== command.command.operation
        || event.principal_id !== command.principalId || eventType(event.event, command.command.operation) !== event.type) {
        throw new Error("Foreign or reordered domain lifecycle source.");
      }
      this.validateEvent(event.event, command.command.scope);
      sources.set(reference.source_frame_hash, event.event);
      return event.event;
    });
    for (const event of events) if (event.type === "workspace.evolved") {
      const proposal = sources.get(String(event.proposalFrameHash));
      const conversation = snapshot.streams.memory.frames.find((frame) => frame.frame_hash === event.conversationFrameHash);
      if (!proposal || proposal.type !== "twin.proposal" || !conversation || conversation.kind !== "memory.chat-turn"
        || (proposal.proposal as JsonObject).id !== event.proposalId
        || ((proposal.proposal as JsonObject).basis as JsonObject).proposalHash !== event.proposalHash) {
        throw new Error("Evolution is not bound to its exact conversation and proposal.");
      }
      this.triggeringConversation(snapshot, event, request);
    }
    let value = data.result;
    if (data.result_source) {
      const source = sources.get(data.result_source.source_frame_hash);
      if (!source || !Object.hasOwn(source, data.result_source.field)) throw new Error("The canonical result source is missing.");
      value = source[data.result_source.field]!;
    }
    return {
      ...command, value, events, receipts: [...data.receipts, receipt],
      proof: { ...command.proof, heads: this.publicationHeads(snapshot, command) },
    };
  }
  private validateEvent(event: JsonObject, scope: WorkspaceScope): void {
    switch (event.type) {
      case "twin.turn": {
        const turn = twinTurnSchema.parse(event.turn);
        if (turn.workspaceId === null ? !this.dependencies.isConcierge(scope) : turn.workspaceId !== scope.workspaceId) throw new Error("Foreign conversation turn.");
        break;
      }
      case "twin.proposal": {
        const proposal = twinDraftSchema.parse(event.proposal);
        if (proposal.workspaceId === null ? !this.dependencies.isConcierge(scope) : proposal.workspaceId !== scope.workspaceId) throw new Error("Foreign Twin proposal.");
        break;
      }
      case "workspace.saved": {
        const workspace = workspaceSummarySchema.parse(event.workspace);
        if (workspace.id !== scope.workspaceId || workspace.catalogScope.agentId !== scope.agentId) throw new Error("Foreign workspace domain source.");
        break;
      }
      case "workspace.evolved":
        workspaceOrganizationSchema.parse(event.organization);
        if (event.workspaceId !== scope.workspaceId) throw new Error("Foreign workspace evolution."); break;
      case "ui.agent.saved": {
        const agent = agentSchema.parse(event.agent);
        if (agent.id !== scope.agentId || agent.workspaceId !== scope.workspaceId) throw new Error("Foreign agent domain source."); break;
      }
      case "ui.task.saved": {
        const task = taskSchema.parse(event.task);
        if (task.agentId !== null && (task.agentId !== scope.agentId || task.workspaceId !== scope.workspaceId)) throw new Error("Foreign task domain source."); break;
      }
      case "ui.automation.saved": {
        const routine = automationSchema.parse(event.automation);
        if (routine.agentId !== scope.agentId || routine.workspaceId !== scope.workspaceId) throw new Error("Foreign routine domain source."); break;
      }
    }
  }
  source(command: CommittedCommand, ordinal: number): SourceReference {
    const receipt = command.receipts.find((receipt) => receipt.kind === LIFECYCLE_RECEIPT);
    if (!receipt || !Array.isArray(receipt.events)) throw new Error("No verified lifecycle source receipt.");
    return validateSourceReference(receipt.events[ordinal]);
  }
  commandFrames(command: CommittedCommand): string[] {
    const receipt = command.receipts.find((receipt) => receipt.kind === LIFECYCLE_RECEIPT);
    if (!receipt) throw new Error("No verified lifecycle receipt.");
    return unique([command.proof.intentRef, command.proof.outcomeRef, command.proof.evidenceRef], references(receipt));
  }
}
