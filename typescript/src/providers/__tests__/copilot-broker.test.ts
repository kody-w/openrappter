import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CopilotAuthority,
  createCopilotAccount,
} from "../copilot-authority.js";
import {
  CopilotBrokerClient,
  CopilotLoopbackBroker,
} from "../copilot-broker.js";

const brokers: CopilotLoopbackBroker[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

function authority(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): CopilotAuthority {
  return new CopilotAuthority({
    accounts: [createCopilotAccount({
      id: "selected-account",
      token: "ghu_account-secret",
      source: "auth-profile",
      default: true,
    })],
    exchange: async () => ({
      token: "copilot-api-secret",
      expiresAt: (options?.now?.() ?? Date.now()) + 60 * 60 * 1000,
      baseUrl: "https://api.account.example",
      source: "test",
    }),
    fetchImpl: options?.fetchImpl ?? (async () => new Response(JSON.stringify({
      data: [{ id: "gpt-4.1" }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })),
    now: options?.now,
  });
}

async function startedBroker(options?: {
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<CopilotLoopbackBroker> {
  const broker = new CopilotLoopbackBroker({
    authority: authority(options),
    now: options?.now,
  });
  brokers.push(broker);
  await broker.start();
  return broker;
}

describe("CopilotLoopbackBroker", () => {
  it("binds loopback only and refuses wildcard interfaces", async () => {
    const broker = new CopilotLoopbackBroker({ authority: authority() });
    brokers.push(broker);

    await expect(broker.start({ host: "0.0.0.0" })).rejects.toMatchObject({
      code: "unavailable",
    });
    const origin = await broker.start();
    expect(new URL(origin).hostname).toBe("127.0.0.1");
  });

  it("relays only policy-approved models with dynamic headers", async () => {
    const upstreamCalls: Array<{ url: string; headers: Headers; body?: string }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "gpt-4.1" }, { id: "other-model" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      upstreamCalls.push({
        url,
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const broker = await startedBroker({ fetchImpl: fetchImpl as typeof fetch });
    const grant = await broker.issueGrant({
      allowedModels: ["gpt-4.1"],
      ttlMs: 10_000,
    });
    const client = new CopilotBrokerClient(grant);

    await expect(client.models()).resolves.toEqual(["gpt-4.1"]);
    const response = await client.chat({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hello" }],
    }, {
      initiator: "user",
      intent: "conversation-panel",
      vision: true,
    });

    expect(response.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe(
      "https://api.account.example/chat/completions",
    );
    expect(upstreamCalls[0].headers.get("authorization")).toBe(
      "Bearer copilot-api-secret",
    );
    expect(upstreamCalls[0].headers.get("authorization")).not.toContain(
      grant.authorization.bearerToken,
    );
    expect(upstreamCalls[0].headers.get("x-initiator")).toBe("user");
    expect(upstreamCalls[0].headers.get("openai-intent")).toBe(
      "conversation-panel",
    );
    expect(upstreamCalls[0].headers.get("copilot-vision-request")).toBe("true");
  });

  it("rejects bearer mismatches without exposing account credentials", async () => {
    const broker = await startedBroker();
    const grant = await broker.issueGrant({ allowedModels: ["gpt-4.1"] });

    const response = await fetch(`${grant.descriptor.baseUrl}/models`, {
      headers: { Authorization: "Bearer wrong-bearer" },
    });
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).toContain("unauthenticated");
    expect(text).not.toContain("ghu_account-secret");
    expect(text).not.toContain("copilot-api-secret");
  });

  it("expires grants by TTL and reports expired_grant", async () => {
    let now = 10_000;
    const broker = await startedBroker({ now: () => now });
    const grant = await broker.issueGrant({
      allowedModels: ["gpt-4.1"],
      ttlMs: 25,
    });
    now += 26;

    const response = await fetch(`${grant.descriptor.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${grant.authorization.bearerToken}`,
      },
    });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "expired_grant" },
    });
  });

  it("revokes grants immediately", async () => {
    const broker = await startedBroker();
    const grant = await broker.issueGrant({ allowedModels: ["gpt-4.1"] });
    expect(broker.revoke(grant.descriptor.grantId)).toBe(true);

    const response = await fetch(`${grant.descriptor.baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${grant.authorization.bearerToken}`,
      },
    });

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "expired_grant" },
    });
  });

  it("never routes an account A grant through account B after selection changes", async () => {
    const upstreamUrls: string[] = [];
    const sharedAuthority = new CopilotAuthority({
      accounts: [
        createCopilotAccount({
          id: "account-a",
          token: "ghu_account_a",
          source: "auth-profile",
          default: true,
        }),
        createCopilotAccount({
          id: "account-b",
          token: "ghu_account_b",
          source: "auth-profile",
        }),
      ],
      selectedAccountId: "account-a",
      exchange: async (candidate) => ({
        token: `api-token-${candidate.id}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
        baseUrl: `https://api.${candidate.id}.example`,
        source: "test",
      }),
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        upstreamUrls.push(url);
        if (url.endsWith("/v1/models")) {
          return new Response(JSON.stringify({
            data: [{ id: "gpt-4.1" }],
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: url } }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    const broker = new CopilotLoopbackBroker({ authority: sharedAuthority });
    brokers.push(broker);
    await broker.start();
    const accountAGrant = await broker.issueGrant({
      allowedModels: ["gpt-4.1"],
    });
    const accountAClient = new CopilotBrokerClient(accountAGrant);

    sharedAuthority.selectAccount("account-b");
    const oldGrantResponse = await accountAClient.chat({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "must not cross accounts" }],
    });

    expect(oldGrantResponse.status).toBe(410);
    await expect(oldGrantResponse.json()).resolves.toMatchObject({
      error: { code: "expired_grant" },
    });
    expect(upstreamUrls.some((url) =>
      url.startsWith("https://api.account-b.example/")
    )).toBe(false);

    const accountBGrant = await broker.issueGrant({
      allowedModels: ["gpt-4.1"],
    });
    const accountBClient = new CopilotBrokerClient(accountBGrant);
    const newGrantResponse = await accountBClient.chat({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "new account grant" }],
    });

    expect(newGrantResponse.status).toBe(200);
    expect(upstreamUrls.filter((url) =>
      url === "https://api.account-b.example/chat/completions"
    )).toHaveLength(1);
  });

  it("checks the bound account even when an account resolver changes silently", async () => {
    let activeAccount = createCopilotAccount({
      id: "account-a",
      token: "ghu_account_a",
      source: "auth-profile",
      default: true,
    });
    const upstreamUrls: string[] = [];
    const sharedAuthority = new CopilotAuthority({
      accountResolver: async () => [activeAccount],
      allowAmbientCredentials: false,
      exchange: async (candidate) => ({
        token: `api-token-${candidate.id}`,
        expiresAt: Date.now() + 60 * 60 * 1000,
        baseUrl: `https://api.${candidate.id}.example`,
        source: "test",
      }),
      fetchImpl: vi.fn(async (input: string | URL | Request) => {
        upstreamUrls.push(String(input));
        return new Response(JSON.stringify({
          data: [{ id: "gpt-4.1" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
    });
    const broker = new CopilotLoopbackBroker({ authority: sharedAuthority });
    brokers.push(broker);
    await broker.start();
    const grant = await broker.issueGrant({ allowedModels: ["gpt-4.1"] });
    const client = new CopilotBrokerClient(grant);

    activeAccount = createCopilotAccount({
      id: "account-b",
      token: "ghu_account_b",
      source: "auth-profile",
      default: true,
    });
    const response = await client.chat({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "must stay on account A" }],
    });

    expect(response.status).toBe(410);
    expect(upstreamUrls.some((url) =>
      url.startsWith("https://api.account-b.example/")
    )).toBe(false);
  });

  it("fails closed for a model outside the grant policy", async () => {
    const broker = await startedBroker();
    const grant = await broker.issueGrant({ allowedModels: ["gpt-4.1"] });
    const client = new CopilotBrokerClient(grant);

    const response = await client.chat({
      model: "other-model",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "forbidden_model" },
    });
  });

  it("does not mint a grant when account model evidence is unavailable", async () => {
    const broker = new CopilotLoopbackBroker({
      authority: authority({
        fetchImpl: vi.fn(async () => new Response("unavailable", {
          status: 503,
        })) as unknown as typeof fetch,
      }),
    });
    brokers.push(broker);
    await broker.start();

    await expect(broker.issueGrant({
      allowedModels: ["gpt-4.1"],
    })).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  it("re-resolves once after an upstream authorization failure", async () => {
    let chatAttempts = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "gpt-4.1" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      chatAttempts++;
      if (chatAttempts === 1) {
        return new Response("expired", { status: 401 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "recovered" } }],
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const broker = await startedBroker({ fetchImpl: fetchImpl as typeof fetch });
    const grant = await broker.issueGrant({ allowedModels: ["gpt-4.1"] });
    const client = new CopilotBrokerClient(grant);

    const response = await client.chat({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "recover" }],
    });

    expect(response.status).toBe(200);
    expect(chatAttempts).toBe(2);
    await expect(response.json()).resolves.toMatchObject({
      choices: [{ message: { content: "recovered" } }],
    });
  });

  it("aborts active upstream work before closing", async () => {
    let upstreamSignal: AbortSignal | null = null;
    const fetchImpl = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      if (String(input).endsWith("/v1/models")) {
        return new Response(JSON.stringify({
          data: [{ id: "gpt-4.1" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      upstreamSignal = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });
    const broker = await startedBroker({ fetchImpl: fetchImpl as typeof fetch });
    const grant = await broker.issueGrant({ allowedModels: ["gpt-4.1"] });
    const client = new CopilotBrokerClient(grant);
    const pending = client.chat({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "wait" }],
    });
    await vi.waitFor(() => expect(upstreamSignal).not.toBeNull());

    await broker.close();

    expect((upstreamSignal as AbortSignal | null)?.aborted).toBe(true);
    const result = await pending.catch((error: unknown) => error);
    if (result instanceof Response) {
      expect(result.ok).toBe(false);
    } else {
      expect(result).toBeInstanceOf(Error);
    }
  });

  it("omits bearer credentials from serialized grant receipts", async () => {
    const broker = await startedBroker();
    const grant = await broker.issueGrant({ allowedModels: ["gpt-4.1"] });

    const receipt = JSON.stringify(grant);

    expect(receipt).not.toContain(grant.authorization.bearerToken);
    expect(receipt).not.toContain("ghu_account-secret");
    expect(receipt).not.toContain("copilot-api-secret");
    expect(receipt).toContain(grant.descriptor.grantId);
  });
});
