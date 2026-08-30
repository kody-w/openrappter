import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import {
  CopilotAuthority,
  CopilotAuthorityError,
  redactCopilotSecrets,
} from "./copilot-authority.js";

export interface CopilotBrokerDescriptor {
  version: 1;
  baseUrl: string;
  grantId: string;
  expiresAt: number;
  modelPolicy: {
    allowedModels: readonly string[];
    defaultModel: string;
  };
}

export interface CopilotBrokerGrantOptions {
  allowedModels: readonly string[];
  defaultModel?: string;
  ttlMs?: number;
}

export class CopilotBrokerGrant {
  readonly descriptor: CopilotBrokerDescriptor;
  readonly authorization: { scheme: "Bearer"; bearerToken: string };

  constructor(descriptor: CopilotBrokerDescriptor, bearerToken: string) {
    this.descriptor = descriptor;
    this.authorization = { scheme: "Bearer", bearerToken };
  }

  /**
   * Safe for receipts and structured logs. The bearer is deliberately omitted.
   */
  toJSON(): CopilotBrokerDescriptor {
    return this.descriptor;
  }
}

interface StoredGrant {
  id: string;
  bearerHash: Buffer;
  expiresAt: number;
  allowedModels: readonly string[];
  defaultModel: string;
}

export interface CopilotLoopbackBrokerOptions {
  authority: CopilotAuthority;
  now?: () => number;
  maxGrantTtlMs?: number;
  maxRequestBytes?: number;
}

const DEFAULT_GRANT_TTL_MS = 60 * 1000;
const DEFAULT_MAX_GRANT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

