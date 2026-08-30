import { describe, expect, it, vi } from "vitest";
import {
  CopilotAuthority,
  createCopilotAccount,
  inferCopilotRequestContext,
  redactCopilotSecrets,
} from "../copilot-authority.js";
import {
  authHeaderForGithubToken,
  CopilotTokenExchangeError,
  normalizeCopilotApiBaseUrl,
} from "../copilot-token.js";

function account(id: string, token: string, isDefault = false) {
  return createCopilotAccount({
    id,
    token,
    source: "auth-profile",
    default: isDefault,
  });
}

function session(token = "copilot-api-token", baseUrl = "https://api.example.com") {
  return {
    token,
    baseUrl,
    expiresAt: Date.now() + 60 * 60 * 1000,
    source: "test",
  };
}

describe("CopilotAuthority", () => {
  it("selects the first entitled account in credential precedence order", async () => {
    const attempts: string[] = [];
    const authority = new CopilotAuthority({
      accounts: [
        account("preferred", "ghu_preferred", true),
        account("fallback", "gho_fallback"),
      ],
      exchangeAttempts: 1,
      exchange: async (candidate) => {
        attempts.push(candidate.id);
        if (candidate.id === "preferred") {
          throw new CopilotTokenExchangeError(
            "no_entitlement",
            "No Copilot entitlement",
            { statusCode: 403 },
          );
        }
        return session();
      },
    });

    const resolved = await authority.resolveCredential();

    expect(attempts).toEqual(["preferred", "fallback"]);
    expect(resolved.account.id).toBe("fallback");
    expect(authority.getStatus()).toMatchObject({
      state: "ready",
      accountId: "fallback",
      endpoint: "https://api.example.com",
    });
  });

  it("honors explicit account selection without trying another account", async () => {
    const exchange = vi.fn(async (_candidate: { id: string }) => session());
    const authority = new CopilotAuthority({
      accounts: [
        account("first", "ghu_first", true),
        account("chosen", "ghu_chosen"),
      ],
      selectedAccountId: "chosen",
      exchange,
    });

    await authority.resolveSession();

    expect(exchange).toHaveBeenCalledOnce();
    expect(exchange.mock.calls[0]?.[0].id).toBe("chosen");
  });

  it("caches successful exchanges by account", async () => {
    const exchange = vi.fn(async () => session());
    const authority = new CopilotAuthority({
      accounts: [account("one", "ghu_one")],
      exchange,
    });

    await authority.resolveSession();
    await authority.resolveSession();

    expect(exchange).toHaveBeenCalledOnce();
  });

  it("negative-caches failed account exchanges", async () => {
    const exchange = vi.fn(async () => {
      throw new CopilotTokenExchangeError(
        "no_entitlement",
        "No Copilot entitlement",
        { statusCode: 403 },
      );
    });
    const authority = new CopilotAuthority({
      accounts: [account("one", "ghu_one")],
      exchange,
      exchangeAttempts: 3,
      negativeCacheTtlMs: 60_000,
    });

    await expect(authority.resolveSession()).rejects.toMatchObject({
      code: "no_entitlement",
    });
    await expect(authority.resolveSession()).rejects.toMatchObject({
      code: "no_entitlement",
    });

    expect(exchange).toHaveBeenCalledOnce();
  });

  it("bounds retries for transient exchange failures", async () => {
    const exchange = vi.fn(async () => {
      throw new CopilotTokenExchangeError(
        "exchange_failure",
        "Temporary exchange failure",
        { statusCode: 503, retryable: true },
      );
    });
    const sleep = vi.fn(async () => {});
    const authority = new CopilotAuthority({
      accounts: [account("one", "ghu_one")],
      exchange,
      exchangeAttempts: 3,
      exchangeRetryDelayMs: 5,
      sleep,
    });

    await expect(authority.resolveSession()).rejects.toMatchObject({
      code: "exchange_failure",
    });
    expect(exchange).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired canonical OAuth credential before exchange", async () => {
    const expired = createCopilotAccount({
      id: "oauth-account",
      token: "ghu_expired",
      source: "auth-profile",
      refreshToken: "refresh-secret",
      expiresAt: 1,
    });
    const refreshCredential = vi.fn(async () => ({
      type: "oauth" as const,
      accessToken: "ghu_refreshed",
      expiresAt: Date.now() + 60 * 60 * 1000,
    }));
    const exchange = vi.fn(async (candidate: typeof expired) => {
      expect(candidate.credential).toMatchObject({
        type: "oauth",
        accessToken: "ghu_refreshed",
      });
      return session();
    });
    const authority = new CopilotAuthority({
      accounts: [expired],
      refreshCredential,
      exchange,
    });

    await authority.resolveSession();

    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(exchange).toHaveBeenCalledOnce();
  });

  it("normalizes dynamic origin, intent, and vision headers centrally", async () => {
    const authority = new CopilotAuthority({
      accounts: [account("one", "ghu_one")],
      exchange: async () => session(),
    });
    const context = inferCopilotRequestContext(
      [
        { role: "user", content: "first" },
        { role: "assistant", content: "tool next" },
      ],
      { intent: "agent-edit", vision: true },
    );

    const authorization = await authority.authorizeRequest({
      ...context,
      model: "gpt-4.1",
    });

    expect(authorization.headers).toMatchObject({
      "X-Initiator": "agent",
      "Openai-Intent": "agent-edit",
      "Copilot-Vision-Request": "true",
      Authorization: "Bearer copilot-api-token",
    });
  });

  it("filters the account model catalog through policy", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "gpt-4.1" },
        { id: "future-model" },
        { id: "denied-model" },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const authority = new CopilotAuthority({
      accounts: [account("one", "ghu_one")],
      exchange: async () => session(),
      fetchImpl: fetchImpl as typeof fetch,
      modelPolicy: {
        allowedModels: ["gpt-4.1", "future-model"],
        deniedModels: ["denied-model"],
      },
    });

    await expect(authority.availableModels()).resolves.toEqual([
      "gpt-4.1",
      "future-model",
    ]);
    expect(() => authority.assertModelAllowed("denied-model")).toThrowError(
      expect.objectContaining({ code: "forbidden_model" }),
    );
  });

  it("distinguishes unavailable authentication states", async () => {
    const unauthenticated = new CopilotAuthority({
      accounts: [],
      allowAmbientCredentials: false,
    });
    await expect(unauthenticated.resolveSession()).rejects.toMatchObject({
      code: "unauthenticated",
    });

    const failed = new CopilotAuthority({
      accounts: [account("one", "ghu_one")],
      exchangeAttempts: 1,
      exchange: async () => {
        throw new Error("network down");
      },
    });
    await expect(failed.resolveSession()).rejects.toMatchObject({
      code: "exchange_failure",
    });
  });
});

