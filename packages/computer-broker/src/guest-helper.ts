import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

interface Request {
  version: 1; action: "execute"; root: string; workspace: { agentId: string; workspaceId: string };
  intentRef: string; hostKey: string;
  request: { argv: string[]; cwd: string; timeoutMs: number; maxOutputBytes: number; readOnly: boolean };
}
function fail(): never { throw new Error("guest_request_rejected"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseGuestRequest(input: unknown): Request {
  if (!record(input) || input.version !== 1 || input.action !== "execute" || !record(input.workspace)
    || typeof input.workspace.agentId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.workspace.agentId)
    || typeof input.workspace.workspaceId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.workspace.workspaceId)
    || input.root !== `/workspaces/${input.workspace.workspaceId}` || typeof input.intentRef !== "string"
    || !/^[a-f0-9]{64}$/.test(input.intentRef) || typeof input.hostKey !== "string"
    || !record(input.request)) fail();
  const request = input.request;
  if (!Array.isArray(request.argv) || request.argv.length < 1 || request.argv.length > 128
    || request.argv.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))
    || !request.argv[0] || typeof request.cwd !== "string" || !Number.isSafeInteger(request.timeoutMs)
    || (request.timeoutMs as number) < 1 || (request.timeoutMs as number) > 30_000
    || !Number.isSafeInteger(request.maxOutputBytes) || (request.maxOutputBytes as number) < 1
    || (request.maxOutputBytes as number) > 262_144 || typeof request.readOnly !== "boolean") fail();
  if (posix.normalize(request.cwd) !== request.cwd
    || (request.cwd !== input.root && !request.cwd.startsWith(`${input.root}/`))
    || /[\\\u0000-\u001f\u007f]/.test(request.cwd)) fail();
  return input as unknown as Request;
}
export function sandboxArguments(request: Request): string[] {
  return [
    "--die-with-parent", "--new-session", "--unshare-all", "--share-net",
    "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib", "/lib64",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/run", "--tmpfs", "/home",
    "--dir", "/etc", "--ro-bind", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind", "/etc/ssl", "/etc/ssl",
    request.request.readOnly ? "--ro-bind" : "--bind", request.root, "/workspace",
    "--clearenv", "--setenv", "HOME", "/workspace", "--setenv", "PATH", "/usr/bin:/bin",
    "--chdir", `/workspace${request.request.cwd.slice(request.root.length)}`,
    "--", ...request.request.argv,
  ];
}
export async function executeGuest(input: unknown) {
  if (process.platform !== "linux") fail();
  const request = parseGuestRequest(input);
  await access("/usr/bin/bwrap", constants.X_OK);
  const base = await lstat("/workspaces");
  if (!base.isDirectory() || base.isSymbolicLink() || await realpath("/workspaces") !== "/workspaces") fail();
  await mkdir(request.root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
  const root = await lstat(request.root);
  if (!root.isDirectory() || root.isSymbolicLink() || (root.mode & 0o077) !== 0
    || root.uid !== process.getuid?.() || await realpath(request.root) !== request.root) fail();
  const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("/usr/bin/bwrap", sandboxArguments(request), {
      shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" },
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, exceeded = false;
    const collect = (target: Buffer[], bytes: Buffer) => {
      size += bytes.length;
      if (size > request.request.maxOutputBytes) { exceeded = true; child.kill("SIGKILL"); return; }
      target.push(bytes);
    };
    child.stdout.on("data", (data: Buffer) => collect(stdout, data));
    child.stderr.on("data", (data: Buffer) => collect(stderr, data));
    const timer = setTimeout(() => child.kill("SIGKILL"), request.request.timeoutMs);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (exceeded) { resolve({ exitCode: 137, stdout: "", stderr: "Guest output limit reached." }); return; }
      resolve({ exitCode: code ?? 137, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
  return { ...result, workspace: request.workspace, intentRef: request.intentRef, hostKey: request.hostKey };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 1_048_576) fail();
    chunks.push(buffer);
  }
  const result = await executeGuest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  process.stdout.write(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { process.stderr.write("Guest operation was not confirmed.\n"); process.exitCode = 1; });
}
