import { createHash } from "crypto";
import {
  clearCachedCopilotToken,
  deriveCopilotApiBaseUrl,
  normalizeCopilotApiBaseUrl,
  resolveCopilotApiToken,
  CopilotTokenExchangeError,
  type ResolvedCopilotToken,
} from "./copilot-token.js";
import {
  COPILOT_DEFAULT_MODEL,
  COPILOT_DEFAULT_MODELS,
} from "./copilot-models.js";
import type { Message } from "./types.js";

export type CopilotAuthorityErrorCode =
  | "unavailable"
  | "unauthenticated"
  | "no_entitlement"
  | "exchange_failure"
  | "expired_grant"
  | "forbidden_model";

export class CopilotAuthorityError extends Error {
  readonly code: CopilotAuthorityErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    code: CopilotAuthorityErrorCode,
    message: string,
    options?: { retryable?: boolean; statusCode?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CopilotAuthorityError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.statusCode = options?.statusCode ?? statusCodeForAuthorityError(code);
  }
}

function statusCodeForAuthorityError(code: CopilotAuthorityErrorCode): number {
  switch (code) {
    case "unauthenticated":
      return 401;
    case "no_entitlement":
    case "forbidden_model":
      return 403;
    case "expired_grant":
      return 410;
    case "unavailable":
      return 503;
    case "exchange_failure":
      return 502;
  }
}

export interface CopilotOAuthCredential {
  type: "oauth";
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface CopilotPersonalAccessTokenCredential {
  type: "personal-access-token";
  token: string;
}

export type CopilotCredential =
  | CopilotOAuthCredential
  | CopilotPersonalAccessTokenCredential;

export type CopilotAccountSource =
  | "explicit"
  | "auth-profile"
  | "credential-cache"
  | "environment"
  | "environment-file"
  | "github-cli";

export interface CopilotAccount {
  id: string;
  source: CopilotAccountSource;
  credential: CopilotCredential;
  login?: string;
  default?: boolean;
}

export interface CopilotModelPolicy {
  defaultModel: string;
  allowedModels?: readonly string[];
  deniedModels?: readonly string[];
}

export type CopilotProviderState =
  | "ready"
  | "unavailable"
  | "unauthenticated"
  | "no_entitlement"
  | "exchange_failure";

export interface CopilotProviderStatus {
  state: CopilotProviderState;
  checkedAt: number;
  accountId?: string;
  endpoint?: string;
  expiresAt?: number;
  errorCode?: CopilotAuthorityErrorCode;
  message?: string;
}

export interface CopilotModelCatalog {
  accountId: string;
  models: readonly string[];
  verified: boolean;
  source: "live" | "cache" | "fallback";
  expiresAt: number;
}

export interface CopilotSession {
  accountId: string;
  endpoint: string;
  expiresAt: number;
  source: string;
}

interface InternalCopilotSession extends CopilotSession {
  token: string;
  fingerprint: string;
}

export interface CopilotRequestContext {
  model?: string;
  initiator?: "user" | "agent";
  intent?: string;
  vision?: boolean;
  accept?: string;
}

export interface CopilotAuthorization {
  accountId: string;
  endpoint: string;
  expiresAt: number;
  headers: Record<string, string>;
}

export interface CopilotAuthorityOptions {
  githubToken?: string | null;
  allowAmbientCredentials?: boolean;
  accounts?: readonly CopilotAccount[];
  accountResolver?: () => Promise<readonly CopilotAccount[]>;
  selectedAccountId?: string;
  modelPolicy?: Partial<CopilotModelPolicy>;
  exchange?: (
    account: CopilotAccount,
    options: { signal?: AbortSignal },
  ) => Promise<ResolvedCopilotToken>;
  refreshCredential?: (
    account: CopilotAccount,
    options: { signal?: AbortSignal },
  ) => Promise<CopilotCredential>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  exchangeAttempts?: number;
  exchangeRetryDelayMs?: number;
  negativeCacheTtlMs?: number;
  modelCacheTtlMs?: number;
  modelStaleTtlMs?: number;
}

interface NegativeCacheEntry {
  error: CopilotAuthorityError;
  expiresAt: number;
}

interface ModelCacheEntry {
  models: string[];
  expiresAt: number;
  staleUntil: number;
  verified: boolean;
}

const TOKEN_SAFETY_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_NEGATIVE_CACHE_TTL_MS = 30 * 1000;
const DEFAULT_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MODEL_STALE_TTL_MS = 30 * 60 * 1000;
const MAX_INTENT_LENGTH = 64;
const TOKEN_PATTERN =
  /\b(?:gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._~+/-]+=*)\b/gi;