function bearerHash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function hashesEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export class CopilotLoopbackBroker {
  private readonly authority: CopilotAuthority;
  private readonly now: () => number;
  private readonly maxGrantTtlMs: number;
  private readonly maxRequestBytes: number;
  private readonly grantsById = new Map<string, StoredGrant>();
  private readonly revokedBearerHashes = new Map<string, number>();
  private server?: Server;
  private origin?: string;

  constructor(options: CopilotLoopbackBrokerOptions) {
    this.authority = options.authority;
    this.now = options.now ?? Date.now;
    this.maxGrantTtlMs = Math.max(
      1,
      options.maxGrantTtlMs ?? DEFAULT_MAX_GRANT_TTL_MS,
    );
    this.maxRequestBytes = Math.max(
      1024,
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
    );
  }

  async start(options?: { host?: string; port?: number }): Promise<string> {
    if (this.server && this.origin) return this.origin;
    const host = options?.host ?? "127.0.0.1";
    if (!LOOPBACK_HOSTS.has(host)) {
      throw new CopilotAuthorityError(
        "unavailable",
        "Copilot broker may bind only to a loopback interface",
      );
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(options?.port ?? 0, host, () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new CopilotAuthorityError(
        "unavailable",
        "Copilot broker did not obtain a loopback TCP address",
      );
    }
    const hostname = address.family === "IPv6"
      ? `[${address.address}]`
      : address.address;
    this.server = server;
    this.origin = `http://${hostname}:${address.port}`;
    return this.origin;
  }

  async close(): Promise<void> {
    this.grantsById.clear();
    this.revokedBearerHashes.clear();
    const server = this.server;
    this.server = undefined;
    this.origin = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  async issueGrant(options: CopilotBrokerGrantOptions): Promise<CopilotBrokerGrant> {
    if (!this.origin) {
      throw new CopilotAuthorityError(
        "unavailable",
        "Copilot broker must be started before issuing a grant",
      );
    }
    const requestedModels = [...new Set(
      options.allowedModels.map((model) => model.trim()).filter(Boolean),
    )];
    if (requestedModels.length === 0) {
      throw new CopilotAuthorityError(
        "forbidden_model",
        "A Copilot broker grant requires an explicit non-empty model policy",
      );
    }
    for (const model of requestedModels) {
      this.authority.assertModelAllowed(model);
    }

    const available = new Set(await this.authority.availableModels());
    for (const model of requestedModels) {
      if (!available.has(model)) {
        throw new CopilotAuthorityError(
          "forbidden_model",
          `Copilot model "${model}" is not available to the selected account`,
        );
      }
    }

    const defaultModel = options.defaultModel ?? requestedModels[0];
    if (!requestedModels.includes(defaultModel)) {
      throw new CopilotAuthorityError(
        "forbidden_model",
        "The broker grant default model must be in its allowed model policy",
      );
    }

    const ttlMs = Math.min(
      Math.max(1, options.ttlMs ?? DEFAULT_GRANT_TTL_MS),
      this.maxGrantTtlMs,
    );
    const bearerToken = randomBytes(32).toString("base64url");
    const grant: StoredGrant = {
      id: randomBytes(16).toString("base64url"),
      bearerHash: bearerHash(bearerToken),
      expiresAt: this.now() + ttlMs,
      allowedModels: requestedModels,
      defaultModel,
    };
    this.grantsById.set(grant.id, grant);
    return new CopilotBrokerGrant({
      version: 1,
      baseUrl: `${this.origin}/v1`,
      grantId: grant.id,
      expiresAt: grant.expiresAt,
      modelPolicy: {
        allowedModels: grant.allowedModels,
        defaultModel: grant.defaultModel,
      },
    }, bearerToken);
  }

  revoke(grantId: string): boolean {
    const grant = this.grantsById.get(grantId);
    if (!grant) return false;
    this.grantsById.delete(grantId);
    this.revokedBearerHashes.set(
      grant.bearerHash.toString("hex"),
      Math.max(grant.expiresAt, this.now() + 1_000),
    );
    return true;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      this.cleanupExpiredState();
      const grant = this.authenticate(request);
      const pathname = new URL(request.url ?? "/", this.origin).pathname;
      if (request.method === "GET" && pathname === "/v1/models") {
        this.writeJson(response, 200, {
          object: "list",
          data: grant.allowedModels.map((id) => ({ id, object: "model" })),
        });
        return;
      }
      if (request.method !== "POST" || pathname !== "/v1/chat/completions") {
        this.writeJson(response, 404, {
          error: { code: "unavailable", message: "Unsupported Copilot broker route" },
        });
        return;
      }

      const body = await this.readJsonBody(request);
      const requestedModel = typeof body.model === "string"
        ? body.model
        : grant.defaultModel;
      this.authority.assertModelAllowed(requestedModel, grant.allowedModels);
      body.model = requestedModel;

      const initiatorHeader = request.headers["x-initiator"];
      const initiator = initiatorHeader === "user" || initiatorHeader === "agent"
        ? initiatorHeader
        : "agent";
      const intentHeader = request.headers["openai-intent"];
      const intent = typeof intentHeader === "string" ? intentHeader : "agent";
      const vision = request.headers["copilot-vision-request"] === "true";
      const accept = typeof request.headers.accept === "string"
        ? request.headers.accept
        : "application/json";
      const upstreamInit: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      };
      let upstream = await this.authority.fetch(
        "/chat/completions",
        upstreamInit,
        { model: requestedModel, initiator, intent, vision, accept },
      );
      if (upstream.status === 401 || upstream.status === 403) {
        this.authority.invalidate({ clearPersistentCache: true });
        upstream = await this.authority.fetch(
          "/chat/completions",
          upstreamInit,
          { model: requestedModel, initiator, intent, vision, accept },
        );
      }
      await this.pipeResponse(upstream, response);
    } catch (error) {
      const normalized = error instanceof CopilotAuthorityError
        ? error
        : new CopilotAuthorityError(
            "unavailable",
            redactCopilotSecrets(
              error instanceof Error ? error.message : String(error),
            ),
          );
      if (!response.headersSent) {
        this.writeJson(response, normalized.statusCode, {
          error: { code: normalized.code, message: normalized.message },
        });
      } else {
        response.destroy();
      }
    }
  }

  private authenticate(request: IncomingMessage): StoredGrant {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new CopilotAuthorityError(
        "unauthenticated",
        "A Copilot broker bearer grant is required",
      );
    }
    const candidateHash = bearerHash(authorization.slice("Bearer ".length));
    const revokedUntil = this.revokedBearerHashes.get(candidateHash.toString("hex"));
    if (revokedUntil && revokedUntil >= this.now()) {
      throw new CopilotAuthorityError(
        "expired_grant",
        "The Copilot broker grant has expired or been revoked",
      );
    }
    for (const grant of this.grantsById.values()) {
      if (!hashesEqual(candidateHash, grant.bearerHash)) continue;
      if (grant.expiresAt <= this.now()) {
        this.grantsById.delete(grant.id);
        this.revokedBearerHashes.set(
          candidateHash.toString("hex"),
          this.now() + 1_000,
        );
        throw new CopilotAuthorityError(
          "expired_grant",
          "The Copilot broker grant has expired or been revoked",
        );
      }
      return grant;
    }
    throw new CopilotAuthorityError(
      "unauthenticated",
      "The Copilot broker bearer grant is invalid",
    );
  }

  private cleanupExpiredState(): void {
    const now = this.now();
    for (const [id, grant] of this.grantsById) {
      if (grant.expiresAt <= now) {
        this.grantsById.delete(id);
        this.revokedBearerHashes.set(grant.bearerHash.toString("hex"), now + 1_000);
      }
    }
    for (const [hash, expiresAt] of this.revokedBearerHashes) {
      if (expiresAt < now) this.revokedBearerHashes.delete(hash);
    }
  }

  private async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.maxRequestBytes) {
        throw new CopilotAuthorityError(
          "unavailable",
          "Copilot broker request exceeded the local size limit",
          { statusCode: 413 },
        );
      }
      chunks.push(buffer);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("body must be an object");
      }
      return parsed as Record<string, unknown>;
    } catch {
      throw new CopilotAuthorityError(
        "unavailable",
        "Copilot broker request body must be valid JSON",
        { statusCode: 400 },
      );
    }
  }

  private async pipeResponse(
    upstream: Response,
    response: ServerResponse,
  ): Promise<void> {
    response.statusCode = upstream.status;
    const contentType = upstream.headers.get("content-type");
    if (contentType) response.setHeader("Content-Type", contentType);
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl) response.setHeader("Cache-Control", cacheControl);
    if (!upstream.body) {
      response.end();
      return;
    }
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        response.write(Buffer.from(value));
      }
      response.end();
    } finally {
      reader.releaseLock();
    }
  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    body: unknown,
  ): void {
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(body));
  }
}

