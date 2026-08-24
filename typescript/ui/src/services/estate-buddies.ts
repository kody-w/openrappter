import { gateway } from "./gateway.js";

const ESTATE_OPERATION_TIMEOUT_MS = 10 * 60_000;

export interface EstateBuddy {
  id: string;
  name: string;
  device: string;
  rappid: string | null;
  presence: "online" | "offline";
  status: "ready" | "offline";
  transport: "local" | "ssh-posix" | "ssh-windows";
  via_probe: boolean;
  ui?: "chat" | "rapplication" | null;
  application_url?: string | null;
  default_chat_url?: string | null;
}

export interface EstateBuddyList {
  ok: true;
  estate: string;
  devices: string[];
  buddies: EstateBuddy[];
}

export interface EstateBuddyReply {
  ok: true;
  buddy: EstateBuddy;
  response: string;
  session_id?: string | null;
  responded_at?: string | null;
}

export interface EstateBuddyCreation {
  ok: true;
  device: string;
  presence: "online";
  created: {
    name: string;
    rappid: string;
    ui: "chat" | "rapplication";
  };
  handshake: {
    ready: true;
    response: string;
  };
}

export interface EstateBuddyEvidenceSource {
  filename: string;
  mimeType: string;
  kind: "video" | "audio" | "document";
}

export interface EstateBuddyDraft {
  ok: true;
  schema: "openrappter-estate-buddy-draft/1.0";
  name: string;
  role: string;
  ui: "auto" | "chat" | "rapplication";
  evidenceSummary: string;
  confidence: "high" | "medium" | "low";
  sourceFiles: EstateBuddyEvidenceSource[];
}

export async function listEstateBuddies(): Promise<EstateBuddyList> {
  return gateway.request<EstateBuddyList>(
    "estate.buddies.list",
    {},
    { timeoutMs: ESTATE_OPERATION_TIMEOUT_MS },
  );
}

export async function chatWithEstateBuddy(input: {
  buddyId: string;
  message: string;
  sessionId?: string;
}): Promise<EstateBuddyReply> {
  return gateway.request<EstateBuddyReply>("estate.buddies.chat", input, {
    timeoutMs: ESTATE_OPERATION_TIMEOUT_MS,
  });
}

export async function createEstateBuddy(input: {
  deviceId: string;
  name: string;
  role: string;
  ui: "auto" | "chat" | "rapplication";
}): Promise<EstateBuddyCreation> {
  return gateway.request<EstateBuddyCreation>("estate.buddies.create", input, {
    timeoutMs: ESTATE_OPERATION_TIMEOUT_MS,
  });
}

export async function analyzeEstateBuddyEvidence(input: {
  evidenceText: string;
  sourceFiles: EstateBuddyEvidenceSource[];
  steering?: string;
}): Promise<EstateBuddyDraft> {
  return gateway.request<EstateBuddyDraft>("estate.buddies.analyze", input, {
    timeoutMs: ESTATE_OPERATION_TIMEOUT_MS,
  });
}