export function copilotCredentialToken(credential: CopilotCredential): string {
  return credential.type === "oauth"
    ? credential.accessToken
    : credential.token;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function inferredCredential(token: string): CopilotCredential {
  if (token.startsWith("ghu_") || token.startsWith("gho_")) {
    return { type: "oauth", accessToken: token };
  }
  return { type: "personal-access-token", token };
}

export function createCopilotAccount(params: {
  token: string;
  source: CopilotAccountSource;
  id?: string;
  login?: string;
  default?: boolean;
  refreshToken?: string;
  expiresAt?: number;
}): CopilotAccount {
  const fingerprint = tokenFingerprint(params.token);
  const credential = inferredCredential(params.token);
  if (credential.type === "oauth") {
    credential.refreshToken = params.refreshToken;
    credential.expiresAt = params.expiresAt;
  }
  return {
    id: params.id ?? `${params.source}:${fingerprint.slice(0, 16)}`,
    source: params.source,
    credential,
    login: params.login,
    default: params.default,
  };
}

export function inferCopilotRequestContext(
  messages: readonly Message[],
  options?: Pick<CopilotRequestContext, "initiator" | "intent" | "vision">,
): Required<Pick<CopilotRequestContext, "initiator" | "intent" | "vision">> {
  const initiatedByAgent = messages.some(
    (message) => message.role === "assistant" || message.role === "tool",
  );
  return {
    initiator: options?.initiator ?? (initiatedByAgent ? "agent" : "user"),
    intent: normalizeIntent(options?.intent),
    vision: options?.vision ?? false,
  };
}

function normalizeIntent(intent: string | undefined): string {
  const candidate = intent?.trim();
  if (
    candidate
    && candidate.length <= MAX_INTENT_LENGTH
    && /^[A-Za-z0-9._-]+$/.test(candidate)
  ) {
    return candidate;
  }
  return "conversation-panel";
}

export function redactCopilotSecrets(
  value: string,
  secrets: readonly string[] = [],
): string {
  let redacted = value.replace(TOKEN_PATTERN, "***REDACTED***");
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join("***REDACTED***");
  }
  return redacted;
}

function publicSession(session: InternalCopilotSession): CopilotSession {
  return {
    accountId: session.accountId,
    endpoint: session.endpoint,
    expiresAt: session.expiresAt,
    source: session.source,
  };
}

