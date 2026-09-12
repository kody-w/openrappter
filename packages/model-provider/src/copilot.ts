import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  CopilotClient, RuntimeConnection, type CopilotClientOptions, type SessionConfig,
} from "@github/copilot-sdk";
import { ModelProviderError, parseModelResponse, type CopilotTransport } from "./index.js";

export interface ProviderAvailability {
  readonly availability: "ready" | "unavailable";
  readonly authentication: "authenticated" | "required" | "unverified";
  readonly models: readonly string[];
  readonly detail: string;
}
export interface ManagedCopilotTransport extends CopilotTransport {
  status(): Promise<ProviderAvailability>;
  close(): Promise<void>;
}
type Client = Pick<CopilotClient, "start" | "getStatus" | "getAuthStatus" | "listModels"
  | "createSession" | "deleteSession" | "stop" | "forceStop">;

export interface CopilotSdkOptions {
  readonly directory: string;
  readonly binary?: "/opt/homebrew/bin/copilot" | "/usr/local/bin/copilot";
  readonly home: string;
  readonly createClient?: (options: CopilotClientOptions) => Client;
}
const unavailable = (): ProviderAvailability => ({
  availability: "unavailable", authentication: "unverified", models: [],
  detail: "The supported local Copilot runtime could not be verified. Install or update GitHub Copilot CLI.",
});

/** The SDK is a model-only transport: each completion gets a fresh empty-mode session. */
export class CopilotSdkTransport implements ManagedCopilotTransport {
  private client: Client | undefined;
  private starting: Promise<Client> | undefined;
  private checking: Promise<ProviderAvailability> | undefined;
  private closed = false;
  private isolationFailed = false;
  private readonly binary: string;
  private readonly directory: string;

  constructor(private readonly options: CopilotSdkOptions) {
    this.directory = resolve(options.directory);
    if (!isAbsolute(options.directory) || options.directory !== this.directory || !isAbsolute(options.home)) {
      throw new ModelProviderError("invalid_copilot_directory");
    }
    this.binary = options.binary ?? "/opt/homebrew/bin/copilot";
    if (!["/opt/homebrew/bin/copilot", "/usr/local/bin/copilot"].includes(this.binary)) {
      throw new ModelProviderError("invalid_copilot_binary");
    }
  }

