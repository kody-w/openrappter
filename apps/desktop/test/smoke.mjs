import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, ".test-scratch", `desktop-${randomUUID()}`);
const profile = join(scratch, "profile");
const results = join(root, "test-results");
await mkdir(profile, { recursive: true, mode: 0o700 });
await mkdir(results, { recursive: true });
let application;
const errors = [];
const hostPids = new Set();
async function launch() {
  application = await electron.launch({
    executablePath: electronPath, args: [root], timeout: 30000,
    env: { ...process.env, RAPP_WORK_USER_DATA: profile, TMPDIR: scratch, NODE_ENV: "test" },
  });
  const page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("heading", { name: "Work", exact: true, level: 1 }).waitFor();
  await expect(page.getByText("Host connected", { exact: true })).toBeVisible({ timeout: 20000 });
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics());
  for (const process of metrics) {
    if (process.name === "RAPP Work Host") hostPids.add(process.pid);
  }
  expect(hostPids.size, "Exactly one owned host must be visible in the process metrics.").toBe(1);
  return page;
}
async function quitAndCheck() {
  await application.close();
  application = undefined;
  for (const pid of hostPids) {
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    }, { timeout: 6000, message: "Owned host must not survive desktop quit." }).toBe(false);
  }
  hostPids.clear();
}
try {
  let page = await launch();
  const boundary = await page.evaluate(() => ({
    keys: Object.keys(window.rappWork).sort(),
    node: typeof window.require, process: typeof window.process,
  }));
  expect(boundary).toEqual({ keys: ["hostState", "onEvent", "request"], node: "undefined", process: "undefined" });
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const options = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: options.sandbox, contextIsolation: options.contextIsolation, nodeIntegration: options.nodeIntegration, webSecurity: options.webSecurity };
  });
  expect(preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  const status = await page.evaluate(() => window.rappWork.request({ method: "system.status", params: {} }));
  expect(status.ready).toBe(false);
  expect(status.checks.runtime.state).toBe("ready");
  expect(status.checks.storage.state).toBe("ready");
  const computer = await page.evaluate(() => window.rappWork.request({ method: "computer.inspect", params: { workspaceId: null } }));
  expect(computer.verified).toBe(false);
  expect(computer.state).toBe("unavailable");
  const rejected = await page.evaluate(async () => {
    try { await window.rappWork.request({ method: "shell.execute", params: {} }); return false; } catch { return true; }
  });
  expect(rejected).toBe(true);
  const workspaceId = await page.evaluate(async () => {
    const workspace = await window.rappWork.request({ method: "workspaces.create", params: {
      requestId: crypto.randomUUID(), name: "Local persistence check", purpose: "Verify reviewed offline persistence without a model fallback.",
      twin: { name: "Local smoke Twin", instructions: "Draft only with a verified model and human review." },
      leadAgent: { id: "smoke-analyst", name: "Local smoke analyst", role: "Offline validation",
        instructions: "No production execution; validate local configuration persistence only.", providerId: null,
        model: "", enabled: false, computerPolicy: "none", approvalPolicy: "always" },
      starterTask: { requestId: crypto.randomUUID(), title: "Validate a local work record",
        instructions: "Store the reviewed task without claiming execution or verification.", agentId: "smoke-analyst", priority: "normal" },
      starterRoutines: [], computerPolicy: "none", approvalPolicy: "always",
    } });
    return workspace.id;
  });
  await page.getByRole("button", { name: "Refresh workspace" }).click();
  await page.getByRole("button", { name: "Open Local persistence check", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await nav.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Your intent or full instruction document")).toBeFocused();
  await nav.getByRole("link", { name: "Work", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start task", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start agent computer", exact: true })).toBeDisabled();
  await page.screenshot({ path: join(results, "desktop-work.png") });
  const persisted = await page.evaluate((workspaceId) => window.rappWork.request({ method: "work.snapshot", params: { workspaceId } }), workspaceId);
  expect(persisted.tasks).toHaveLength(1);
  expect(persisted.agents).toHaveLength(1);
  expect(persisted.tasks[0].workspaceId).toBe(persisted.agents[0].workspaceId);
  expect(persisted.agents[0].workspaceId).not.toBe(persisted.agents[0].id);
  const path = join(profile, "workspaces", persisted.agents[0].workspaceId, "identity.json");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const identity = JSON.parse(await readFile(path, "utf8"));
  expect(identity.agent_id).toBe(persisted.agents[0].id);
  expect(identity.workspace_id).toBe(persisted.tasks[0].workspaceId);
  await quitAndCheck();
  page = await launch();
  await expect(page.getByRole("heading", { name: "Validate a local work record", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Local smoke analyst's workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start task", exact: true })).toBeDisabled();
  await quitAndCheck();
  expect(errors).toEqual([]);
  const report = {
    product: "RAPP Work", platform: process.platform, architecture: process.arch,
    passed: ["sandboxed preload", "authenticated owned host", "shared scoped RPC schemas", "proposal-only creation intake",
      "canonical business and agent persistence across desktop restart", "unavailable computer panel", "owned process shutdown", "zero renderer errors"],
    runtimeExecutionTested: false, computerVerificationTested: false,
  };
  await writeFile(join(results, "desktop-smoke.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close();
  await rm(scratch, { recursive: true, force: true });
}
