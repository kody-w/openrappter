import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export interface EstateBuddy {
  id: string;
  name: string;
  device: string;
  rappid: string | null;
  presence: "online" | "offline";
  status: "ready" | "offline";
  herdr_status?: string | null;
  transport: "local" | "ssh-posix" | "ssh-windows";
  via_probe: boolean;
  ui?: "chat" | "rapplication" | null;
  application_url?: string | null;
  default_chat_url?: string | null;
}

export interface EstateBuddyListResult {
  ok: boolean;
  estate: string;
  devices: string[];
  buddies: EstateBuddy[];
  error?: string;
}

export interface EstateBuddyChatResult {
  ok: boolean;
  buddy: EstateBuddy;
  response?: string;
  session_id?: string | null;
  responded_at?: string | null;
  error?: string;
}

export interface EstateBuddyCreateInput {
  deviceId: string;
  name: string;
  role: string;
  ui?: "auto" | "chat" | "rapplication";
  portStart?: number;
}

export interface EstateBuddyCreateResult {
  ok: boolean;
  device: string;
  presence: "online";
  created: {
    name: string;
    rappid: string;
    ui: "chat" | "rapplication";
  };
  handshake: {
    ready: true;
    response: string;
  };
  error?: string;
}

export interface EstateBuddyChatInput {
  buddyId: string;
  message: string;
  sessionId?: string;
}

export type EstateCommandRunner = (
  args: string[],
  input: string | undefined,
  timeoutMs: number,
) => Promise<string>;

export interface EstateBuddyClientOptions {
  binary?: string;
  manifest?: string;
  timeoutMs?: number;
  runner?: EstateCommandRunner;
}

function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function parseResult<T extends { ok: boolean; error?: string }>(
  stdout: string,
  operation: string,
): T {
  let result: unknown;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `RAPP-Herdr returned invalid JSON for ${operation}: ${detail}`,
    );
  }
  if (
    !result ||
    typeof result !== "object" ||
    typeof (result as { ok?: unknown }).ok !== "boolean"
  ) {
    throw new Error(`RAPP-Herdr returned an invalid ${operation} receipt`);
  }
  const typed = result as T;
  if (!typed.ok) {
    throw new Error(typed.error || `RAPP-Herdr ${operation} failed`);
  }
  return typed;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isEstateBuddy(value: unknown): value is EstateBuddy {
  if (!value || typeof value !== "object") return false;
  const buddy = value as Partial<EstateBuddy>;
  return (
    typeof buddy.id === "string" &&
    buddy.id.length > 0 &&
    typeof buddy.name === "string" &&
    buddy.name.length > 0 &&
    typeof buddy.device === "string" &&
    buddy.device.length > 0 &&
    (buddy.rappid === null || typeof buddy.rappid === "string") &&
    (buddy.presence === "online" || buddy.presence === "offline") &&
    (buddy.status === "ready" || buddy.status === "offline") &&
    (buddy.transport === "local" ||
      buddy.transport === "ssh-posix" ||
      buddy.transport === "ssh-windows") &&
    typeof buddy.via_probe === "boolean" &&
    (buddy.ui === undefined ||
      buddy.ui === null ||
      buddy.ui === "chat" ||
      buddy.ui === "rapplication") &&
    isOptionalString(buddy.herdr_status) &&
    isOptionalString(buddy.application_url) &&
    isOptionalString(buddy.default_chat_url)
  );
}

export function createEstateCommandRunner(
  binary: string,
): EstateCommandRunner {
  return (args, input, timeoutMs) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(binary, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stdout.toString("utf8"));
      };
      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 2_000);
        forceKillTimer.unref();
      };
      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
      ): Buffer<ArrayBufferLike> => {
        const next = Buffer.concat([current, chunk]);
        if (next.byteLength > MAX_OUTPUT_BYTES) {
          terminate();
          finish(new Error("RAPP-Herdr output exceeded the 2 MB limit"));
        }
        return next;
      };
      const timer = setTimeout(() => {
        terminate();
        finish(new Error(`RAPP-Herdr did not finish within ${timeoutMs} ms`));
      }, timeoutMs);

      child.once("error", (error) =>
        finish(new Error(`Cannot start RAPP-Herdr: ${error.message}`)),
      );
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.stdin.once("error", (error) => {
        terminate();
        finish(new Error(`Cannot send request to RAPP-Herdr: ${error.message}`));
      });
      child.once("close", (code, signal) => {
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (code === 0) {
          finish();
          return;
        }
        const detail =
          stderr.toString("utf8").trim() || stdout.toString("utf8").trim();
        finish(
          new Error(
            `RAPP-Herdr exited ${code ?? `on ${signal ?? "unknown signal"}`}` +
              (detail ? `: ${detail}` : ""),
          ),
        );
      });
      child.stdin.end(input);
    });
}

