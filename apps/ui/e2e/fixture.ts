import type { Page } from "@playwright/test";
import { populatedClient, testStatus, testWorkspace, timestamp } from "../test/fixture";
import type { Snapshot } from "../src/model";

export async function installFixture(page: Page, populated = false) {
  const seed = populated ? populatedClient().workspace : testWorkspace();
  await page.addInitScript(({ seed, status, timestamp }) => {
    const storageKey = "rapp-work-browser-test-only";
    let snapshot: Snapshot = JSON.parse(localStorage.getItem(storageKey) ?? JSON.stringify(seed));
    const save = () => { snapshot.revision++; localStorage.setItem(storageKey, JSON.stringify(snapshot)); };
    const requests: { method: string; params: unknown }[] = [];
    Object.defineProperty(window, "__testRequests", { value: requests });
    window.rappWork = {
      async hostState() { return { state: "online", detail: "Injected browser test host." }; },
      onEvent() { return () => {}; },
      async request({ method, params }) {
        requests.push({ method, params });
        const input = params as Record<string, any>;
        const now = new Date().toISOString();
        switch (method) {
          case "work.snapshot": return structuredClone(snapshot);
          case "system.status": return status;
          case "providers.list": return [{ id: "test-provider", name: "Injected provider", configured: true,
            availability: "ready", authentication: "authenticated", models: ["test-model"], detail: "Browser test adapter." }];
          case "computer.inspect": return { state: "unavailable", verified: false, verifiedAt: null, evidenceIds: [], capabilities: { view: false, control: false }, detail: "No computer is connected. This test does not exercise a virtual machine." };
          case "diagnostics.get": return { capturedAt: timestamp, entries: [] };
          case "events.subscribe": return { subscriptionId: crypto.randomUUID(), events: [], cursor: "test-only-cursor" };
          case "events.unsubscribe": return { removed: true };
          case "agents.save": {
            const agent = { ...input, workspaceId: snapshot.agents.find((agent) => agent.id === input.id)?.workspaceId ?? crypto.randomUUID(), updatedAt: now } as Snapshot["agents"][number];
            const existing = snapshot.agents.findIndex((item) => item.id === agent.id);
            if (existing >= 0) snapshot.agents[existing] = agent; else snapshot.agents.push(agent);
            save(); return agent;
          }
          case "work.createTask": {
            const { requestId, ...fields } = input;
            const task = { ...fields, workspaceId: snapshot.agents.find((agent) => agent.id === fields.agentId)?.workspaceId ?? null,
              id: requestId, state: "queued", createdAt: now, updatedAt: now } as Snapshot["tasks"][number];
            if (!snapshot.tasks.some((item) => item.id === task.id)) snapshot.tasks.unshift(task);
            save(); return task;
          }
          case "work.assignTask": {
            const task = snapshot.tasks.find((item) => item.id === input.id)!;
            task.agentId = input.agentId; task.workspaceId = snapshot.agents.find((agent) => agent.id === input.agentId)!.workspaceId; save(); return task;
          }
          case "runs.start": {
            const task = snapshot.tasks.find((item) => item.id === input.id)!;
            const run = { id: crypto.randomUUID(), taskId: task.id, agentId: task.agentId!, workspaceId: task.workspaceId!,
              state: "running" as const, startedAt: now, finishedAt: null, summary: "Accepted by browser test adapter.", verification: "not_checked" as const, evidenceIds: [] };
            task.state = "running"; snapshot.runs.unshift(run); save(); return run;
          }
          case "runs.cancel": {
            const run = snapshot.runs.find((item) => item.id === input.id)!;
            run.state = "cancelled"; run.finishedAt = now;
            snapshot.tasks.find((item) => item.id === run.taskId)!.state = "cancelled"; save(); return run;
          }
          case "approvals.decide": {
            const approval = snapshot.approvals.find((item) => item.id === input.id)!;
            approval.state = input.decision; approval.decisionReason = input.reason; approval.decidedAt = now; save(); return approval;
          }
          case "artifacts.read": return { artifact: snapshot.artifacts.find((item) => item.id === input.id), content: '{"source":"Injected browser test evidence","result":"Review required"}' };
          case "automations.save": {
            const automation = { ...input, workspaceId: snapshot.agents.find((agent) => agent.id === input.agentId)!.workspaceId,
              updatedAt: now, nextRunAt: input.enabled ? now : null } as Snapshot["automations"][number];
            const index = snapshot.automations.findIndex((item) => item.id === automation.id);
            if (index >= 0) snapshot.automations[index] = automation; else snapshot.automations.push(automation);
            save(); return automation;
          }
          case "settings.update": snapshot.settings = input as Snapshot["settings"]; save(); return snapshot.settings;
          case "providers.configure": return { id: input.id, name: "Injected provider", configured: true,
            availability: "ready", authentication: "authenticated", models: ["test-model"], detail: "Browser test adapter." };
          default: throw new Error(`Unsupported browser test method: ${method}`);
        }
      },
    };
  }, { seed, status: testStatus(true), timestamp });
}
export async function navigate(page: Page, area: string) {
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: area, exact: true }).click();
  await page.getByRole("heading", { name: area, exact: true, level: 1 }).waitFor();
}
