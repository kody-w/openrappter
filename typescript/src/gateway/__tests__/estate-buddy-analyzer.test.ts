import { describe, expect, it, vi } from "vitest";

import { analyzeEstateBuddyEvidence } from "../estate-buddy-analyzer.js";
import type { LLMProvider } from "../../providers/types.js";

function providerWith(content: string): LLMProvider {
  return {
    id: "test",
    name: "Test provider",
    isAvailable: vi.fn().mockResolvedValue(true),
    chat: vi.fn().mockResolvedValue({
      content,
      tool_calls: null,
    }),
  };
}

describe("estate buddy evidence analyzer", () => {
  it("turns transcript evidence into a bounded verified draft", async () => {
    const provider = providerWith(`\`\`\`json
{
  "name": "Invoice Guide",
  "role": "Reproduce the demonstrated invoice workflow step by step. Read the source invoice, validate the customer and totals, enter the approved fields, pause before submission, and report the resulting reference number. Never submit without explicit approval.",
  "ui": "rapplication",
  "evidenceSummary": "A narrated invoice-entry workflow with a human approval gate.",
  "confidence": "high"
}
\`\`\``);

    const result = await analyzeEstateBuddyEvidence(provider, {
      evidenceText:
        "[00:00] Open the invoice. [00:08] Validate the customer. " +
        "[00:20] Enter totals and ask before submitting.",
      sourceFiles: [
        {
          filename: "invoice-walkthrough.mp4",
          mimeType: "video/mp4",
          kind: "video",
        },
      ],
      steering: "Keep the final submission human-approved.",
    });

    expect(result.name).toBe("Invoice Guide");
    expect(result.ui).toBe("rapplication");
    expect(result.role).toContain("Never submit without explicit approval");
    expect(result).not.toHaveProperty("evidenceText");
    expect(provider.chat).toHaveBeenCalledOnce();
    const messages = vi.mocked(provider.chat).mock.calls[0][0];
    expect(messages[0].content).toContain("invoice-walkthrough.mp4");
    expect(messages[0].content).toContain("Validate the customer");
  });

  it("rejects malformed model output instead of inventing a successful draft", async () => {
    const provider = providerWith('{"name":"Incomplete"}');

    await expect(
      analyzeEstateBuddyEvidence(provider, {
        evidenceText: "A sufficiently long transcript of a demonstrated task.",
        sourceFiles: [
          {
            filename: "transcript.txt",
            mimeType: "text/plain",
            kind: "document",
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("accepts the first complete draft when a CLI backend repeats it", async () => {
    const json = JSON.stringify({
      name: "Workflow Guide",
      role: "Follow the demonstrated workflow and preserve its approval boundary.",
      ui: "chat",
      evidenceSummary: "A demonstrated approval workflow.",
      confidence: "medium",
    });
    const provider = providerWith(`${json}${json}`);

    const result = await analyzeEstateBuddyEvidence(provider, {
      evidenceText:
        "A sufficiently detailed transcript of an approval workflow.",
      sourceFiles: [
        {
          filename: "transcript.txt",
          mimeType: "text/plain",
          kind: "document",
        },
      ],
    });

    expect(result.name).toBe("Workflow Guide");
  });

  it("redacts sensitive evidence before provider analysis", async () => {
    const provider = providerWith(
      JSON.stringify({
        name: "Secure Workflow Guide",
        role: "Follow the demonstrated secure workflow and preserve approval boundaries.",
        ui: "chat",
        evidenceSummary: "A secure demonstrated workflow.",
        confidence: "high",
      }),
    );
    const token = `ghp_${"A".repeat(24)}`;

    const result = await analyzeEstateBuddyEvidence(provider, {
      evidenceText: `Paste access token ${token} into the form, then request approval.`,
      sourceFiles: [
        {
          filename: "secure-transcript.txt",
          mimeType: "text/plain",
          kind: "document",
        },
      ],
    });

    const prompt = vi.mocked(provider.chat).mock.calls[0][0][0].content;
    expect(prompt).not.toContain(token);
    expect(prompt).toContain("[redacted]");
    expect(result.privacy.masked).toBe(true);
    expect(
      result.privacy.findings.some((finding) => finding.kind === "token"),
    ).toBe(true);
  });
});