  private async start(): Promise<Client> {
    if (this.closed) throw new ModelProviderError("provider_closed");
    if (this.client) return this.client;
    this.starting ??= (async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || await realpath(this.directory) !== this.directory) throw new ModelProviderError("unsafe_copilot_directory");
      if (!this.options.createClient) await access(this.binary, constants.X_OK);
      const client = (this.options.createClient ?? ((options) => new CopilotClient(options)))({
        mode: "empty",
        connection: RuntimeConnection.forStdio({ path: this.binary }),
        baseDirectory: this.directory, workingDirectory: this.directory,
        logLevel: "none", useLoggedInUser: true, enableRemoteSessions: false,
        env: {
          HOME: this.options.home, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
          COPILOT_HOME: this.directory, COPILOT_AUTO_UPDATE: "false", USE_TGREP: "false", TMPDIR: this.directory,
        },
      });
      try {
        await this.deadline(client.start(), 10_000);
        const version = await this.deadline(client.getStatus(), 3000);
        // Empty-mode security options require the current documented SDK protocol.
        const release = /^1\.(\d+)\.(\d+)(?:[-+.]|$)/.exec(version.version);
        if (version.protocolVersion < 3 || !release || (Number(release[1]) === 0 && Number(release[2]) < 83)) {
          throw new ModelProviderError("unsupported_copilot_runtime");
        }
        if (this.closed) throw new ModelProviderError("provider_closed");
        this.client = client;
        return client;
      } catch (error) { await client.forceStop(); throw error; }
    })();
    try { return await this.starting; }
    finally { this.starting = undefined; }
  }
  private async deadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ModelProviderError("copilot_timeout")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async status(): Promise<ProviderAvailability> {
    if (this.closed || this.isolationFailed) return unavailable();
    this.checking ??= (async () => {
      try {
        const client = await this.start();
        const auth = await this.deadline(client.getAuthStatus(), 3000);
        if (auth.isAuthenticated !== true) return {
          availability: "ready" as const, authentication: "required" as const, models: [],
          detail: "Sign in using Copilot CLI with COPILOT_HOME set to RAPP Work's providers/github-copilot directory.",
        };
        const models = (await this.deadline(client.listModels(), 5000))
          .filter((model) => model.policy?.state !== "disabled")
          .map((model) => model.id).filter((id) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(id));
        return {
          availability: "ready" as const, authentication: "authenticated" as const, models,
          detail: "GitHub Copilot authenticated. Model proposals only; all tool execution is disabled in the provider.",
        };
      } catch { return unavailable(); }
    })();
    try { return await this.checking; }
    finally { this.checking = undefined; }
  }

  async complete(request: Parameters<CopilotTransport["complete"]>[0], signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (request.automaticToolExecution !== false) throw new ModelProviderError("automatic_tools_forbidden");
    const status = await this.status();
    signal.throwIfAborted();
    if (status.availability !== "ready" || status.authentication !== "authenticated"
      || !status.models.includes(request.model)) throw new ModelProviderError("copilot_unavailable");
    const client = await this.start();
    const sessionId = randomUUID();
    const workingDirectory = join(this.directory, `request-${sessionId}`);
    await mkdir(workingDirectory, { mode: 0o700 });
    const config: SessionConfig = {
      sessionId, model: request.model, workingDirectory,
      availableTools: [], excludedTools: ["builtin:*", "mcp:*", "custom:*"], tools: [],
      mcpServers: {}, customAgents: [], skillDirectories: [], pluginDirectories: [], instructionDirectories: [],
      enableConfigDiscovery: false, skipCustomInstructions: true, enableSkills: false,
      enableFileHooks: false, enableHostGitOperations: false, enableSessionStore: false,
      enableOnDemandInstructionDiscovery: false, enableFileChangeTracking: false,
      skipEmbeddingRetrieval: true, embeddingCacheStorage: "in-memory",
      memory: { enabled: false }, infiniteSessions: { enabled: false }, remoteSession: "off",
      onPermissionRequest: () => ({ kind: "reject", feedback: "The model provider cannot execute tools." }),
      hooks: { onPreToolUse: () => ({ permissionDecision: "deny" }) },
      systemMessage: {
        mode: "replace",
        content: [
          "You are the model-only provider for RAPP Work. Follow the supplied conversation.",
          "Return exactly one JSON object, without markdown fences.",
          'For a final answer use {"kind":"final","text":"..."}; to propose tools use',
          '{"kind":"tool-calls","calls":[{"id":"unique-id","name":"allowed-name","input":{}}]}.',
          "The supplied tools are descriptions only. Never execute a tool or claim unreported tool results.",
          `Keep the response within ${request.maxOutputTokens} output tokens.`,
        ].join("\n"),
      },
    };
    let session: Awaited<ReturnType<Client["createSession"]>> | undefined;
    let cancellation: Promise<void> | undefined;
    const abort = () => { if (session) cancellation ??= session.abort(); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      session = await client.createSession(config);
      if (signal.aborted) { abort(); await cancellation; throw new ModelProviderError("cancelled"); }
      try {
        await session.rpc.tools.initializeAndValidate();
        const metadata = await session.rpc.tools.getCurrentMetadata();
        if (!Array.isArray(metadata.tools) || metadata.tools.length !== 0) throw new Error("Tools remain available.");
      } catch {
        this.isolationFailed = true;
        throw new ModelProviderError("provider_tool_isolation_unverified");
      }
      let usedTokens = 0;
      let toolAttempt = false;
      session.on("assistant.usage", (event) => { usedTokens += event.data.outputTokens ?? 0; });
      session.on("tool.execution_start", () => { toolAttempt = true; abort(); });
      const response = await session.sendAndWait({
        prompt: JSON.stringify({ messages: request.messages, tools: request.tools, maxOutputTokens: request.maxOutputTokens }),
      }, 180_000);
      if (signal.aborted) { await cancellation; throw new ModelProviderError("cancelled"); }
      if (toolAttempt) throw new ModelProviderError("provider_tool_attempt");
      const text = response?.data.content;
      if (typeof text !== "string" || Buffer.byteLength(text) > Math.min(1_048_576, request.maxOutputTokens * 8)
        || usedTokens > request.maxOutputTokens) throw new ModelProviderError("invalid_response");
      try { return parseModelResponse(JSON.parse(text)); }
      catch { throw new ModelProviderError("invalid_response"); }
    } catch (error) {
      if (signal.aborted && session) {
        abort(); await cancellation;
        throw new ModelProviderError("cancelled");
      }
      throw error instanceof ModelProviderError ? error : new ModelProviderError("copilot_request_failed");
    } finally {
      signal.removeEventListener("abort", abort);
      try {
        if (session) {
          try { await session.disconnect(); }
          finally { await client.deleteSession(sessionId); }
        }
      } finally { await rm(workingDirectory, { recursive: true, force: true }); }
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.client) {
      try { await this.deadline(this.client.stop(), 3000); }
      catch { await this.client.forceStop(); }
    }
    this.client = undefined;
  }
}
