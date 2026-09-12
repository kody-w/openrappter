import { createHash, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { CopilotSdkTransport, type ManagedCopilotTransport } from "@rapp-work/model-provider";
import { Diagnostics as DiagnosticStore } from "@rapp-work/diagnostics";
import type { FaultInjector } from "@rapp-work/workspace-store";
import type { HostServices, Permission, Principal, SecurityPort } from "./ports.js";
import { providerSchema } from "./contracts.js";
import { conflict } from "./errors.js";
import { committed, json, LocalPersistence } from "./persistence.js";
import { commandKey, LocalWork } from "./local-work.js";
import { LocalRuntime } from "./local-runtime.js";
import { LocalComputer } from "./local-computer.js";
import type { FixedCommandTransport } from "./computer-drivers.js";

export const ownerPermissions: readonly Permission[] = [
  "work:read", "work:write", "agents:read", "agents:write", "automations:read", "automations:write",
  "settings:read", "settings:write", "runtime:execute", "computer:read", "computer:control",
  "diagnostics:read", "events:read",
];
export function tokenSecurity(token: string, principal: Principal): SecurityPort {
  if (!/^[a-zA-Z0-9_-]{43,256}$/.test(token)) throw new Error("A cryptographically random bearer token is required.");
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const expected = hash(token);
  const owner = structuredClone(principal);
  return {
    async check() { return { state: "ready", detail: "Owner-scoped bearer authentication." }; },
    async authenticate(value) {
      return value.length <= 256 && timingSafeEqual(hash(value), expected) ? structuredClone(owner) : null;
    },
    async authorize(identity, permission) {
      return identity.id === owner.id && identity.workspaceId === owner.workspaceId &&
        owner.permissions.includes(permission);
    },
  };
}
export interface LocalServiceOptions {
  directory: string;
  token: string;
  copilot?: ManagedCopilotTransport;
  commands?: FixedCommandTransport;
  persistenceFault?: FaultInjector;
}
export function createLocalServices(options: LocalServiceOptions): HostServices & {
  persistence: LocalPersistence; runtime: LocalRuntime; work: LocalWork;
} {
  const persistence = new LocalPersistence(options.directory, options.token, options.persistenceFault);
  const work = new LocalWork(persistence);
  const transport = options.copilot ?? new CopilotSdkTransport({
    directory: join(persistence.directory, "providers", "github-copilot"), home: homedir(),
  });
  const computer = new LocalComputer(persistence, work, options.commands);
  const runtime = new LocalRuntime(persistence, work, transport, computer);
  const diagnosticStore = new DiagnosticStore({ maxRecords: 200 });
  const tokenCheck = tokenSecurity(options.token, { id: "owner", workspaceId: "catalog", permissions: ownerPermissions });
  const owner = (): Principal => ({
    id: persistence.owner.id, workspaceId: persistence.owner.catalog.workspaceId, permissions: ownerPermissions,
  });
  const services: HostServices & { persistence: LocalPersistence; runtime: LocalRuntime; work: LocalWork } = {
    persistence, work, runtime, computer,
    storage: {
      initialize: async () => { await work.initialize(); await runtime.activateScheduling(services.provider); },
      check: work.check, read: work.read.bind(work), close: work.close.bind(work),
    },
    security: {
      check: () => tokenCheck.check(),
      async authenticate(bearer) { return await tokenCheck.authenticate(bearer) ? owner() : null; },
      async authorize(principal, permission) {
        const expected = owner();
        return principal.id === expected.id && principal.workspaceId === expected.workspaceId
          && expected.permissions.includes(permission);
      },
    },
    provider: {
      async check() {
        const status = await transport.status();
        return { state: status.availability === "ready" && status.authentication === "authenticated" ? "ready" : "unavailable",
          detail: status.detail };
      },
      async list(context) {
        work.assertContext(context);
        const status = await transport.status();
        return [providerSchema.parse({
          id: "github-copilot", name: "GitHub Copilot", ...status,
          configured: status.availability === "ready" && status.authentication === "authenticated",
        })];
      },
      async configure(context, input) {
        work.assertContext(context);
        if (input.id !== "github-copilot" || input.connectionRef !== "copilot-cli") {
          conflict("Use the supported copilot-cli connection. Credentials are managed by Copilot CLI, never an RPC field.");
        }
        const provider = (await this.list(context))[0]!;
        const saved = committed(await persistence.commit(persistence.owner.catalog, commandKey("provider/configure", context),
          "host.provider.configure", input, async () => ({
            status: "succeeded", value: json(provider), receipts: [{ kind: "provider-status", authentication: provider.authentication }],
            events: [{ type: "provider.configured", provider: json(provider) }],
          })));
        return providerSchema.parse(saved.value);
      },
      close: () => transport.close(),
    },
    diagnostics: {
      async check() { return { state: "ready", detail: "Bounded, payload-free host diagnostics." }; },
      async snapshot(context) {
        work.assertContext(context);
        return {
          capturedAt: new Date().toISOString(),
          entries: diagnosticStore.snapshot().map((entry) => ({
            id: `diagnostic-${entry.sequence}`, time: entry.at, level: "error" as const, area: "settings" as const,
            message: JSON.stringify(entry.data).slice(0, 1000),
          })),
        };
      },
      record(event) {
        diagnosticStore.record({ component: "host", operation: event.method, level: "error", details: { code: event.code } });
      },
    },
  };
  return services;
}