describe("Copilot token and endpoint normalization", () => {
  it("preserves the intended ghu, gho, and PAT authorization behavior", () => {
    expect(authHeaderForGithubToken("ghu_oauth")).toBe("token ghu_oauth");
    expect(authHeaderForGithubToken("gho_oauth")).toBe("Bearer gho_oauth");
    expect(authHeaderForGithubToken("ghp_pat")).toBe("Bearer ghp_pat");
    expect(authHeaderForGithubToken("github_pat_fine_grained")).toBe(
      "Bearer github_pat_fine_grained",
    );
  });

  it("normalizes account endpoints and rejects non-HTTPS endpoints", () => {
    expect(normalizeCopilotApiBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
    expect(() => normalizeCopilotApiBaseUrl("http://api.example.com")).toThrow(
      "unsafe API endpoint",
    );
  });
});

describe("Copilot secret redaction", () => {
  it("removes GitHub, API, and explicit grant secrets from errors", () => {
    const text = redactCopilotSecrets(
      "ghu_owner failed with Bearer api-secret and local-grant",
      ["api-secret", "local-grant"],
    );
    expect(text).not.toContain("ghu_owner");
    expect(text).not.toContain("api-secret");
    expect(text).not.toContain("local-grant");
    expect(text).toContain("***REDACTED***");
  });

  it("uses typed errors for forbidden models", () => {
    const authority = new CopilotAuthority({
      accounts: [],
      allowAmbientCredentials: false,
      modelPolicy: { allowedModels: ["gpt-4.1"] },
    });
    expect(() => authority.assertModelAllowed("other")).toThrowError(
      expect.objectContaining({
        code: "forbidden_model",
      }),
    );
  });
});
