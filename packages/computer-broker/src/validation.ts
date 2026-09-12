import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { WorkspaceScope } from "@rapp-work/work-service";
import { ComputerBrokerError } from "./types.js";
import type { BrokerRequest, ComputerConfiguration } from "./types.js";

export function id(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value);
}

export function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function bounded(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function hostKey(value: string): string {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match?.[1]) throw new ComputerBrokerError("invalid_host_key_pin");
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length !== 51 || bytes.readUInt32BE(0) !== 11
    || bytes.subarray(4, 15).toString("ascii") !== "ssh-ed25519"
    || bytes.readUInt32BE(15) !== 32 || bytes.toString("base64") !== match[1]) {
    throw new ComputerBrokerError("invalid_host_key_pin");
  }
  return value;
}

export function configuration(input: ComputerConfiguration): ComputerConfiguration {
  if (!input || !id(input.id) || !id(input.vmName) || !id(input.guestUser)
    || !input.historyScope || !id(input.historyScope.agentId) || !id(input.historyScope.workspaceId)
    || !/^[a-z0-9][a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(input.image)
    || !bounded(input.maxExecutionMs, 3_600_000) || !bounded(input.maxLeaseMs, 86_400_000)
    || !bounded(input.maxOutputBytes, 16_777_216) || !bounded(input.maxArtifactBytes, 1_073_741_824)) {
    throw new ComputerBrokerError("invalid_computer_configuration");
  }
  if (input.configurationRef !== undefined && !/^[a-f0-9]{64}$/.test(input.configurationRef)) {
    throw new ComputerBrokerError("invalid_configuration_reference");
  }
  hostKey(input.hostKey);
  return Object.freeze({ ...input, historyScope: Object.freeze({ ...input.historyScope }) });
}

export function validateOwner(owner: WorkspaceScope): WorkspaceScope {
  if (!owner || !id(owner.agentId) || !id(owner.workspaceId)) throw new ComputerBrokerError("invalid_workspace");
  return Object.freeze({ agentId: owner.agentId, workspaceId: owner.workspaceId });
}

export function validateRequest(request: BrokerRequest): void {
  if (!request || !text(request.idempotencyKey) || !text(request.parentIntentRef)
    || !id(request.taskId) || !id(request.runId)) throw new ComputerBrokerError("invalid_request");
}

export function guestPath(owner: WorkspaceScope, relative: string, allowRoot = false): string {
  const root = `/workspaces/${owner.workspaceId}`;
  if (allowRoot && relative === ".") return root;
  if (typeof relative !== "string" || relative.length === 0 || relative.length > 1024
    || relative.startsWith("/") || /[\\%\u0000-\u001f\u007f]/u.test(relative)
    || relative.split("/").some((part) => part === "" || part === "." || part === "..")
    || posix.normalize(relative) !== relative) throw new ComputerBrokerError("guest_path_outside_workspace");
  return posix.join(root, relative);
}
