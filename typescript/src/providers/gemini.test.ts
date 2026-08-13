import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProvider } from "./gemini.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("GeminiProvider", () => {
  it("reports the successful response modelVersion instead of the request alias", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        modelVersion: "gemini-2.0-flash-001",
        candidates: [{ content: { parts: [{ text: "answer" }] } }],
        usageMetadata: {
          promptTokenCount: 2,
          candidatesTokenCount: 1,
        },
      }),
    }) as unknown as typeof fetch;
    const provider = new GeminiProvider("test-key");

    const response = await provider.chat(
      [{ role: "user", content: "hello" }],
      { model: "gemini-2.0-flash" },
    );

    expect(response.content).toBe("answer");
    expect(response.model).toBe("gemini-2.0-flash-001");
  });
});
