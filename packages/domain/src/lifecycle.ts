import {
  AUTHORITY_IDENTITY, HEX64, assertOptions, canonicalJson, isJsonObject, isVerifiedChain, snapshotJson,
  verifyEvidenceLink, type EvidenceContext, type JsonObject, type JsonValue, type RappFrame, type VerifiedChain,
} from "@rapp-work/rapp1";
import { assertIdentifier } from "@rapp-work/security";

export const LIFECYCLE_SCHEMA = "rapp-work/lifecycle/1";
export const EVENT_REFERENCE_SCHEMA = "rapp-work/event-ref/1";
export const RESULT_REFERENCE_SCHEMA = "rapp-work/result-ref/1";
export const LIFECYCLE_RECEIPT = "rapp-work/lifecycle-proof";
export const lifecycleEventTypes = [
  "message.recorded", "twin.proposed", "twin.clarified", "proposal.applied", "proposal.dismissed", "proposal.edited",
  "workspace.created", "workspace.updated", "workspace.renamed", "workspace.paused", "workspace.archived", "workspace.evolved", "workspace.linked",
  "agent.created", "agent.configured", "agent.retired", "agent.linked",
  "routine.drafted", "routine.enabled", "routine.paused", "routine.fired", "routine.updated", "routine.linked",
  "task.created", "task.updated", "task.linked", "task.released", "run.updated", "approval.updated",
  "artifact.registered", "computer.updated", "state.recorded",
] as const;
export type LifecycleEventType = typeof lifecycleEventTypes[number];
export interface SourceReference extends JsonObject {
  schema: typeof EVENT_REFERENCE_SCHEMA;
  source_frame_hash: string;
  evidence_frame_hash: string;
  event_kind: string;
  ordinal: number;
}
interface Common extends JsonObject {
  schema: typeof LIFECYCLE_SCHEMA;
  type: string;
  agent_id: string;
  workspace_id: string;
  principal_id: string;
  request_hash: string;
  work_intent_hash: string;
  operation: string;
  reference_hashes: string[];
}
export interface LifecycleIntent extends Common {
  type: "operation.intent";
  request: JsonObject;
}
export interface LifecycleEvent extends Common {
  type: LifecycleEventType;
  intent_frame_hash: string;
  ordinal: number;
  event: JsonObject;
}
export interface LifecycleOutcome extends Common {
  type: "operation.outcome";
  intent_frame_hash: string;
  status: "succeeded" | "failed" | "denied" | "cancelled";
  result: JsonValue;
  result_source: { source_frame_hash: string; field: string } & JsonObject | null;
  events: SourceReference[];
  receipts: JsonObject[];
}
export type LifecycleData = LifecycleIntent | LifecycleEvent | LifecycleOutcome;
export interface LifecyclePayload extends JsonObject {
  subject: string;
  data: LifecycleData;
  protocol_revision: typeof AUTHORITY_IDENTITY;
}
const commonKeys = ["schema", "type", "agent_id", "workspace_id", "principal_id", "request_hash", "work_intent_hash", "operation", "reference_hashes"];
function hash(value: unknown): asserts value is string {
  if (typeof value !== "string" || !HEX64.test(value)) throw new TypeError("A canonical lowercase frame hash is required.");
}
export function validateSourceReference(input: unknown): SourceReference {
  const value = snapshotJson(input);
  assertOptions(value, ["schema", "source_frame_hash", "evidence_frame_hash", "event_kind", "ordinal"]);
  if (value.schema !== EVENT_REFERENCE_SCHEMA || typeof value.event_kind !== "string"
    || !Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0) throw new TypeError("Invalid canonical source reference.");
  hash(value.source_frame_hash); hash(value.evidence_frame_hash);
  return value as SourceReference;
}
export function lifecycleKind(type: string): "memory.chat-turn" | "memory.save" | "memory.tool-call" {
  if (type === "message.recorded") return "memory.chat-turn";
  if (type === "operation.intent" || type === "operation.outcome" || type.startsWith("proposal.")) return "memory.tool-call";
  if (!(lifecycleEventTypes as readonly string[]).includes(type)) throw new TypeError("Unknown lifecycle event.");
  return "memory.save";
}
export function validateLifecycleData(input: unknown): LifecycleData {
  const value = snapshotJson(input);
  if (!isJsonObject(value) || value.schema !== LIFECYCLE_SCHEMA || typeof value.type !== "string") throw new TypeError("Invalid lifecycle source.");
  const extra = value.type === "operation.intent" ? ["request"] : value.type === "operation.outcome"
    ? ["intent_frame_hash", "status", "result", "result_source", "events", "receipts"]
    : ["intent_frame_hash", "ordinal", "event"];
  assertOptions(value, [...commonKeys, ...extra]);
  lifecycleKind(value.type);
  for (const field of ["agent_id", "workspace_id", "principal_id"]) assertIdentifier(value[field], field);
  hash(value.request_hash); hash(value.work_intent_hash);
  if (typeof value.operation !== "string" || !/^[a-z][a-z0-9_.-]{0,159}$/.test(value.operation)
    || !Array.isArray(value.reference_hashes) || value.reference_hashes.length > 256) throw new TypeError("Invalid request binding.");
  let previous = "";
  for (const reference of value.reference_hashes) {
    hash(reference);
    if (reference <= previous) throw new TypeError("References must be sorted and unique.");
    previous = reference;
  }
  if (value.type === "operation.intent") {
    if (!isJsonObject(value.request!)) throw new TypeError("An intent requires its complete canonical request.");
  } else {
    hash(value.intent_frame_hash);
    if (value.type === "operation.outcome") {
      if (!["succeeded", "failed", "cancelled", "denied"].includes(String(value.status))
        || !Array.isArray(value.events) || !Array.isArray(value.receipts) || value.receipts.length < 1
        || !value.receipts.every(isJsonObject)) throw new TypeError("An outcome requires explicit status and receipts.");
      for (const reference of value.events) validateSourceReference(reference);
      if (value.result_source !== null) {
        assertOptions(value.result_source, ["source_frame_hash", "field"]);
        hash(value.result_source.source_frame_hash);
        if (typeof value.result_source.field !== "string" || value.result_source.field.length > 128) throw new TypeError("Invalid result source.");
        if (value.result !== null) throw new TypeError("A result has one source of authority.");
      }
    } else if (!Number.isSafeInteger(value.ordinal) || (value.ordinal as number) < 0 || !isJsonObject(value.event!)) {
      throw new TypeError("Invalid domain event source.");
    }
  }
  return value as LifecycleData;
}
export function lifecycleSubject(data: LifecycleData): string {
  return `lifecycle:${data.agent_id}/${data.request_hash}/${data.type}/${"ordinal" in data ? data.ordinal : 0}`;
}
export function buildLifecyclePayload(input: LifecycleData): LifecyclePayload {
  const data = validateLifecycleData(input);
  return snapshotJson({ subject: lifecycleSubject(data), data, protocol_revision: AUTHORITY_IDENTITY }) as LifecyclePayload;
}
export function validateLifecyclePayload(input: unknown): LifecyclePayload {
  const value = snapshotJson(input);
  assertOptions(value, ["subject", "data", "protocol_revision"]);
  const data = validateLifecycleData(value.data);
  if (value.subject !== lifecycleSubject(data) || canonicalJson(value.protocol_revision) !== canonicalJson(AUTHORITY_IDENTITY)) {
    throw new TypeError("Lifecycle source subject or authority differs.");
  }
  return value as LifecyclePayload;
}
export function verifyLifecycleSource(input: {
  body: VerifiedChain; memory: VerifiedChain; reference: SourceReference;
  agentId: string; workspaceId: string; requestHash: string; intentHash: string;
  evidenceContext?: EvidenceContext;
}): { frame: RappFrame<LifecyclePayload>; payload: LifecyclePayload } {
  if (!isVerifiedChain(input.body) || !isVerifiedChain(input.memory)) throw new TypeError("Scanned source and evidence chains are required.");
  const reference = validateSourceReference(input.reference);
  const frame = input.memory.frames.find((frame) => frame.frame_hash === reference.source_frame_hash);
  if (!frame) throw new TypeError("The canonical memory source is unavailable.");
  const payload = validateLifecyclePayload(frame.payload);
  const data = payload.data;
  if (frame.kind !== lifecycleKind(data.type) || data.type !== reference.event_kind
    || data.agent_id !== input.agentId || data.workspace_id !== input.workspaceId
    || data.request_hash !== input.requestHash || data.work_intent_hash !== input.intentHash
    || ("ordinal" in data && data.ordinal !== reference.ordinal)) throw new TypeError("Foreign or mismatched lifecycle source.");
  verifyEvidenceLink({
    body: input.body, source: input.memory, sourceFrameHash: frame.frame_hash, evidenceFrameHash: reference.evidence_frame_hash,
    subject: payload.subject, eventKind: data.type, data, requiredReferences: data.reference_hashes,
  }, input.evidenceContext);
  return { frame: frame as RappFrame<LifecyclePayload>, payload };
}
