import { describe, expect, it, vi } from "vitest";
import { GitHubCopilotProvider, type StructuredDraftRequest } from "../src/index.js";

const request = (): StructuredDraftRequest<{ reply: string }> => ({
  model: "gpt-6-astra", reasoningEffort: "max", contextTier: "long_context",
  name: "test_draft", messages: [{ role: "user", content: "Draft the report." }],
  maxOutputTokens: 1024, signal: new AbortController().signal,
  schema: { type: "object", properties: { reply: { type: "string" } }, required: ["reply"], additionalProperties: false },
  parse(value) {
    if (!value || typeof value !== "object" || Object.keys(value).length !== 1 || !("reply" in value)
      || typeof value.reply !== "string") throw new Error("Invalid strict object.");
    return { reply: value.reply };
  },
});
describe("bounded strict drafting seam", () => {
  it("passes only a schema, messages and the selected Astra profile into a tool-free transport", async () => {
    const complete = vi.fn(async () => ({ reply: "A complete draft" }));
    const provider = new GitHubCopilotProvider({ complete });
    const input = { ...request(), tools: [{ name: "host.shell" }], capability: {}, execute: vi.fn() };
    expect(await provider.draft(input)).toEqual({ reply: "A complete draft" });
    const [sent] = complete.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(sent).toMatchObject({
      model: "gpt-6-astra", reasoningEffort: "max", contextTier: "long_context",
      tools: [], automaticToolExecution: false, structuredOutput: { name: "test_draft", strict: true },
    });
    expect(Object.keys(sent).sort()).toEqual([
      "automaticToolExecution", "contextTier", "maxOutputTokens", "messages", "model", "reasoningEffort", "structuredOutput", "tools",
    ]);
    expect(input.execute).not.toHaveBeenCalled();
  });
  it.each([null, [], "not JSON", { reply: "valid", execute: true }, { reply: 42 },
    { kind: "tool-calls", calls: [{ name: "guest.execute" }] }, { reply: "x".repeat(8193) }])(
    "rejects nonconforming or oversized model output with no fallback", async (output) => {
      const complete = vi.fn(async () => output);
      await expect(new GitHubCopilotProvider({ complete }).draft(request()))
        .rejects.toMatchObject({ code: "invalid_structured_output" });
      expect(complete).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { model: "gpt-5" }, { reasoningEffort: "high" }, { contextTier: "default" }, { maxOutputTokens: 0 },
    { maxOutputTokens: 16_385 }, { messages: [] }, { messages: [{ role: "tool", content: "Run" }] },
    { messages: Array.from({ length: 51 }, () => ({ role: "user", content: "Work" })) },
    { messages: [{ role: "user", content: "x".repeat(262_145) }] },
    { schema: { description: "x".repeat(65_537) } },
  ])("rejects unsupported profiles and over-budget inputs before prompting", async (overrides) => {
    const complete = vi.fn();
    await expect(new GitHubCopilotProvider({ complete }).draft({ ...request(), ...overrides } as never))
      .rejects.toMatchObject({ code: "invalid_draft_request" });
    expect(complete).not.toHaveBeenCalled();
  });
  it("does not prompt cancelled requests and discards late responses", async () => {
    const complete = vi.fn(async () => ({ reply: "Late" }));
    const provider = new GitHubCopilotProvider({ complete });
    await expect(provider.draft({ ...request(), signal: AbortSignal.abort() })).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
    const controller = new AbortController();
    complete.mockImplementation(async () => { controller.abort(); return { reply: "Late" }; });
    await expect(provider.draft({ ...request(), signal: controller.signal })).rejects.toThrow();
  });
});
