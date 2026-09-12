import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { CopilotSdkTransport, type ManagedCopilotTransport } from "@rapp-work/model-provider";
import { Diagnostics as DiagnosticStore } from "@rapp-work/diagnostics";
import type { FaultInjector } from "@rapp-work/workspace-store";
import { OWNER_PERMISSIONS, type HostServices, type Principal, type RequestContext, type SecurityPort } from "./ports.js";
import { providerSchema } from "./contracts.js";
import { conflict } from "./errors.js";
import { committed, json, LocalPersistence } from "./persistence.js";
import { commandKey, LocalWork } from "./local-work.js";
import { LocalRuntime } from "./local-runtime.js";
import { LocalComputer } from "./local-computer.js";
import type { FixedCommandTransport } from "./computer-drivers.js";
import { LocalTwin } from "./twin.js";

export const ownerPermissions = OWNER_PERMISSIONS;
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
    async authorizeWorkspace(identity, workspaceId, permission) {
      return identity.id === owner.id && identity.workspaceId === owner.workspaceId
        && owner.permissions.includes(permission) && (workspaceId === null || workspaceId === owner.workspaceId);
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
  createAgentSession(context: RequestContext, agentId: string): Promise<{ token: string; principal: Principal }>;
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
  const owner = (): Principal => persistence.humanPrincipal();
  const agentSessions = new Map<string, Principal>();
  const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
  const services: Omit<HostServices, "twin"> & { persistence: LocalPersistence; runtime: LocalRuntime; work: LocalWork } = {
    persistence, work, runtime, computer,
    storage: {
      initialize: async () => { await work.initialize(); await runtime.activateScheduling(services.provider); },
      check: work.check, read: work.read.bind(work), close: work.close.bind(work),
    },
    security: {
      check: () => tokenCheck.check(),
      async authenticate(bearer) {
        if (await tokenCheck.authenticate(bearer)) return owner();
        const principal = agentSessions.get(tokenHash(bearer));
        return principal && persistence.isAgent(principal) ? principal : null;
      },
      async authorize(principal, permission) {
        return (persistence.isHuman(principal) || persistence.isAgent(principal)) && principal.permissions.includes(permission);
      },
      async authorizeWorkspace(principal, workspaceId, permission) {
        return persistence.canAccess(principal, workspaceId, permission);
      },
    },
    provider: {
      async check() {
        const status = await transport.status();
        return { state: status.availability === "ready" && status.authentication === "authenticated" ? "ready" : "unavailable",
          detail: status.detail };
      },
      async list(context) {
        work.contextScope(context);
        const status = await transport.status();
        return [providerSchema.parse({
          id: "github-copilot", name: "GitHub Copilot", ...status,
          configured: status.availability === "ready" && status.authentication === "authenticated",
        })];
      },
      async configure(context, input) {
        work.assertOwner(context);
        work.assertContext(context);
        if (input.id !== "github-copilot" || input.connectionRef !== "copilot-cli") {
          conflict("Use the supported copilot-cli connection. Credentials are managed by Copilot CLI, never an RPC field.");
        }
        const provider = (await this.list(context))[0]!;
        const saved = committed(await persistence.commit(work.assertContext(context), commandKey("provider/configure", context),
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
        work.contextScope(context);
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
  return {
    ...services, twin: new LocalTwin(persistence, work, transport, services.provider, computer, runtime, services.security),
    async createAgentSession(context, agentId) {
      if (!await services.security.authorizeWorkspace(context.principal, context.workspaceId!, "agents:write")) {
        throw new Error("Agent sessions require authority over the exact parent workspace.");
      }
      const principal = await work.agentPrincipal(context, agentId);
      const token = randomBytes(48).toString("base64url");
      agentSessions.set(tokenHash(token), principal);
      return { token, principal };
    },
  };
}
