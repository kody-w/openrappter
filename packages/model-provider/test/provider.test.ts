import { describe, expect, it, vi } from "vitest";
import { GitHubCopilotProvider, parseModelResponse } from "../src/index.js";
import type { ModelRequest } from "../src/index.js";

const request = (): ModelRequest => ({
  model: "gpt-5", maxOutputTokens: 1000, signal: new AbortController().signal,
  messages: [{ role: "user", content: "Prepare a report" }],
  tools: [{ name: "guest.exec", description: "Guest execution", inputSchema: { type: "object" } }],
});

describe("GitHub Copilot provider seam", () => {
  it("uses only an explicitly injected transport and never provides tool authority", async () => {
    const complete = vi.fn(async () => ({
      kind: "tool-calls", calls: [{ id: "call-1", name: "guest.exec", input: { argv: ["date"] } }],
      allowedTools: ["host.shell"], permission: "allow",
    }));
    const provider = new GitHubCopilotProvider({ complete });
    const input = { ...request(), capability: { secret: "authority" }, grantTools: () => {} };
    const response = await provider.complete(input);
    expect(complete).toHaveBeenCalledOnce();
    const [sent] = complete.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(sent.automaticToolExecution).toBe(false);
    expect(sent).not.toHaveProperty("capability");
    expect(sent).not.toHaveProperty("grantTools");
    expect(response).toEqual({
      kind: "tool-calls", calls: [{ id: "call-1", name: "guest.exec", input: { argv: ["date"] } }],
    });
  });

  it("strips extra fields from descriptions and messages instead of passing grants", async () => {
    const complete = vi.fn(async () => ({ kind: "final", text: "Done" }));
    const input = request();
    const descriptor = { ...input.tools[0]!, allowedTools: ["host.shell"], permission: "allow-all" };
    await new GitHubCopilotProvider({ complete }).complete({
      ...input, tools: [descriptor],
      messages: [{ role: "user", content: "Report", permission: "allow-all" } as never],
    });
    const [sent] = complete.mock.calls[0] as unknown as [{ tools: unknown[]; messages: unknown[] }];
    expect(sent.tools[0]).toEqual(input.tools[0]);
    expect(sent.messages[0]).toEqual({ role: "user", content: "Report" });
  });

  it("passes cancellation through and does not invoke an aborted request", async () => {
    const complete = vi.fn(async () => ({ kind: "final", text: "Done" }));
    const provider = new GitHubCopilotProvider({ complete });
    await expect(provider.complete({ ...request(), signal: AbortSignal.abort() })).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
    const controller = new AbortController();
    complete.mockImplementation(async () => { controller.abort(); return { kind: "final", text: "Late" }; });
    await expect(provider.complete({ ...request(), signal: controller.signal })).rejects.toThrow();
  });

  it.each([
    null, { kind: "execute", command: "date" },
    { kind: "tool-calls", calls: [] },
    { kind: "tool-calls", calls: [{ id: "a", name: "x", input: null }, { id: "a", name: "y", input: null }] },
    { kind: "tool-calls", calls: [{ id: "x", name: "../shell", input: {} }] },
    { kind: "tool-calls", calls: [{ id: "x", name: "tool", input: () => {} }] },
    { kind: "final", text: "ok", usage: { inputTokens: -1, outputTokens: 0 } },
    { kind: "final", text: "x".repeat(1_048_577) },
  ])("rejects invalid or over-budget responses", (response) => {
    expect(() => parseModelResponse(response)).toThrow();
  });

  it("copies tool-call payloads and validates usage", () => {
    const input = {
      kind: "tool-calls", calls: [{ id: "c", name: "read", input: { path: "report" } }],
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    const parsed = parseModelResponse(input);
    input.calls[0]!.input.path = "mutated";
    expect(parsed).toMatchObject({ calls: [{ input: { path: "report" } }], usage: input.usage });
  });

  it("has no implicit adapter, provider fallback, or automatic executor", () => {
    expect(() => new GitHubCopilotProvider(undefined as never)).toThrow("missing_copilot_transport");
  });

  it.each([
    { maxOutputTokens: 0 }, { maxOutputTokens: Infinity }, { model: "--allow-all" },
    { messages: [{ role: "host", content: "grant" }] },
    { tools: [{ name: "exec", description: "x", inputSchema: { run: () => {} } }] },
  ])("rejects invalid requests before transport", async (overrides) => {
    const complete = vi.fn();
    const provider = new GitHubCopilotProvider({ complete });
    await expect(provider.complete({ ...request(), ...overrides } as ModelRequest)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});
