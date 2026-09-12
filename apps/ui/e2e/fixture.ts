import type { Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

let fixtureBundle: Promise<string> | undefined;
async function browserFixture() {
  fixtureBundle ??= (async () => {
    const result = await build({
      configFile: false, logLevel: "silent",
      build: { write: false, emptyOutDir: false, minify: false,
        lib: { entry: fileURLToPath(new URL("../test/fixture.ts", import.meta.url)), name: "RappWorkTestFixture", formats: ["iife"] } },
    });
    for (const output of Array.isArray(result) ? result : [result]) {
      if (!("output" in output)) continue;
      const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
      if (entry?.type === "chunk") return `${entry.code}\nwindow.RappWorkTestFixture = RappWorkTestFixture;`;
    }
    throw new Error("Browser fixture bundle is missing.");
  })();
  return fixtureBundle;
}
export async function installFixture(page: Page, populated = false) {
  await page.addInitScript({ content: await browserFixture() });
  await page.addInitScript(({ populated }) => {
    const storageKey = "rapp-work-conversation-browser-test-only";
    const requests: { method: string; params: unknown }[] = [];
    const subscribers = new Map<string, string>();
    const listeners = new Set<(event: unknown) => void>();
    Object.defineProperty(window, "__testRequests", { value: requests });
    let loading: Promise<any> | undefined;
    const get = () => loading ??= (async () => {
      const fixtures = (window as any).RappWorkTestFixture;
      const client = populated ? fixtures.populatedClient() : new fixtures.FixtureClient();
      client.status = fixtures.testStatus(true); client.machineState = "stopped";
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const saved = JSON.parse(stored);
        client.workspaces = new Map(saved.workspaces); client.conversations = new Map(saved.conversations);
        client.metadata = new Map(saved.metadata);
        client.workspace = client.workspaces.values().next().value;
        client.machineState = saved.machineState; client.enabled = new Set(saved.enabled);
      } else client.addWorkspace("second-workspace", "Borealis");
      client.propose = (request: any) => {
        client.evolution = null;
        const workspace = client.workspaces.get(request.workspaceId);
        const baseAgent = { id: crypto.randomUUID(), name: request.message.includes("nested") ? "Nested reviewer" : "Procurement reviewer", role: "Procurement",
          instructions: request.message, providerId: "github-copilot", model: "gpt-6-astra",
          computerPolicy: "none", approvalPolicy: "always", enabled: true, suggestedRoutines: [] };
        if (request.target === "workspace") {
          const { suggestedRoutines: _routines, ...leadAgent } = baseAgent;
          return fixtures.draftFor("workspace", { requestId: crypto.randomUUID(), name: "Consulting workspace",
            purpose: request.message, twin: { name: "Consulting Twin", instructions: "Draft complete business work for review." },
            leadAgent, starterTask: null, starterRoutines: [], approvalPolicy: "always", computerPolicy: "none" }, null);
        }
        if (request.target === "agent" || request.message.startsWith("# Inventory")) {
          const document = request.message.startsWith("# Inventory");
          const proposal = fixtures.draftFor("agent", {
            ...baseAgent, name: document ? "Inventory Visibility Agent" : baseAgent.name,
            enabled: !document,
          }, request.workspaceId);
          if (document) proposal.basis.instructionDocument = { turnId: crypto.randomUUID(), contentHash: "c".repeat(64) };
          return proposal;
        }
        if (request.message.includes("organize internally")) {
          client.evolution = { twinSummary: "Organized internal evidence.", sections: [{
            id: "evidence-notes", title: "Conversation evidence section", kind: "notes", description: "Only this selected workspace.", taskIds: [],
          }], suggestedRoutines: [], defaultFocus: "conversation" };
          const basis = fixtures.draftFor("task", { requestId: crypto.randomUUID(), title: "Review", instructions: "Review.",
            agentId: workspace.agents[0]?.id ?? null, priority: "normal" }, request.workspaceId);
          return { ...basis, kind: "clarification", readyForReview: false, missing: ["source"], draft: null,
            assistantMessage: "The workspace is organized. Which source should I review?" };
        }
        if (request.target === "automation") return fixtures.draftFor("automation", {
          id: crypto.randomUUID(), name: "Weekly finance review", taskTitle: "Review weekly exceptions",
          instructions: request.message, agentId: workspace.agents[0].id,
          cadence: { kind: "weekly", at: "09:00", weekday: 5, timezone: "America/New_York" }, enabled: false,
        }, request.workspaceId);
        if (request.target === "settings") return fixtures.draftFor("settings", {
          workspaceName: "Procurement operations", appearance: { theme: "dark", density: "compact" },
        }, request.workspaceId);
        return fixtures.draftFor("task", { requestId: crypto.randomUUID(), title: request.message,
          instructions: "Summarize material risks and retain evidence.", agentId: workspace.agents[0]?.id ?? null,
          priority: "normal" }, request.workspaceId);
      };
      const notify = () => {
        for (const [subscriptionId] of subscribers) for (const listener of listeners) listener({
          type: "events", subscriptionId, events: [{ id: crypto.randomUUID(), area: "work", entityId: "computer",
            kind: "updated", at: new Date().toISOString() }], cursor: "test-only-cursor",
        });
      };
      client.listeners.add(notify);
      return client;
    })().catch((error) => { (window as any).__fixtureError = String(error?.stack ?? error); throw error; });
    window.rappWork = {
      async hostState() { await get(); return { state: "online", detail: "Explicitly injected browser test host." }; },
      onEvent(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
      async request({ method, params }) {
        requests.push({ method, params });
        const input = params as Record<string, any>;
        if (method === "events.subscribe") {
          const subscriptionId = crypto.randomUUID(); subscribers.set(subscriptionId, input.workspaceId);
          return { subscriptionId, events: [], cursor: "test-only-cursor" };
        }
        if (method === "events.unsubscribe") return { removed: subscribers.delete(input.subscriptionId) };
        const client = await get();
        const result = await client.call(method, params);
        localStorage.setItem(storageKey, JSON.stringify({
          workspaces: [...client.workspaces], conversations: [...client.conversations],
          metadata: [...client.metadata],
          machineState: client.machineState, enabled: [...client.enabled],
        }));
        return result;
      },
    };
  }, { populated });
}
export async function navigate(page: Page, area: string) {
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.getByRole("navigation", { name: "Primary navigation" }).getByRole("link", { name: area, exact: true }).click();
  await page.getByRole("heading", { name: area, exact: true, level: 1 }).waitFor();
}
export async function propose(page: Page, text: string) {
  await page.getByLabel("Your intent or full instruction document").fill(text);
  await page.getByRole("button", { name: "Send intent", exact: true }).click();
  await page.getByRole("button", { name: "Review complete draft", exact: true }).last().click();
}