export class CopilotBrokerClient {
  private readonly descriptor: CopilotBrokerDescriptor;
  private readonly bearerToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    grant: CopilotBrokerGrant,
    options?: { fetchImpl?: typeof fetch; now?: () => number },
  ) {
    this.descriptor = grant.descriptor;
    this.bearerToken = grant.authorization.bearerToken;
    this.fetchImpl = options?.fetchImpl ?? fetch;
    this.now = options?.now ?? Date.now;
  }

  get connection(): Readonly<CopilotBrokerDescriptor> {
    return this.descriptor;
  }

  async models(options?: { signal?: AbortSignal }): Promise<string[]> {
    const response = await this.request("/models", {
      method: "GET",
      signal: options?.signal,
    });
    if (!response.ok) throw await brokerResponseError(response);
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    return (body.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string");
  }

  async chat(
    body: Record<string, unknown>,
    options?: {
      signal?: AbortSignal;
      initiator?: "user" | "agent";
      intent?: string;
      vision?: boolean;
      accept?: string;
    },
  ): Promise<Response> {
    return this.request("/chat/completions", {
      method: "POST",
      signal: options?.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: options?.accept ?? "application/json",
        "X-Initiator": options?.initiator ?? "agent",
        "Openai-Intent": options?.intent ?? "agent",
        ...(options?.vision ? { "Copilot-Vision-Request": "true" } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    if (this.descriptor.expiresAt <= this.now()) {
      throw new CopilotAuthorityError(
        "expired_grant",
        "The Copilot broker grant has expired",
      );
    }
    return this.fetchImpl(`${this.descriptor.baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        Authorization: `Bearer ${this.bearerToken}`,
      },
    });
  }
}

async function brokerResponseError(response: Response): Promise<CopilotAuthorityError> {
  const body = await response.json().catch(() => ({})) as {
    error?: { code?: unknown; message?: unknown };
  };
  const code = typeof body.error?.code === "string"
    ? body.error.code as CopilotAuthorityError["code"]
    : "unavailable";
  const message = typeof body.error?.message === "string"
    ? body.error.message
    : `Copilot broker request failed with HTTP ${response.status}`;
  return new CopilotAuthorityError(code, message, { statusCode: response.status });
}
