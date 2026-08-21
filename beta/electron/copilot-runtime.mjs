import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

const require = createRequire(import.meta.url);
const DEFAULT_START_TIMEOUT_MS = 30_000;

export function copilotPackageName(
  platform = process.platform,
  arch = process.arch,
) {
  const os = platform === "win32"
    ? "win32"
    : platform === "darwin"
      ? "darwin"
      : "linux";
  return `@github/copilot-${os}-${arch}`;
}

export function resolveCopilotCliPath(
  platform = process.platform,
  arch = process.arch,
) {
  const packageName = copilotPackageName(platform, arch);
  try {
    const resolved = require.resolve(packageName);
    if (existsSync(resolved)) return resolved;
  } catch {}

  try {
    const packageDir = path.dirname(
      require.resolve(`${packageName}/package.json`),
    );
    const binaryName = platform === "win32" ? "copilot.exe" : "copilot";
    const binaryPath = path.join(packageDir, binaryName);
    if (existsSync(binaryPath)) return binaryPath;
  } catch {}

  return undefined;
}

export function readGitHubTokenFile(tokenFile) {
  if (!tokenFile || !existsSync(tokenFile)) return null;
  try {
    const value = JSON.parse(readFileSync(tokenFile, "utf8"));
    return typeof value?.access_token === "string" && value.access_token
      ? value.access_token
      : null;
  } catch {
    return null;
  }
}

export function withTimeout(
  promise,
  label,
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not start within ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class CopilotRuntime {
  constructor({
    env = process.env,
    timeoutMs = DEFAULT_START_TIMEOUT_MS,
    tokenFile = null,
    workingDirectory = process.cwd(),
  } = {}) {
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.tokenFile = tokenFile;
    this.workingDirectory = workingDirectory;
    this.client = null;
    this.activeToken = null;
    this.startPromise = null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      if (this.env.BRAINSTEM_BETA_SURGEON_RUNTIME === "fake") {
        const { createSurgeonFakeClient } = await import(
          "../tests/e2e/harness/surgeon-fake.mjs"
        );
        const client = createSurgeonFakeClient({
          env: this.env,
          workingDirectory: this.workingDirectory,
        });
        await client.start();
        const auth = await client.getAuthStatus();
        this.client = client;
        this.activeToken = null;
        return {
          available: true,
          authenticated: Boolean(auth?.isAuthenticated),
          login: auth?.login || null,
          cliPath: null,
        };
      }

      const cliPath = resolveCopilotCliPath();
      const gitHubToken = readGitHubTokenFile(this.tokenFile);
      const options = cliPath
        ? {
            connection: RuntimeConnection.forStdio({ path: cliPath }),
            gitHubToken: gitHubToken || undefined,
            mode: "copilot-cli",
            workingDirectory: this.workingDirectory,
          }
        : {
            gitHubToken: gitHubToken || undefined,
            mode: "copilot-cli",
            workingDirectory: this.workingDirectory,
          };
      const client = new CopilotClient(options);

      try {
        await withTimeout(
          client.start(),
          "Bundled GitHub Copilot CLI",
          this.timeoutMs,
        );
        const auth = await client.getAuthStatus();
        this.client = client;
        this.activeToken = gitHubToken;
        return {
          available: true,
          authenticated: Boolean(auth?.isAuthenticated),
          login: auth?.login || null,
          cliPath: cliPath || null,
        };
      } catch (error) {
        await client.stop().catch(() => undefined);
        throw error;
      }
    })();

    try {
      return await this.startPromise;
    } catch (error) {
      this.startPromise = null;
      throw error;
    }
  }

  async stop() {
    const client = this.client;
    this.client = null;
    this.activeToken = null;
    this.startPromise = null;
    if (!client) return;
    try {
      await withTimeout(
        client.stop(),
        "Bundled GitHub Copilot CLI shutdown",
        5000,
      );
    } catch {
      await client.forceStop().catch(() => undefined);
    }
  }

  async createSession(config) {
    const currentToken = readGitHubTokenFile(this.tokenFile);
    if (
      this.client
      && currentToken !== this.activeToken
      && (currentToken || this.activeToken)
    ) {
      await this.stop();
    }
    await this.start();
    if (!this.client) throw new Error("Bundled GitHub Copilot CLI is unavailable.");
    return this.client.createSession(config);
  }
}
