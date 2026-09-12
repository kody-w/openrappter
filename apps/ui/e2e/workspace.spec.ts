import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installFixture, navigate, propose } from "./fixture";
import { inventoryVisibilityInstructions } from "../../../tests/fixtures/instruction-documents";

test("production cold load has no model/computer fallback or blank creation forms", async ({ page }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect your local workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send intent" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start agent computer" })).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(requests.every((url) => url.startsWith("http://127.0.0.1:43819/"))).toBe(true);
});

test("conversation, complete review, work execution and settings survive reload without initial forms", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixture(page); await page.goto("/");
  await navigate(page, "Agents");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await propose(page, "Create a procurement reviewer who retains evidence.");
  await expect(page.getByRole("dialog").getByLabel("Agent name")).toHaveValue("Procurement reviewer");
  await page.getByRole("button", { name: "Approve draft", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (const text of ["Review supplier renewal", "Review invoice exceptions"]) {
    await navigate(page, "Work");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await propose(page, text);
    await expect(page.getByLabel("Task title", { exact: true })).toHaveValue(text);
    await page.getByRole("button", { name: "Approve draft" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    await page.getByRole("tab", { name: "Runs", exact: true }).click();
    await page.getByRole("button", { name: "Cancel run", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel run", exact: true }).click();
    await page.getByRole("tab", { name: /^Tasks/ }).click();
  }
  await navigate(page, "Settings");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Discuss settings", exact: true }).click();
  await propose(page, "Use a dark compact procurement workspace.");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  await page.getByRole("button", { name: "Approve draft" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Open Procurement operations", exact: true })).toBeVisible();
  await expect(page.getByText(/Owner: Procurement reviewer/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("a full pasted instruction block remains verbatim and already populated at review", async ({ page }) => {
  await installFixture(page); await page.goto("/");
  await expect(page.getByLabel("Your intent or full instruction document")).toBeEnabled();
  await page.evaluate((text) => {
    const field = document.getElementById("twin-message")!;
    const data = new DataTransfer(); data.setData("text/plain", text);
    field.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, inventoryVisibilityInstructions);
  await page.getByRole("button", { name: "Send intent" }).click();
  await page.getByRole("button", { name: "Review complete draft" }).click();
  await expect(page.getByLabel("Agent name", { exact: true })).toHaveValue("Inventory Visibility Agent");
  expect(await page.getByLabel("Preserved instruction document").textContent()).toBe(inventoryVisibilityInstructions);
  expect(await page.evaluate(() => (window as any).__testRequests.find((call: any) => call.method === "twin.message").params.message)).toBe(inventoryVisibilityInstructions);
  await page.getByRole("button", { name: "Approve draft" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the persistent computer panel starts through scoped RPCs and never carries enablement across a workspace switch", async ({ page }) => {
  await installFixture(page, true); await page.goto("/");
  const computer = page.getByRole("complementary", { name: "Agent computer panel" });
  await expect(computer.getByRole("button", { name: "Start agent computer" })).toBeEnabled();
  await computer.getByRole("button", { name: "Start agent computer" }).click();
  await expect(computer.getByText("Enabled for fresh scoped tool leases", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Borealis" }).click();
  await expect(computer.getByText("Scoped to Borealis", { exact: true })).toBeVisible();
  await expect(computer.getByText("Not enabled", { exact: true })).toBeVisible();
  await expect(computer.getByText("Screen unavailable", { exact: true })).toBeVisible();
  await computer.getByRole("button", { name: "Start agent computer" }).click();
  await expect(computer.getByText("Enabled for fresh scoped tool leases", { exact: true })).toBeVisible();
  const starts = await page.evaluate(() => (window as any).__testRequests.filter((call: any) => call.method === "computer.start").map((call: any) => call.params));
  expect(starts).toEqual([{ workspaceId: "test-workspace" }, { workspaceId: "second-workspace" }]);
});

test("human approvals, artifact text and keyboard review focus remain usable", async ({ page }) => {
  await installFixture(page, true); await page.goto("/");
  await page.getByRole("tab", { name: /^Approvals/ }).click();
  await page.getByRole("button", { name: "Review action" }).click();
  await expect(page.getByRole("dialog").getByLabel("Decision reason")).not.toHaveValue("");
  await page.getByRole("button", { name: "Deny action", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Artifacts & evidence" }).click();
  await page.getByRole("button", { name: "View artifact" }).click();
  await expect(page.getByLabel("Artifact content")).toContainText("Evidence from an injected test service");
  await page.getByRole("button", { name: "Close artifact" }).click();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await propose(page, "Review source evidence.");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Task title")).toBeFocused();
  await dialog.getByRole("button", { name: "Approve draft" }).focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review complete draft" })).toBeFocused();
});

test("agent workspaces recurse in one shell and internal evolution stays on the selected branch", async ({ page }) => {
  await installFixture(page); await page.goto("/");
  await navigate(page, "Agents");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await propose(page, "Create a procurement reviewer.");
  await page.getByRole("button", { name: "Approve draft" }).click();
  await expect(page.getByText(/Owner: Procurement reviewer/)).toBeVisible();
  await navigate(page, "Agents");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await propose(page, "Create a nested evidence reviewer.");
  await page.getByRole("button", { name: "Approve draft" }).click();
  await expect(page.getByText(/Owner: Nested reviewer/)).toBeVisible();
  await expect(page.getByText(/Depth 2/)).toBeVisible();
  await expect(page.locator('[data-layout="three-column-twin"]')).toHaveCount(1);
  await page.getByLabel("Your intent or full instruction document").fill("Please organize internally around evidence.");
  await page.getByRole("button", { name: "Send intent" }).click();
  await expect(page.getByText("Workspace evolved from this conversation", { exact: false })).toBeVisible();
  await expect(page.getByText("Conversation evidence section", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to parent" }).click();
  await expect(page.getByText(/Owner: Procurement reviewer/)).toBeVisible();
  await expect(page.getByText("Conversation evidence section", { exact: true })).toHaveCount(0);
  await navigate(page, "Agents");
  await page.getByRole("button", { name: "Open agent workspace" }).click();
  await expect(page.getByText("Conversation evidence section", { exact: true })).toBeVisible();
});

for (const width of [1360, 375]) for (const theme of ["light", "dark"]) {
  test(`${theme} ${width}px: complete three-column workspace with responsive accessible conversation and review`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await installFixture(page, true); await page.goto(`/?scoutTheme=${theme}`);
    for (const area of ["Work", "Agents", "Automations", "Settings"]) {
      await navigate(page, area);
      await expect(page.getByRole("button", { name: "Start agent computer" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      if (width === 1360) {
        const main = await page.locator("main").boundingBox();
        const computer = await page.getByRole("complementary", { name: "Agent computer panel" }).boundingBox();
        expect(computer!.x).toBeGreaterThanOrEqual(main!.x + main!.width - 1);
      }
      const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(accessibility.violations.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => node.target) }))).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${area.toLowerCase()}-${theme}-${width}.png`), fullPage: true });
    }
    await navigate(page, "Work");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await propose(page, "Review a source record.");
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(accessibility.violations.map((item) => item.id)).toEqual([]);
    expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
}
