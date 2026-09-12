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
  await expect(page.getByRole("button", { name: "New task", exact: true })).toBeEnabled({ timeout: 20000 });
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
  expect(status.checks.runtime.state).toBe("unavailable");
  expect(status.checks.storage.state).toBe("ready");
  const computer = await page.evaluate(() => window.rappWork.request({ method: "computer.inspect", params: {} }));
  expect(computer.verified).toBe(false);
  expect(computer.state).toBe("unavailable");
  const rejected = await page.evaluate(async () => {
    try { await window.rappWork.request({ method: "shell.execute", params: {} }); return false; } catch { return true; }
  });
  expect(rejected).toBe(true);
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await nav.getByRole("link", { name: "Agents", exact: true }).click();
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Agent name").fill("Local smoke analyst");
  await page.getByRole("dialog").getByLabel("Agent instructions").fill("No production execution; validate local configuration persistence only.");
  await page.getByRole("dialog").getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await nav.getByRole("link", { name: "Work", exact: true }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByRole("dialog").getByLabel("Task title").fill("Validate a local work record");
  await page.getByRole("dialog").getByLabel("Instructions and expected outcome").fill("Store the task without claiming execution or verification.");
  await page.getByRole("dialog").getByLabel("Assign to", { exact: true }).selectOption({ label: "Local smoke analyst" });
  await page.getByRole("dialog").getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "Start task", exact: true })).toBeDisabled();
  await nav.getByRole("link", { name: "Settings", exact: true }).click();
  await page.getByLabel("Workspace name").fill("Local persistence check");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Workspace preferences saved.")).toBeVisible();
  await nav.getByRole("link", { name: "Work", exact: true }).click();
  await page.screenshot({ path: join(results, "desktop-work.png") });
  const path = join(profile, "workspaces", "local.json");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const persisted = JSON.parse(await readFile(path, "utf8"));
  expect(persisted.snapshot.tasks).toHaveLength(1);
  expect(persisted.snapshot.agents).toHaveLength(1);
  await quitAndCheck();
  page = await launch();
  await expect(page.getByRole("heading", { name: "Validate a local work record", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Configure Local smoke analyst" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start task", exact: true })).toBeDisabled();
  await quitAndCheck();
  expect(errors).toEqual([]);
  const report = {
    product: "RAPP Work", platform: process.platform, architecture: process.arch,
    passed: ["sandboxed preload", "authenticated owned host", "strict method allowlist", "real local persistence across desktop restart", "unavailable execution and computer reported honestly", "owned process shutdown", "zero renderer errors"],
    runtimeExecutionTested: false, computerVerificationTested: false,
  };
  await writeFile(join(results, "desktop-smoke.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await application?.close();
  await rm(scratch, { recursive: true, force: true });
}
