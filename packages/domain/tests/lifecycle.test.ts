import { describe, expect, it } from "vitest";
import {
  buildEvidenceFrame, buildFrame, frameHead, hashValue, mintIdentity, PARTICLE_DOMAIN, prepareEvidenceContext, scanChain, selectChainTrust,
  type RappFrame,
} from "@rapp-work/rapp1";
import { buildLifecyclePayload, EVENT_REFERENCE_SCHEMA, LIFECYCLE_SCHEMA, lifecycleKind, verifyLifecycleSource, type LifecycleIntent } from "../src/index.js";

describe("canonical lifecycle source profile", () => {
  it("uses registered memory kinds and exact occurrence-bound evidence without promotion-grade claims", () => {
    const stream = mintIdentity("test-owner", "lifecycle");
    const intent = buildFrame({ kind: "body.pulse", streamId: stream, head: null, utc: "2026-09-12T00:00:00.000Z", payload: { marker: "write-ahead" } });
    const data: LifecycleIntent = {
      schema: LIFECYCLE_SCHEMA, type: "operation.intent", agent_id: "agent-a", workspace_id: "workspace-a",
      principal_id: "owner", request_hash: "a".repeat(64), work_intent_hash: intent.frame_hash,
      operation: "twin.message", request: { message: "Untrusted input" }, reference_hashes: [intent.frame_hash],
    };
    const source = buildFrame({ kind: lifecycleKind(data.type), streamId: `${stream}:work`, head: null,
      utc: intent.utc, payload: buildLifecyclePayload(data) });
    const evidence = buildEvidenceFrame({ streamId: stream, head: frameHead(intent), utc: intent.utc,
      subject: source.payload.subject, eventKind: data.type, dataHash: hashValue(PARTICLE_DOMAIN, data),
      referenceHashes: [source.frame_hash, source.payload_hash, intent.frame_hash].sort() });
    const scanned = (frames: RappFrame[]) => {
      const first = frames[0]!;
      const result = scanChain(frames, selectChainTrust({
        genesis: { stream_id: first.stream_id, frame_hash: first.frame_hash, payload_hash: first.payload_hash },
        persistedHead: frameHead(frames.at(-1)!), requireCommittedHead: true,
      }));
      if (!result.ok) throw result.error;
      return result;
    };
    const body = scanned([intent, evidence]), memory = scanned([source]);
    const reference = { schema: EVENT_REFERENCE_SCHEMA, source_frame_hash: source.frame_hash, evidence_frame_hash: evidence.frame_hash,
      event_kind: "operation.intent", ordinal: 0 };
    expect(verifyLifecycleSource({ body, memory, reference, agentId: "agent-a", workspaceId: "workspace-a",
      requestHash: data.request_hash, intentHash: intent.frame_hash }).frame.kind).toBe("memory.tool-call");
    expect(body.trust).toMatchObject({ classification: "integrity-only", promotionGrade: false, persistedHead: "matched" });
    expect(() => verifyLifecycleSource({ body, memory, reference, agentId: "agent-b", workspaceId: "workspace-a",
      requestHash: data.request_hash, intentHash: intent.frame_hash })).toThrow();
    expect(() => verifyLifecycleSource({ body, memory, reference: { ...reference, evidence_frame_hash: intent.frame_hash },
      agentId: "agent-a", workspaceId: "workspace-a", requestHash: data.request_hash, intentHash: intent.frame_hash })).toThrow();
    const evidenceContext = prepareEvidenceContext(body, memory);
    expect(verifyLifecycleSource({ body, memory, evidenceContext, reference, agentId: "agent-a", workspaceId: "workspace-a",
      requestHash: data.request_hash, intentHash: intent.frame_hash }).frame.frame_hash).toBe(source.frame_hash);
    expect(() => verifyLifecycleSource({ body, memory, evidenceContext: {} as never, reference, agentId: "agent-a",
      workspaceId: "workspace-a", requestHash: data.request_hash, intentHash: intent.frame_hash })).toThrow();
    expect(lifecycleKind("message.recorded")).toBe("memory.chat-turn");
    expect(lifecycleKind("workspace.created")).toBe("memory.save");
    expect(lifecycleKind("twin.proposed")).toBe("memory.save");
  });
});
