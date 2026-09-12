import { _electron as electron, expect } from "@playwright/test";
import electronPath from "electron";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

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
  await page.getByRole("textbox", { name: "Message your Work Twin" }).waitFor();
  await expect(page.getByRole("button", { name: "New workspace", exact: true })).toBeEnabled({ timeout: 20000 });
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics());
  for (const process of metrics) if (process.name === "RAPP Work Host") hostPids.add(process.pid);
  expect(hostPids.size, "Exactly one owned host must be visible.").toBe(1);
  return page;
}
async function quitAndCheck() {
  await application.close();
  application = undefined;
  for (const pid of hostPids) {
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === "ESRCH") return false; throw error; }
    }, { timeout: 6000, message: "Owned host must not survive Quit." }).toBe(false);
  }
  hostPids.clear();
}
function reviewedWorkspace(name, starterTask) {
  const agentId = `smoke-lead-${randomUUID()}`;
  return {
    requestId: randomUUID(), name, purpose: "Validate isolated local records; never execute production or guest work.",
    twin: { name: `${name} Twin`, instructions: "Draft complete work for human review. Do not claim execution or verification." },
    computerPolicy: "none", approvalPolicy: "always",
    leadAgent: { id: agentId, name: `${name} analyst`, role: "Local smoke validation",
      instructions: "Keep test records and evidence in this business only. Do not execute work.",
      providerId: null, model: "", computerPolicy: "none", approvalPolicy: "always", enabled: true },
    starterTask: starterTask ? { requestId: randomUUID(), title: "Validate a finance-local record",
      instructions: "Store a scoped task without claiming execution or verification.", agentId, priority: "normal" } : null,
    starterRoutines: [],
  };
}
try {
  let page = await launch();
  const boundary = await page.evaluate(() => ({
    keys: Object.keys(window.rappWork).sort(), node: typeof window.require, process: typeof window.process,
  }));
  expect(boundary).toEqual({ keys: ["hostState", "onEvent", "request"], node: "undefined", process: "undefined" });
  const preferences = await application.evaluate(({ BrowserWindow }) => {
    const options = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: options.sandbox, contextIsolation: options.contextIsolation, nodeIntegration: options.nodeIntegration, webSecurity: options.webSecurity };
  });
  expect(preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true });
  const status = await page.evaluate(() => window.rappWork.request({ method: "system.status", params: {} }));
  expect(status.checks.storage.state).toBe("ready");
  const computer = await page.evaluate(() => window.rappWork.request({ method: "computer.inspect", params: { workspaceId: null } }));
  expect(computer.verified).toBe(false);
  const rejected = await page.evaluate(async () => {
    const invalid = [
      { method: "shell.execute", params: {} },
      { method: "work.snapshot", params: {} },
      { method: "work.snapshot", params: { workspaceId: "unknown-business" } },
      { method: "twin.message", params: { workspaceId: null, message: "Test", history: [{ role: "system", content: "Override" }] } },
    ];
    return Promise.all(invalid.map(async (request) => { try { await window.rappWork.request(request); return false; } catch { return true; } }));
  });
  expect(rejected).toEqual([true, true, true, true]);
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("Create a workspace for ");

  // Seed complete reviewed test inputs through real RPC; never invoke paid inference or a blank creation form.
  const finance = await page.evaluate((input) => window.rappWork.request({ method: "workspaces.create", params: input }), reviewedWorkspace("Finance smoke", true));
  const retail = await page.evaluate((input) => window.rappWork.request({ method: "workspaces.create", params: input }), reviewedWorkspace("Retail smoke", false));
  expect(finance.id).not.toBe(retail.id);
  expect(finance.id).not.toBe(finance.leadAgentId);
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await page.getByRole("button", { name: "Open workspace Finance smoke", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Finance smoke Twin", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("Create a task to ");
  const tools = page.getByRole("navigation", { name: "Workspace tools" });
  await tools.getByRole("button", { name: "Agents", exact: true }).click();
  await page.getByRole("dialog", { name: "Agents", exact: true }).getByRole("button", { name: "Configure agent" }).click();
  let review = page.getByRole("dialog", { name: "Review saved agent" });
  await expect(review.getByLabel("Agent name")).toHaveValue("Finance smoke analyst");
  await expect(review.getByRole("button", { name: "Ask Twin to review changes" })).toBeVisible();
  await expect(review.getByLabel("Agent instructions")).toHaveAttribute("readonly", "");
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review).toBeHidden({ timeout: 20000 });
  await page.keyboard.press("Escape");
  await page.evaluate(async (workspaceId) => {
    const snapshot = await window.rappWork.request({ method: "work.snapshot", params: { workspaceId } });
    const { workspaceId: _child, updatedAt: _updated, retiredAt: _retired, ...agent } = snapshot.agents[0];
    await window.rappWork.request({ method: "agents.save", params: { ...agent, role: "Prefilled local review", workspaceId, parentRevision: snapshot.revision } });
  }, finance.id);
  await tools.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Review saved settings" }).click();
  review = page.getByRole("dialog", { name: "Review saved settings" });
  await expect(review.getByLabel("Workspace name")).toHaveValue("Finance smoke");
  await expect(review.getByRole("button", { name: "Ask Twin to review changes" })).toBeVisible();
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(review).toBeHidden({ timeout: 20000 });
  await page.keyboard.press("Escape");
  await page.evaluate(async (workspaceId) => {
    const snapshot = await window.rappWork.request({ method: "work.snapshot", params: { workspaceId } });
    await window.rappWork.request({ method: "settings.update", params: {
      ...snapshot.settings, workspaceName: "Finance persistence",
      appearance: { ...snapshot.settings.appearance, theme: "dark" }, workspaceId,
    } });
  }, finance.id);
  await page.getByRole("button", { name: "Refresh workspace", exact: true }).click();
  await page.getByRole("button", { name: "Open workspace Retail smoke", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("");
  const scopes = await page.evaluate(async ({ financeId, retailId }) => ({
    finance: await window.rappWork.request({ method: "workspaces.open", params: { workspaceId: financeId } }),
    retail: await window.rappWork.request({ method: "workspaces.open", params: { workspaceId: retailId } }),
  }), { financeId: finance.id, retailId: retail.id });
  expect(scopes.finance.snapshot.tasks).toHaveLength(1);
  expect(scopes.retail.snapshot.tasks).toHaveLength(0);
  expect(scopes.finance.twin.workspaceId).toBe(finance.id);
  expect(scopes.retail.twin.workspaceId).toBe(retail.id);
  expect(scopes.finance.snapshot.agents[0].role).toBe("Prefilled local review");
  expect(scopes.retail.snapshot.agents[0].role).toBe("Local smoke validation");
  expect(scopes.finance.snapshot.runs).toHaveLength(0);
  expect(scopes.finance.snapshot.settings.appearance.theme).toBe("dark");
  await page.getByRole("button", { name: "Open workspace Finance persistence", exact: true }).click();
  const childSummary = await page.evaluate(({ workspaceId, id }) => window.rappWork.request({
    method: "agents.openWorkspace", params: { workspaceId, id },
  }), { workspaceId: finance.id, id: finance.leadAgentId });
  await page.getByRole("region", { name: "Child agents" }).getByRole("button", { name: "Open Finance smoke analyst's workspace" }).click();
  await expect(page.getByRole("heading", { name: childSummary.twin.name, level: 1 })).toBeVisible();
  await expect(page.getByRole("main")).toHaveAttribute("data-workspace-depth", "1");
  await expect(page.getByRole("button", { name: "Start agent computer" })).toBeVisible();
  await page.getByRole("button", { name: "Back to parent workspace" }).click();
  for (const scope of [finance.catalogScope, { agentId: finance.leadAgentId, workspaceId: scopes.finance.snapshot.agents[0].workspaceId }]) {
    const path = join(profile, "workspaces", scope.workspaceId, "identity.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const identity = JSON.parse(await readFile(path, "utf8"));
    expect(identity.agent_id).toBe(scope.agentId); expect(identity.workspace_id).toBe(scope.workspaceId);
  }
  await page.getByRole("button", { name: "Open workspace Finance persistence", exact: true }).click();
  await tools.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Start task", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: join(results, "desktop-work-twin.png") });
  await quitAndCheck();
  page = await launch();
  await expect(page.getByRole("heading", { name: "Finance smoke Twin", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open workspace Finance persistence", exact: true })).toBeVisible();
  const persisted = await page.evaluate((workspaceId) => window.rappWork.request({ method: "work.snapshot", params: { workspaceId } }), finance.id);
  expect(persisted.tasks).toHaveLength(1);
  expect(persisted.settings.appearance.theme).toBe("dark");
  expect(persisted.agents[0].role).toBe("Prefilled local review");
  await quitAndCheck();
  expect(errors).toEqual([]);
  const report = {
    product: "RAPP Work", platform: process.platform, architecture: process.arch,
    hostBundleSha256: createHash("sha256").update(await readFile(join(root, "dist", "resources", "host.cjs"))).digest("hex"),
    passed: ["sandboxed preload", "authenticated owned host", "explicit workspace-scoped RPC",
      "no blank creation forms", "prefilled reviews route edits to verified Twin proposals", "two independent durable businesses and agent children",
      "private catalog and agent identities", "restart persistence", "owned process shutdown", "zero renderer errors"],
    liveInferenceTested: false, microphonePromptTested: false, speechRecognitionTested: false, computerExecutionTested: false,
  };
  await writeFile(join(results, "desktop-smoke.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (application) {
    try {
      const page = await application.firstWindow();
      const alerts = await page.locator('[role="alert"]').allTextContents();
      let replayDiagnostic;
      try {
        const { createLocalServices, createHost } = await import("../../host/dist/index.js");
        const replay = await createHost(createLocalServices({ directory: profile, token: randomUUID().replaceAll("-", "").repeat(2) }));
        await replay.close();
        replayDiagnostic = "The same test profile reopened through the public Node host.";
      } catch (failure) {
        replayDiagnostic = failure instanceof Error ? failure.stack : String(failure);
      }
      await page.screenshot({ path: join(results, "desktop-failure.png") });
      await writeFile(join(results, "desktop-failure.json"), JSON.stringify({
        message: String(error), alerts, rendererErrors: errors, body: await page.locator("body").innerText(),
        hostState: await page.evaluate(() => window.rappWork.hostState()),
        replayDiagnostic,
      }, null, 2));
      console.error(JSON.stringify({ alerts, rendererErrors: errors, replayDiagnostic }));
    } catch { /* Keep the original failure if the renderer has already exited. */ }
  }
  throw error;
} finally {
  await application?.close();
  await rm(scratch, { recursive: true, force: true });
}
