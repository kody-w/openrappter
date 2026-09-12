import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installFixture, navigate } from "./fixture";

test("production cold load is honest, local, and free of page errors", async ({ page }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect your local workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
  expect(requests.every((url) => url.startsWith("http://127.0.0.1:43819/"))).toBe(true);
});
test("primary workflow runs twice, retains the roster, and persists typed preferences", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixture(page);
  await page.goto("/");
  await navigate(page, "Agents");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Agent name").fill("Procurement reviewer");
  await dialog.getByLabel("Agent instructions").fill("Review contracts and attach source evidence.");
  await dialog.getByLabel("Provider", { exact: true }).selectOption("test-provider");
  await dialog.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(dialog).toBeHidden();
  for (const title of ["Review supplier renewal", "Review invoice exceptions"]) {
    await navigate(page, "Work");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("Task title").fill(title);
    await dialog.getByLabel("Instructions and expected outcome").fill("Summarize the risks and cite supporting documents.");
    await dialog.getByLabel("Assign to", { exact: true }).selectOption({ label: "Procurement reviewer" });
    await dialog.getByRole("button", { name: "Create task", exact: true }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Start task", exact: true }).click();
    await expect(page.getByText("Run accepted by the connected runtime.")).toBeVisible();
    await page.getByRole("tab", { name: "Runs", exact: true }).click();
    await page.getByRole("button", { name: "Cancel run", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel run", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await page.getByRole("tab", { name: /^Tasks/ }).click();
  }
  await navigate(page, "Settings");
  await page.getByLabel("Workspace name").fill("Procurement operations");
  await page.getByLabel("Theme", { exact: true }).selectOption("dark");
  await page.getByLabel("Density").selectOption("compact");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Workspace preferences saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Workspace name")).toHaveValue("Procurement operations");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("dark");
  await expect(page.getByRole("button", { name: "Configure Procurement reviewer" })).toBeVisible();
  await navigate(page, "Work");
  await expect(page.getByRole("list", { name: "Tasks", exact: true }).getByRole("button")).toHaveCount(2);
  expect(errors).toEqual([]);
});
test("approvals, artifacts, schedules, provider references, and diagnostics have usable controls", async ({ page }) => {
  await installFixture(page, true);
  await page.goto("/");
  await page.getByRole("tab", { name: /^Approvals/ }).click();
  await page.getByRole("button", { name: "Review action" }).click();
  await page.getByRole("dialog").getByLabel("Decision reason").fill("Approved recipient has been checked.");
  await page.getByRole("dialog").getByRole("button", { name: "Approve action" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "Artifacts & evidence" }).click();
  await page.getByRole("button", { name: "View artifact" }).click();
  await expect(page.getByLabel("Artifact content")).toContainText("Injected browser test evidence");
  await page.getByRole("button", { name: "Close artifact", exact: true }).click();
  await page.getByRole("tab", { name: "Local computer" }).click();
  await expect(page.getByText("Not verified", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start computer" })).toBeDisabled();
  await navigate(page, "Automations");
  await page.getByRole("button", { name: "New schedule" }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel("Schedule name").fill("Weekly finance review");
  await form.getByLabel("Task title", { exact: true }).fill("Review weekly exceptions");
  await form.getByLabel("Task instructions").fill("Review only the current week's input.");
  await form.getByLabel("Assigned agent").selectOption("test-agent");
  await form.getByLabel("Repeat").selectOption("weekly");
  await form.getByLabel("Time zone (IANA)").fill("America/New_York");
  await form.getByLabel("Day of week").selectOption("5");
  await form.getByRole("button", { name: "Save schedule" }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText("Not scheduled", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit schedule" }).click();
  await page.getByRole("dialog").getByLabel("Enable this schedule").check();
  await page.getByRole("dialog").getByRole("button", { name: "Save schedule" }).click();
  await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
  await navigate(page, "Settings");
  await page.getByRole("tab", { name: "Providers", exact: true }).click();
  await page.getByLabel("Secure connection reference").fill("connections/test-provider");
  await page.getByRole("button", { name: "Connect reference" }).click();
  await expect(page.getByText("Provider connection response received.")).toBeVisible();
  await page.getByRole("tab", { name: "Diagnostics", exact: true }).click();
  await page.getByRole("button", { name: "Refresh diagnostics" }).click();
  await expect(page.getByRole("heading", { name: "Storage", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy report" }).click();
  await expect(page.getByText(/Diagnostic report copied|Clipboard access was not available/)).toBeVisible();
});
test("keyboard dialog focus is contained and restored with Escape", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  const opener = page.getByRole("button", { name: "New task", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Task title")).toBeFocused();
  await dialog.getByRole("button", { name: "Create task", exact: true }).focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  const tasks = page.getByRole("tab", { name: /^Tasks/ });
  await tasks.focus(); await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Runs", exact: true })).toBeFocused();
});
for (const width of [1360, 375]) for (const theme of ["light", "dark"]) {
  test(`${theme} ${width}px: responsive layout and WCAG accessibility across the four areas`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await installFixture(page, true);
    await page.goto(`/?scoutTheme=${theme}`);
    for (const area of ["Work", "Agents", "Automations", "Settings"]) {
      await navigate(page, area);
      await expect(page.getByRole("heading", { name: area, exact: true, level: 1 })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(accessibility.violations.map((item) => ({
        id: item.id, impact: item.impact, nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
      }))).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${area.toLowerCase()}-${theme}-${width}.png`), fullPage: true });
    }
    await navigate(page, "Work");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const dialogA11y = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(dialogA11y.violations.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => node.target) }))).toEqual([]);
    expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  });
}
