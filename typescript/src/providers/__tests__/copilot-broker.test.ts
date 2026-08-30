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