function deduplicateAccounts(accounts: readonly CopilotAccount[]): CopilotAccount[] {
  const seen = new Set<string>();
  return accounts.filter((account) => {
    const fingerprint = tokenFingerprint(copilotCredentialToken(account.credential));
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function normalizePolicy(
  policy: Partial<CopilotModelPolicy> | undefined,
): CopilotModelPolicy {
  return {
    defaultModel: policy?.defaultModel ?? COPILOT_DEFAULT_MODEL,
    allowedModels: policy?.allowedModels
      ? [...new Set(policy.allowedModels)]
      : undefined,
    deniedModels: policy?.deniedModels
      ? [...new Set(policy.deniedModels)]
      : undefined,
  };
}

export class CopilotAuthority {
  private explicitAccounts: CopilotAccount[];
  private explicitSelectionAuthoritative: boolean;
  private readonly allowAmbientCredentials: boolean;
  private readonly accountResolver?: () => Promise<readonly CopilotAccount[]>;
  private selectedAccountId?: string;
  private readonly exchange: NonNullable<CopilotAuthorityOptions["exchange"]>;
  private readonly refreshCredential?: CopilotAuthorityOptions["refreshCredential"];
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly exchangeAttempts: number;
  private readonly exchangeRetryDelayMs: number;
  private readonly negativeCacheTtlMs: number;
  private readonly modelCacheTtlMs: number;
  private readonly modelStaleTtlMs: number;
  private readonly sessions = new Map<string, InternalCopilotSession>();
  private readonly inFlight = new Map<string, Promise<InternalCopilotSession>>();
  private readonly negativeCache = new Map<string, NegativeCacheEntry>();
  private readonly modelCache = new Map<string, ModelCacheEntry>();
  private readonly refreshedCredentials = new Map<string, CopilotCredential>();
  private generation = 0;
  private policy: CopilotModelPolicy;
  private status: CopilotProviderStatus;

  constructor(options: CopilotAuthorityOptions = {}) {
    this.allowAmbientCredentials = options.allowAmbientCredentials ?? true;
    this.explicitAccounts = options.accounts ? [...options.accounts] : [];
    this.explicitSelectionAuthoritative =
      options.accounts !== undefined || options.githubToken !== undefined;
    if (options.githubToken) {
      this.explicitAccounts.unshift(createCopilotAccount({
        token: options.githubToken,
        source: "explicit",
      }));
    }
    this.accountResolver = options.accountResolver;
    this.refreshCredential = options.refreshCredential;
    this.selectedAccountId = options.selectedAccountId;
    this.policy = normalizePolicy(options.modelPolicy);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep
      ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.exchangeAttempts = Math.max(1, options.exchangeAttempts ?? 3);
    this.exchangeRetryDelayMs = Math.max(0, options.exchangeRetryDelayMs ?? 250);
    this.negativeCacheTtlMs = Math.max(
      0,
      options.negativeCacheTtlMs ?? DEFAULT_NEGATIVE_CACHE_TTL_MS,
    );
    this.modelCacheTtlMs = Math.max(
      0,
      options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS,
    );
    this.modelStaleTtlMs = Math.max(
      this.modelCacheTtlMs,
      options.modelStaleTtlMs ?? DEFAULT_MODEL_STALE_TTL_MS,
    );
    this.exchange = options.exchange ?? (async (account, exchangeOptions) => {
      return resolveCopilotApiToken({
        githubToken: copilotCredentialToken(account.credential),
        signal: exchangeOptions.signal,
      });
    });
    this.status = {
      state: "unavailable",
      checkedAt: this.now(),
      message: "Copilot authority has not resolved an account",
    };
  }

  get modelPolicy(): Readonly<CopilotModelPolicy> {
    return this.policy;
  }

  setModelPolicy(policy: Partial<CopilotModelPolicy>): void {
    this.policy = normalizePolicy({ ...this.policy, ...policy });
    this.modelCache.clear();
  }

  selectAccount(accountId: string | undefined): void {
    this.invalidate();
    this.selectedAccountId = accountId;
    this.status = {
      state: "unavailable",
      checkedAt: this.now(),
      message: accountId
        ? `Copilot account ${accountId} is selected but not yet resolved`
        : "Copilot account selection is automatic",
    };
  }

  setCredential(
    token: string | null,
    options?: {
      accountId?: string;
      source?: CopilotAccountSource;
      authoritative?: boolean;
    },
  ): void {
    this.invalidate({ clearPersistentCache: true });
    this.explicitAccounts = token
      ? [createCopilotAccount({
          token,
          source: options?.source ?? "explicit",
          id: options?.accountId,
          default: true,
        })]
      : [];
    this.explicitSelectionAuthoritative = token
      ? true
      : options?.authoritative ?? true;
    this.selectedAccountId = token ? this.explicitAccounts[0].id : undefined;
    if (!token) {
      this.status = {
        state: "unauthenticated",
        checkedAt: this.now(),
        errorCode: "unauthenticated",
        message: "No active Copilot account",
      };
    }
  }

  getStatus(): Readonly<CopilotProviderStatus> {
    return { ...this.status };
  }

  async listAccounts(): Promise<readonly CopilotAccount[]> {
    const accounts = [...this.explicitAccounts];
    if (!this.explicitSelectionAuthoritative && this.accountResolver) {
      accounts.push(...await this.accountResolver());
    } else if (!this.explicitSelectionAuthoritative && this.allowAmbientCredentials) {
      const candidates = [
        process.env.COPILOT_GITHUB_TOKEN,
        process.env.GH_TOKEN,
        process.env.GITHUB_TOKEN,
      ];
      for (const token of candidates) {
        if (token) {
          accounts.push(createCopilotAccount({
            token,
            source: "environment",
          }));
        }
      }
    }

    const unique = deduplicateAccounts(accounts);
    for (const account of unique) {
      const refreshed = this.refreshedCredentials.get(account.id);
      if (refreshed) account.credential = refreshed;
    }
    const defaultIndex = unique.findIndex((account) => account.default);
    if (defaultIndex > 0) {
      const [preferred] = unique.splice(defaultIndex, 1);
      unique.unshift(preferred);
    }
    if (!this.selectedAccountId) return unique;
    return unique.filter((account) => account.id === this.selectedAccountId);
  }

  async resolveCredential(options?: {
    signal?: AbortSignal;
    forceRefresh?: boolean;
  }): Promise<{ account: CopilotAccount; session: CopilotSession }> {
    const generation = this.generation;
    const accounts = await this.listAccounts();
    this.assertGeneration(generation);
    if (accounts.length === 0) {
      const error = new CopilotAuthorityError(
        "unauthenticated",
        "No GitHub credential is available for Copilot",
      );
      this.updateErrorStatus(error);
      throw error;
    }

    const errors: CopilotAuthorityError[] = [];
    for (const account of accounts) {
      try {
        const session = await this.resolveAccount(account, options);
        return { account, session: publicSession(session) };
      } catch (error) {
        if (isAbortError(error)) throw error;
        errors.push(this.normalizeExchangeError(error, account));
      }
    }

    const error = errors.every((candidate) => candidate.code === "no_entitlement")
      ? errors[0]
      : errors.at(-1) ?? new CopilotAuthorityError(
          "unavailable",
          "No Copilot account is available",
        );
    this.assertGeneration(generation);
    this.updateErrorStatus(error);
    throw error;
  }

  async resolveSession(options?: {
    signal?: AbortSignal;
    forceRefresh?: boolean;
  }): Promise<CopilotSession> {
    return (await this.resolveCredential(options)).session;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.resolveSession();
      return true;
    } catch {
      return false;
    }
  }

  invalidate(options?: { clearPersistentCache?: boolean }): void {
    this.generation++;
    this.sessions.clear();
    this.inFlight.clear();
    this.negativeCache.clear();
    this.modelCache.clear();
    this.refreshedCredentials.clear();
    if (options?.clearPersistentCache) clearCachedCopilotToken();
  }

  assertModelAllowed(model: string, grantModels?: readonly string[]): void {
    const requested = model.trim();
    const allowed = this.policy.allowedModels;
    const denied = this.policy.deniedModels;
    const forbidden =
      !requested
      || (allowed !== undefined && !allowed.includes(requested))
      || denied?.includes(requested)
      || (grantModels !== undefined && !grantModels.includes(requested));
    if (forbidden) {
      throw new CopilotAuthorityError(
        "forbidden_model",
        `Copilot model "${requested || "(empty)"}" is not allowed by policy`,
      );
    }
  }

  async authorizeRequest(
    context: CopilotRequestContext = {},
    options?: { signal?: AbortSignal },
  ): Promise<CopilotAuthorization> {
    if (context.model) this.assertModelAllowed(context.model);
    const internal = await this.resolveInternalSession(options);
    const headers: Record<string, string> = {
      Accept: context.accept ?? "application/json",
      Authorization: `Bearer ${internal.token}`,
      "Editor-Version": "vscode/1.95.0",
      "Editor-Plugin-Version": "copilot/1.0.0",
      "User-Agent": "GitHubCopilotChat/0.22.2024",
      "Copilot-Integration-Id": "vscode-chat",
      "X-Initiator": context.initiator ?? "user",
      "Openai-Intent": normalizeIntent(context.intent),
    };
    if (context.vision) headers["Copilot-Vision-Request"] = "true";
    return {
      accountId: internal.accountId,
      endpoint: internal.endpoint,
      expiresAt: internal.expiresAt,
      headers,
    };
  }

  async fetch(
    pathname: string,
    init: RequestInit = {},
    context: CopilotRequestContext = {},
  ): Promise<Response> {
    if (!pathname.startsWith("/") || pathname.startsWith("//")) {
      throw new CopilotAuthorityError(
        "unavailable",
        "Copilot request path must be relative to the account endpoint",
      );
    }
    const authorization = await this.authorizeRequest(context, {
      signal: init.signal ?? undefined,
    });
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(authorization.headers)) {
      headers.set(key, value);
    }
    return this.fetchImpl(`${authorization.endpoint}${pathname}`, {
      ...init,
      headers,
    });
  }

  async availableModels(options?: {
    refresh?: boolean;
    signal?: AbortSignal;
  }): Promise<string[]> {
    const catalog = await this.getModelCatalog(options);
    return [...catalog.models];
  }

  async getModelCatalog(options?: {
    refresh?: boolean;
    requireVerified?: boolean;
    signal?: AbortSignal;
  }): Promise<CopilotModelCatalog> {
    const session = await this.resolveSession({ signal: options?.signal });
    const cached = this.modelCache.get(session.accountId);
    if (!options?.refresh && cached && cached.expiresAt > this.now()) {
      return {
        accountId: session.accountId,
        models: [...cached.models],
        verified: cached.verified,
        source: "cache",
        expiresAt: cached.expiresAt,
      };
    }

    const discoveredModels = new Set<string>();
    try {
      const response = await this.fetch(
        "/v1/models",
        { signal: options?.signal },
        { intent: "model-discovery" },
      );
      if (response.ok) {
        const body = await response.json() as {
          data?: Array<{ id?: unknown }>;
        };
        for (const item of body.data ?? []) {
          if (typeof item.id === "string" && item.id.trim()) {
            discoveredModels.add(item.id.trim());
          }
        }
      } else {
        throw new CopilotAuthorityError(
          "unavailable",
          `Copilot model discovery failed with HTTP ${response.status}`,
          { statusCode: 503, retryable: true },
        );
      }
      const filtered = this.filterModels(discoveredModels);
      const entry: ModelCacheEntry = {
        models: filtered,
        expiresAt: this.now() + this.modelCacheTtlMs,
        staleUntil: this.now() + this.modelStaleTtlMs,
        verified: true,
      };
      this.modelCache.set(session.accountId, entry);
      return {
        accountId: session.accountId,
        models: [...entry.models],
        verified: true,
        source: "live",
        expiresAt: entry.expiresAt,
      };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (cached?.verified && cached.staleUntil > this.now()) {
        return {
          accountId: session.accountId,
          models: [...cached.models],
          verified: true,
          source: "cache",
          expiresAt: cached.staleUntil,
        };
      }
      if (options?.requireVerified) {
        throw new CopilotAuthorityError(
          "unavailable",
          "Copilot model availability could not be verified for the selected account",
          { retryable: true },
        );
      }
      const filtered = this.filterModels(COPILOT_DEFAULT_MODELS);
      return {
        accountId: session.accountId,
        models: filtered,
        verified: false,
        source: "fallback",
        expiresAt: this.now(),
      };
    }
  }

  private async resolveInternalSession(options?: {
    signal?: AbortSignal;
    forceRefresh?: boolean;
  }): Promise<InternalCopilotSession> {
    const generation = this.generation;
    const accounts = await this.listAccounts();
    this.assertGeneration(generation);
    if (accounts.length === 0) {
      const error = new CopilotAuthorityError(
        "unauthenticated",
        "No GitHub credential is available for Copilot",
      );
      this.updateErrorStatus(error);
      throw error;
    }

    const errors: CopilotAuthorityError[] = [];
    for (const account of accounts) {
      try {
        return await this.resolveAccount(account, options);
      } catch (error) {
        if (isAbortError(error)) throw error;
        errors.push(this.normalizeExchangeError(error, account));
      }
    }
    const error = errors.every((candidate) => candidate.code === "no_entitlement")
      ? errors[0]
      : errors.at(-1) ?? new CopilotAuthorityError(
          "unavailable",
          "No Copilot account is available",
        );
    this.assertGeneration(generation);
    this.updateErrorStatus(error);
    throw error;
  }

  private async resolveAccount(
    account: CopilotAccount,
    options?: { signal?: AbortSignal; forceRefresh?: boolean },
  ): Promise<InternalCopilotSession> {
    const generation = this.generation;
    await this.refreshAccountCredential(account, options?.signal, generation);
    this.assertGeneration(generation);
    const secret = copilotCredentialToken(account.credential);
    const fingerprint = tokenFingerprint(secret);
    const cached = this.sessions.get(fingerprint);
    if (
      !options?.forceRefresh
      && cached
      && cached.expiresAt - this.now() > TOKEN_SAFETY_MARGIN_MS
    ) {
      this.updateReadyStatus(cached);
      return cached;
    }

    const negative = this.negativeCache.get(fingerprint);
    if (!options?.forceRefresh && negative && negative.expiresAt > this.now()) {
      throw negative.error;
    }
    if (negative) this.negativeCache.delete(fingerprint);

    const existing = this.inFlight.get(fingerprint);
    if (existing) return existing;

    const pending = this.exchangeWithRetries(account, options?.signal)
      .then((resolved) => {
        this.assertGeneration(generation);
        const session: InternalCopilotSession = {
          accountId: account.id,
          endpoint: normalizeCopilotApiBaseUrl(
            resolved.baseUrl ?? deriveCopilotApiBaseUrl(resolved.token),
          ),
          expiresAt: resolved.expiresAt,
          source: resolved.source,
          token: resolved.token,
          fingerprint,
        };
        this.sessions.set(fingerprint, session);
        this.negativeCache.delete(fingerprint);
        this.updateReadyStatus(session);
        return session;
      })
      .catch((error: unknown) => {
        const normalized = this.normalizeExchangeError(error, account);
        if (
          generation === this.generation
          && !isAbortError(error)
          && this.negativeCacheTtlMs > 0
        ) {
          this.negativeCache.set(fingerprint, {
            error: normalized,
            expiresAt: this.now() + this.negativeCacheTtlMs,
          });
        }
        throw normalized;
      })
      .finally(() => {
        if (this.inFlight.get(fingerprint) === pending) {
          this.inFlight.delete(fingerprint);
        }
      });
    this.inFlight.set(fingerprint, pending);
    return pending;
  }

  private async refreshAccountCredential(
    account: CopilotAccount,
    signal?: AbortSignal,
    generation = this.generation,
  ): Promise<void> {
    const credential = account.credential;
    if (
      credential.type !== "oauth"
      || credential.expiresAt === undefined
      || credential.expiresAt > this.now()
    ) {
      return;
    }
    if (!credential.refreshToken || !this.refreshCredential) {
      throw new CopilotAuthorityError(
        "unauthenticated",
        `The GitHub OAuth credential for account ${account.id} has expired`,
      );
    }
    try {
      const refreshed = await this.refreshCredential(account, { signal });
      this.assertGeneration(generation);
      account.credential = refreshed;
      this.refreshedCredentials.set(account.id, refreshed);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new CopilotAuthorityError(
        "exchange_failure",
        `GitHub OAuth credential refresh failed for account ${account.id}`,
        { retryable: true },
      );
    }
  }

  private filterModels(models: Iterable<string>): string[] {
    return [...models].filter((model) => {
      try {
        this.assertModelAllowed(model);
        return true;
      } catch {
        return false;
      }
    });
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new CopilotAuthorityError(
        "unavailable",
        "Copilot account resolution was superseded by a newer account state",
        { retryable: true },
      );
    }
  }

  private async exchangeWithRetries(
    account: CopilotAccount,
    signal?: AbortSignal,
  ): Promise<ResolvedCopilotToken> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.exchangeAttempts; attempt++) {
      if (signal?.aborted) {
        throw new DOMException("Copilot token exchange cancelled", "AbortError");
      }
      try {
        return await this.exchange(account, { signal });
      } catch (error) {
        if (isAbortError(error)) throw error;
        const normalized = this.normalizeExchangeError(error, account);
        lastError = normalized;
        if (!normalized.retryable || attempt === this.exchangeAttempts) break;
        await this.sleep(this.exchangeRetryDelayMs * attempt);
      }
    }
    throw lastError;
  }

  private normalizeExchangeError(
    error: unknown,
    account: CopilotAccount,
  ): CopilotAuthorityError {
    if (error instanceof CopilotAuthorityError) return error;
    const secret = copilotCredentialToken(account.credential);
    if (
      typeof CopilotTokenExchangeError === "function"
      && error instanceof CopilotTokenExchangeError
    ) {
      return new CopilotAuthorityError(
        error.code === "no_entitlement" ? "no_entitlement" : "exchange_failure",
        redactCopilotSecrets(error.message, [secret]),
        {
          retryable: error.retryable,
          statusCode: error.statusCode,
        },
      );
    }
    const message = redactCopilotSecrets(
      error instanceof Error ? error.message : String(error),
      [secret],
    );
    return new CopilotAuthorityError(
      "exchange_failure",
      `Copilot token exchange failed for account ${account.id}: ${message}`,
      { retryable: true },
    );
  }

  private updateReadyStatus(session: InternalCopilotSession): void {
    this.status = {
      state: "ready",
      checkedAt: this.now(),
      accountId: session.accountId,
      endpoint: session.endpoint,
      expiresAt: session.expiresAt,
    };
  }

  private updateErrorStatus(error: CopilotAuthorityError): void {
    this.status = {
      state: error.code === "no_entitlement"
        ? "no_entitlement"
        : error.code === "unauthenticated"
          ? "unauthenticated"
          : error.code === "exchange_failure"
            ? "exchange_failure"
            : "unavailable",
      checkedAt: this.now(),
      errorCode: error.code,
      message: error.message,
    };
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
