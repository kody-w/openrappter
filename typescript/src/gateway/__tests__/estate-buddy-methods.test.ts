import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerEstateBuddyMethods } from "../methods/estate-buddy-methods.js";
import type { EstateBuddyClient } from "../estate-buddy-client.js";
import { GatewayServer } from "../server.js";

describe("estate buddy gateway methods", () => {
  it("registers authenticated list, chat, and create methods", async () => {
    const registered = new Map<
      string,
      {
        handler: (params: unknown, connection?: unknown) => Promise<unknown>;
        requiresAuth: boolean;
      }
    >();
    const server = {
      registerMethod<P = unknown, R = unknown>(
        name: string,
        handler: (params: P, connection: unknown) => Promise<R>,
        options?: { requiresAuth?: boolean },
      ) {
        registered.set(name, {
          handler: handler as (
            params: unknown,
            connection?: unknown,
          ) => Promise<unknown>,
          requiresAuth: options?.requiresAuth === true,
        });
      },
    };
    const client = {
      list: vi.fn().mockResolvedValue({ ok: true, buddies: [] }),
      chat: vi.fn().mockResolvedValue({ ok: true, response: "READY" }),
      create: vi.fn().mockResolvedValue({ ok: true, presence: "online" }),
    } as unknown as EstateBuddyClient;

    registerEstateBuddyMethods(server, { client });

    expect([...registered.keys()]).toEqual([
      "estate.buddies.list",
      "estate.buddies.chat",
      "estate.buddies.create",
    ]);
    expect([...registered.values()].every((entry) => entry.requiresAuth)).toBe(
      true,
    );
    await registered.get("estate.buddies.chat")!.handler({
      buddyId: "barry",
      message: "hello",
    });
    expect(client.chat).toHaveBeenCalledWith({
      buddyId: "barry",
      message: "hello",
    });
  });

  it("registers all three methods on the production GatewayServer path", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "estate-gateway-"));
    const server = new GatewayServer({ port: 0, dataDir });
    try {
      await server.start();
      const methods = (
        server as unknown as {
          methods: Map<string, { requiresAuth: boolean }>;
        }
      ).methods;
      for (const name of [
        "estate.buddies.list",
        "estate.buddies.chat",
        "estate.buddies.create",
      ]) {
        expect(methods.get(name)?.requiresAuth).toBe(true);
      }
    } finally {
      await server.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