export class EstateBuddyClient {
  private readonly manifest: string;
  private readonly timeoutMs: number;
  private readonly runCommand: EstateCommandRunner;

  constructor(options: EstateBuddyClientOptions = {}) {
    const binary =
      options.binary ??
      process.env.RAPP_HERDR_BIN ??
      path.join(os.homedir(), ".local", "bin", "rapp-herdr");
    this.manifest =
      options.manifest ??
      process.env.RAPP_HERDR_ESTATE ??
      path.join(os.homedir(), ".config", "rapp-herdr", "estate.json");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.runCommand = options.runner ?? createEstateCommandRunner(binary);
  }

  async list(): Promise<EstateBuddyListResult> {
    const stdout = await this.runCommand(
      ["estate", "buddy", "list", this.manifest],
      undefined,
      this.timeoutMs,
    );
    const result = parseResult<EstateBuddyListResult>(stdout, "buddy list");
    if (
      typeof result.estate !== "string" ||
      result.estate.trim() === "" ||
      !Array.isArray(result.buddies) ||
      !result.buddies.every(isEstateBuddy)
    ) {
      throw new Error("RAPP-Herdr buddy list receipt contained invalid buddies");
    }
    if (
      !Array.isArray(result.devices) ||
      !result.devices.every(
        (device) => typeof device === "string" && device.length > 0,
      )
    ) {
      throw new Error("RAPP-Herdr buddy list receipt omitted devices");
    }
    return result;
  }

  async chat(input: EstateBuddyChatInput): Promise<EstateBuddyChatResult> {
    const request = {
      buddy_id: requiredText(input.buddyId, "buddyId", 128),
      message: requiredText(input.message, "message", 100_000),
      ...(input.sessionId
        ? { session_id: requiredText(input.sessionId, "sessionId", 256) }
        : {}),
    };
    const stdout = await this.runCommand(
      ["estate", "buddy", "chat", this.manifest, "--stdin"],
      JSON.stringify(request),
      this.timeoutMs,
    );
    const result = parseResult<EstateBuddyChatResult>(stdout, "buddy chat");
    if (
      !isEstateBuddy(result.buddy) ||
      result.buddy.id !== request.buddy_id ||
      result.buddy.presence !== "online" ||
      result.buddy.status !== "ready" ||
      typeof result.response !== "string" ||
      result.response.trim() === "" ||
      !isOptionalString(result.session_id) ||
      !isOptionalString(result.responded_at)
    ) {
      throw new Error("RAPP-Herdr buddy chat receipt was incomplete");
    }
    return result;
  }

  async create(
    input: EstateBuddyCreateInput,
  ): Promise<EstateBuddyCreateResult> {
    const ui = input.ui ?? "auto";
    if (!["auto", "chat", "rapplication"].includes(ui)) {
      throw new Error("ui must be auto, chat, or rapplication");
    }
    const portStart = input.portStart ?? 7200;
    if (!Number.isInteger(portStart) || portStart < 7200 || portStart > 7299) {
      throw new Error("portStart must be an integer from 7200 to 7299");
    }
    const request = {
      device_id: requiredText(input.deviceId, "deviceId", 128),
      name: requiredText(input.name, "name", 80),
      role: requiredText(input.role, "role", 4_000),
      ui,
      port_start: portStart,
    };
    const stdout = await this.runCommand(
      ["estate", "buddy", "create", this.manifest, "--stdin"],
      JSON.stringify(request),
      this.timeoutMs,
    );
    const result = parseResult<EstateBuddyCreateResult>(stdout, "buddy create");
    if (
      result.device !== request.device_id ||
      result.presence !== "online" ||
      !result.created ||
      typeof result.created.name !== "string" ||
      result.created.name.trim() === "" ||
      typeof result.created.rappid !== "string" ||
      result.created.rappid.trim() === "" ||
      (result.created.ui !== "chat" &&
        result.created.ui !== "rapplication") ||
      !result.handshake ||
      result.handshake.ready !== true ||
      typeof result.handshake.response !== "string" ||
      result.handshake.response.trim() === ""
    ) {
      throw new Error("RAPP-Herdr did not verify the new buddy as online");
    }
    return result;
  }
}
