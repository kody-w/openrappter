export interface EstateBuddyEvidenceSource {
  filename: string;
  mimeType: string;
  kind: "video" | "audio" | "document";
}

export interface EstateBuddyEvidenceInput {
  evidenceText: string;
  sourceFiles: EstateBuddyEvidenceSource[];
  steering?: string;
}

export interface EstateBuddyEvidenceDraft {
  ok: true;
  schema: "openrappter-estate-buddy-draft/1.0";
  name: string;
  role: string;
  ui: "auto" | "chat" | "rapplication";
  evidenceSummary: string;
  confidence: "high" | "medium" | "low";
  sourceFiles: EstateBuddyEvidenceSource[];
  privacy: {
    masked: boolean;
    findings: Array<{
      path: string;
      kind: string;
      count: number;
    }>;
  };
}
