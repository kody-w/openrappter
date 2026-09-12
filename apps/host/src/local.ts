import { createHash, timingSafeEqual } from "node:crypto";
import type { HostServices, Permission, Principal, SecurityPort } from "./ports.js";
import { type Check, type Computer, type Diagnostics } from "./contracts.js";
import { FileStorage } from "./storage.js";
import { createWorkService } from "./work.js";
import { unavailable } from "./errors.js";

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
export function createLocalServices(options: { directory: string; token: string; workspaceId?: string }): HostServices {
  const storage = new FileStorage(options.directory);
  const missing = (name: string) => async (): Promise<Check> =>
    ({ state: "unavailable", detail: `${name} adapter is not configured. No execution has been verified.` });
  const computer: Computer = {
    state: "unavailable", verified: false, verifiedAt: null, evidenceIds: [],
    capabilities: { view: false, control: false },
    detail: "No local computer service is connected. A running computer has not been verified.",
  };
  const entries: Diagnostics["entries"] = [];
  return {
    storage,
    security: tokenSecurity(options.token, {
      id: "desktop-owner", workspaceId: options.workspaceId ?? "local", permissions: ownerPermissions,
    }),
    work: createWorkService(storage),
    runtime: {
      check: missing("Runtime"),
      async start() { return unavailable("Runtime"); },
      async cancel() { return unavailable("Runtime"); },
      async decide() { return unavailable("Runtime"); },
      async schedule() { return unavailable("Scheduling runtime"); },
    },
    provider: {
      check: missing("Provider"),
      async list() { return []; },
      async configure() { return unavailable("Provider"); },
    },
    computer: {
      check: missing("Computer"),
      async inspect() { return structuredClone(computer); },
      async start() { return unavailable("Computer"); },
      async stop() { return unavailable("Computer"); },
    },
    diagnostics: {
      async check() { return { state: "ready", detail: "Bounded, payload-free host diagnostics." }; },
      async snapshot() { return { capturedAt: new Date().toISOString(), entries: structuredClone(entries) }; },
      record(event) {
        entries.unshift({
          id: `diagnostic-${Date.now()}-${entries.length}`, time: new Date().toISOString(),
          level: "error", area: "settings", message: `${event.method}: ${event.code}`,
        });
        entries.splice(200);
      },
    },
  };
}
