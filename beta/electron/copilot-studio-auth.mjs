import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";


const execFileAsync = promisify(execFile);

export function resolvePacExecutable(env = process.env) {
  if (env.BRAINSTEM_BETA_PAC && existsSync(env.BRAINSTEM_BETA_PAC)) {
    return env.BRAINSTEM_BETA_PAC;
  }
  const dotnetTool = path.join(homedir(), ".dotnet", "tools", "pac");
  return existsSync(dotnetTool) ? dotnetTool : "pac";
}

export function readDeploymentDefaults(filePath) {
  const resolved = path.resolve(filePath);
  const settings = JSON.parse(readFileSync(resolved, "utf8"));
  const values = settings?.Values || {};
  return {
    settings_path: resolved,
    assistant_name: values.ASSISTANT_NAME || null,
    client_id: values.DYNAMICS_365_CLIENT_ID || null,
    environment_url: values.DYNAMICS_365_RESOURCE || null,
    tenant_id: values.DYNAMICS_365_TENANT_ID || null,
    secret_present: Boolean(values.DYNAMICS_365_CLIENT_SECRET),
  };
}

export class CopilotStudioAuthManager {
  constructor({
    env = process.env,
    pacExecutable = resolvePacExecutable(env),
  } = {}) {
    this.env = env;
    this.pacExecutable = pacExecutable;
    this.logins = new Map();
  }

  async runPac(args, timeout = 120000) {
    const result = await execFileAsync(this.pacExecutable, args, {
      encoding: "utf8",
      env: this.env,
      maxBuffer: 5 * 1024 * 1024,
      timeout,
      windowsHide: true,
    });
    return `${result.stdout || ""}${result.stderr || ""}`.trim();
  }

  async status() {
    const profiles = await this.runPac(["auth", "list"]);
    let active = null;
    try {
      active = await this.runPac(["auth", "who"]);
    } catch (error) {
      active = String(error?.stderr || error?.message || error);
    }
    return {
      pac: this.pacExecutable,
      profiles,
      active,
    };
  }

  defaults(settingsPath = null) {
    const candidate = settingsPath
      || this.env.BRAINSTEM_BETA_LOCAL_SETTINGS
      || path.join(homedir(), "Downloads", "local.settings.json");
    if (!existsSync(candidate)) {
      throw new Error(`Copilot Studio deployment settings are missing: ${candidate}`);
    }
    return readDeploymentDefaults(candidate);
  }

  async startDeviceLogin({
    environment = null,
    profileName = null,
  } = {}) {
    const id = randomUUID();
    const args = ["auth", "create", "--deviceCode"];
    if (profileName) args.push("--name", String(profileName).slice(0, 30));
    if (environment) args.push("--environment", String(environment));
    const child = spawn(this.pacExecutable, args, {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const state = {
      child,
      completedAt: null,
      exitCode: null,
      id,
      output: "",
      startedAt: new Date().toISOString(),
    };
    const append = (chunk) => {
      state.output = `${state.output}${chunk}`.slice(-16000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("exit", (code) => {
      state.exitCode = code;
      state.completedAt = new Date().toISOString();
    });
    child.once("error", (error) => {
      append(`\n${error.message}`);
      state.exitCode = -1;
      state.completedAt = new Date().toISOString();
    });
    this.logins.set(id, state);

    const deadline = Date.now() + 20000;
    while (
      Date.now() < deadline
      && state.exitCode === null
      && !/device|code|login|microsoft\.com/i.test(state.output)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return this.loginStatus(id);
  }

  loginStatus(id) {
    const state = this.logins.get(String(id || ""));
    if (!state) throw new Error("Unknown Copilot Studio login request.");
    return {
      id: state.id,
      status: state.exitCode === null
        ? "waiting_for_user"
        : state.exitCode === 0
          ? "authenticated"
          : "failed",
      exit_code: state.exitCode,
      output: state.output.trim(),
      started_at: state.startedAt,
      completed_at: state.completedAt,
    };
  }

  async stop() {
    for (const state of this.logins.values()) {
      if (state.exitCode === null) state.child.kill("SIGTERM");
    }
    this.logins.clear();
  }
}
