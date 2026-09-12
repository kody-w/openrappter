import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CopilotClient, CopilotClientOptions, SessionConfig } from "@github/copilot-sdk";
import { CopilotSdkTransport, GitHubCopilotProvider } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const directory = join(process.cwd(), ".test-scratch", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const sessions: { config: SessionConfig; send: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> }[] = [];
  let response = '{"kind":"final","text":"Real transport result"}';
  let tools: unknown[] | null = [];
  const client = {
    start: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ version: "1.0.83", protocolVersion: 3 })),
    getAuthStatus: vi.fn(async () => ({ isAuthenticated: true })),
    listModels: vi.fn(async () => [{ id: "test-model", policy: { state: "enabled" } }]),
    createSession: vi.fn(async (config: SessionConfig) => {
      const send = vi.fn(async () => ({ data: { content: response } }));
      const abort = vi.fn(async () => {});
      sessions.push({ config, send, abort });
      return {
        on: vi.fn(() => () => {}), sendAndWait: send, abort, disconnect: vi.fn(async () => {}),
        rpc: { tools: {
          initializeAndValidate: vi.fn(async () => ({})),
          getCurrentMetadata: vi.fn(async () => ({ tools })),
        } },
      };
    }),
    deleteSession: vi.fn(async () => {}),
    stop: vi.fn(async () => []), forceStop: vi.fn(async () => {}),
  };
  const createClient = vi.fn((_options: CopilotClientOptions) => client as unknown as CopilotClient);
  const transport = new CopilotSdkTransport({ directory, home: directory, createClient });
  cleanups.push(async () => { await transport.close(); await rm(directory, { recursive: true, force: true }); });
  const provider = new GitHubCopilotProvider(transport);
  const request = (content = "Agent A's own task") => ({
    model: "test-model", messages: [{ role: "user" as const, content }], tools: [],
    maxOutputTokens: 512, signal: new AbortController().signal,
  });
  return { directory, transport, provider, client, createClient, sessions, request,
    response(value: string) { response = value; }, tools(value: unknown[] | null) { tools = value; } };
}

describe("documented local Copilot SDK transport", () => {
  it("uses a fixed stdio runtime, explicit auth and a fresh tool-free empty-mode session per completion", async () => {
    const f = await fixture();
    expect(await f.transport.status()).toMatchObject({ availability: "ready", authentication: "authenticated", models: ["test-model"] });
    expect(await f.provider.complete(f.request())).toEqual({ kind: "final", text: "Real transport result" });
    await f.provider.complete(f.request("Agent B's different task"));
    const options = f.createClient.mock.calls[0]![0];
    expect(options).toMatchObject({
      mode: "empty", connection: { kind: "stdio", path: "/opt/homebrew/bin/copilot" },
      baseDirectory: f.directory, enableRemoteSessions: false,
    });
    expect(Object.keys(options.env!)).toEqual(["HOME", "PATH", "COPILOT_HOME", "COPILOT_AUTO_UPDATE", "USE_TGREP", "TMPDIR"]);
    expect(f.sessions[0]!.config).toMatchObject({
      availableTools: [], excludedTools: ["builtin:*", "mcp:*", "custom:*"], tools: [], mcpServers: {},
      enableConfigDiscovery: false, enableFileHooks: false, enableSkills: false,
      enableHostGitOperations: false, enableSessionStore: false, memory: { enabled: false },
      skipEmbeddingRetrieval: true, remoteSession: "off",
    });
    expect(f.sessions[0]!.config.sessionId).not.toBe(f.sessions[1]!.config.sessionId);
    expect(f.sessions[0]!.config.workingDirectory).not.toBe(f.sessions[1]!.config.workingDirectory);
    const firstPrompt = JSON.stringify(f.sessions[0]!.send.mock.calls);
    expect(firstPrompt).toContain("Agent A"); expect(firstPrompt).not.toContain("Agent B");
    expect(await f.sessions[0]!.config.onPermissionRequest!({} as never, {} as never)).toMatchObject({ kind: "reject" });
    expect(await f.sessions[0]!.config.hooks!.onPreToolUse!({} as never, {} as never)).toMatchObject({ permissionDecision: "deny" });
    expect(f.client.deleteSession).toHaveBeenCalledTimes(2);
  });
  it("reports authentication required without issuing a prompt", async () => {
    const f = await fixture();
    f.client.getAuthStatus.mockResolvedValue({ isAuthenticated: false });
    expect(await f.transport.status()).toMatchObject({ availability: "ready", authentication: "required", models: [] });
    await expect(f.provider.complete(f.request())).rejects.toMatchObject({ code: "copilot_unavailable" });
    expect(f.client.createSession).not.toHaveBeenCalled();
  });
  it.each([null, [{ name: "unexpected-tool" }]])("fails closed unless the runtime confirms an empty offered tool set", async (tools) => {
    const f = await fixture(); f.tools(tools);
    await expect(f.provider.complete(f.request())).rejects.toMatchObject({ code: "provider_tool_isolation_unverified" });
    expect(f.sessions[0]!.send).not.toHaveBeenCalled();
    expect((await f.transport.status()).availability).toBe("unavailable");
  });
  it("rejects malformed model output rather than manufacturing a result", async () => {
    const f = await fixture(); f.response("not a model response");
    await expect(f.provider.complete(f.request())).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.client.deleteSession).toHaveBeenCalledOnce();
  });
  it("rejects older incompatible runtimes and propagates pre-cancellation without a prompt", async () => {
    const f = await fixture();
    await expect(f.provider.complete({ ...f.request(), signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.client.start).not.toHaveBeenCalled();
    f.client.getStatus.mockResolvedValue({ version: "1.0.20", protocolVersion: 3 });
    expect(await f.transport.status()).toMatchObject({ availability: "unavailable", authentication: "unverified" });
    expect(f.client.forceStop).toHaveBeenCalledOnce();
  });
});
