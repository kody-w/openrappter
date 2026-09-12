import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { chooseWorkspace, inspect, installFixture, say } from "./fixture";

test("production cold load is honest, local, and free of page errors", async ({ page }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Connect to your local host" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
  expect(requests.every((url) => url.startsWith("http://127.0.0.1:43819/"))).toBe(true);
});

test("natural-language workspace creation is reviewed, scoped, and durable across reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installFixture(page, { empty: true });
  await page.goto("/");
  await page.getByRole("button", { name: "New workspace", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toBeFocused();
  await say(page, "Create a workspace for finance operations with an invoice reviewer.");
  const proposal = page.getByRole("article", { name: "Workspace proposal" });
  await expect(proposal).toBeVisible();
  expect(await page.evaluate(() => window.__testHost!.state.catalog.workspaces.length)).toBe(0);
  await proposal.getByRole("button", { name: "Review details" }).click();
  const review = page.getByRole("dialog", { name: "Review workspace proposal" });
  await expect(review.getByLabel("Workspace name")).toHaveValue("Finance studio");
  await expect(review.getByLabel("Twin instructions")).not.toHaveValue("");
  await expect(review.getByText(/Drafted by your Work Twin/)).toBeVisible();
  await review.getByRole("button", { name: "Approve & create workspace" }).click();
  await expect(page.getByRole("heading", { name: "Finance studio Twin", level: 1 })).toBeVisible();
  const saved = await page.evaluate(() => window.__testHost!.state.catalog.workspaces[0]!);
  expect(saved.id).not.toBe(saved.leadAgentId);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Finance studio Twin", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /Concierge Twin/ }).click();
  await expect(page.getByRole("article", { name: "Workspace proposal" }).getByText("Applied", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("task, agent, routine, and settings proposals apply directly or with small prefilled edits", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await say(page, "Create an agent responsible for supplier invoice reviews.");
  await page.getByRole("article", { name: "Agent proposal" }).getByRole("button", { name: "Approve & create agent" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Agent proposal" }).getByText("Applied", { exact: true })).toBeVisible();
  await say(page, "Review supplier invoices tomorrow.");
  await page.getByRole("article", { name: "Task proposal" }).getByRole("button", { name: "Review details" }).click();
  let review = page.getByRole("dialog");
  await expect(review.getByLabel("Task title")).toHaveValue("Review supplier invoices");
  await expect(review.getByLabel("Instructions and expected outcome")).not.toHaveValue("");
  await review.getByLabel("Task title").fill("Review September supplier invoices");
  await review.getByLabel("Priority").selectOption("high");
  await review.getByRole("button", { name: "Approve & create task" }).click();
  await expect(review).toBeHidden();
  await say(page, "Create a daily routine to review invoice exceptions at 9am.");
  await page.getByRole("article", { name: "Routine proposal" }).getByRole("button", { name: "Review details" }).click();
  review = page.getByRole("dialog");
  await expect(review.getByLabel("Routine name")).toHaveValue("Morning finance review");
  await expect(review.getByLabel("Time zone (IANA)")).toHaveValue("America/New_York");
  await review.getByRole("button", { name: "Approve & create routine" }).click();
  await expect(review).toBeHidden();
  await say(page, "Change this workspace's settings to a compact dark theme.");
  await page.getByRole("article", { name: "Settings proposal" }).getByRole("button", { name: "Review details" }).click();
  review = page.getByRole("dialog");
  await expect(review.getByLabel("Theme")).toHaveValue("dark");
  await expect(review.getByLabel("Density")).toHaveValue("compact");
  await expect(review.getByLabel("New approval requests")).toBeChecked();
  await review.getByRole("button", { name: "Approve & apply settings" }).click();
  await expect(review).toBeHidden();
  await page.reload();
  const saved = await page.evaluate(() => window.__testHost!.state.workspaces.finance!);
  expect(saved.agents).toHaveLength(2);
  expect(saved.tasks[0]).toMatchObject({ title: "Review September supplier invoices", state: "queued", priority: "high" });
  expect(saved.runs).toHaveLength(0);
  expect(saved.automations[0]).toMatchObject({ enabled: false, nextRunAt: null });
  expect(saved.settings.appearance).toEqual({ theme: "dark", density: "compact" });
  await expect(page.getByRole("article").filter({ hasText: "Applied" })).toHaveCount(4);
});

test("follow-up questions lead to complete drafts and dismissal persists without creating anything", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await say(page, "Help me plan something useful.");
  await expect(page.getByText("What outcome should the task produce?")).toBeVisible();
  await expect(page.getByRole("button", { name: "Review details" })).toHaveCount(0);
  await page.getByRole("button", { name: "Reply to Twin" }).click();
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toBeFocused();
  await say(page, "Review supplier invoices tomorrow.");
  const proposal = page.getByRole("article", { name: "Task proposal" });
  await proposal.getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(proposal.getByText("Dismissed", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__testHost!.state.workspaces.finance!.tasks.length)).toBe(0);
  await page.reload();
  await expect(page.getByRole("article", { name: "Task proposal" }).getByText("Dismissed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & create task" })).toHaveCount(0);
});

test("all create controls route into the composer, while saved record reviews are prefilled", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  for (const name of ["New task", "New agent", "New routine"]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toBeFocused();
  }
  for (const [area, action] of [["Tasks", "New task with Twin"], ["Agents", "New agent with Twin"], ["Routines", "New routine with Twin"]] as const) {
    const panel = await inspect(page, area);
    await expect(panel.locator("form").filter({ has: page.getByLabel(/Task title|Agent name|Routine name/) })).toHaveCount(0);
    await panel.getByRole("button", { name: action, exact: true }).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toBeFocused();
  }
  let panel = await inspect(page, "Settings");
  await expect(panel.getByLabel("Workspace name")).toHaveCount(0);
  await panel.getByRole("button", { name: "Change settings with Twin" }).click();
  await expect(panel).toBeHidden();
  panel = await inspect(page, "Settings");
  await panel.getByRole("button", { name: "Review saved settings" }).click();
  const review = page.getByRole("dialog", { name: "Review saved settings" });
  await expect(review.getByLabel("Workspace name")).toHaveValue("Finance studio");
  await expect(review.getByLabel("Theme")).toHaveValue("system");
  await review.getByLabel("Theme").selectOption("light");
  await review.getByRole("button", { name: "Save settings" }).click();
  await expect(review).toBeHidden();
  expect(await page.evaluate(() => window.__testHost!.state.workspaces.finance!.settings.appearance.theme)).toBe("light");
});

test("voice recognition appends only final text to the composer and waits for Send", async ({ page }) => {
  await installFixture(page, { speech: true });
  await page.goto("/");
  await page.getByRole("textbox", { name: "Message your Work Twin" }).fill("Please");
  await page.getByRole("button", { name: "Start voice dictation" }).click();
  await expect(page.getByText(/Listening… Speak now/)).toBeVisible();
  await page.evaluate(() => window.__speech!.onresult!({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, 0: { transcript: "review supplier" } } } }));
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("Please");
  await page.evaluate(() => {
    window.__speech!.onresult!({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, 0: { transcript: "review supplier invoices" } } } });
    window.__speech!.onend!();
  });
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("Please review supplier invoices");
  expect(await page.evaluate(() => window.__testHost!.calls.some((call) => call.method === "twin.message"))).toBe(false);
  await expect(page.getByText(/Transcript added/)).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("article", { name: "Task proposal" })).toBeVisible();
});

test("unavailable speech and denied microphone access always leave a text fallback", async ({ page }) => {
  await installFixture(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Start voice dictation" })).toBeDisabled();
  await expect(page.getByText("Voice dictation is unavailable here. Type your message instead.")).toBeVisible();
  await say(page, "Review supplier invoices.");
  await expect(page.getByRole("article", { name: "Task proposal" })).toBeVisible();
});
test("a recognition error never becomes a fabricated transcript or background recording", async ({ page }) => {
  await installFixture(page, { speech: true, multi: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Start voice dictation" }).click();
  await page.evaluate(() => window.__speech!.onerror!({ error: "not-allowed" }));
  await expect(page.getByRole("alert")).toContainText("Microphone permission was denied");
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("");
  await page.getByRole("button", { name: "Start voice dictation" }).click();
  await chooseWorkspace(page, "Retail studio");
  expect(await page.evaluate(() => window.__speechAborts)).toBe(2);
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("");
});

test("workspace switching isolates unsent text, prefilled review edits, events and late responses", async ({ page }) => {
  await installFixture(page, { multi: true });
  await page.goto("/");
  await say(page, "Private finance invoice review.");
  await page.getByRole("button", { name: "Review details" }).click();
  await page.getByRole("dialog").getByLabel("Task title").fill("Uncommitted finance edit");
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Message your Work Twin" }).fill("Unsent private finance text");
  await chooseWorkspace(page, "Retail studio");
  await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("");
  await expect(page.getByRole("log")).not.toContainText("Private finance");
  await chooseWorkspace(page, "Finance studio");
  await page.getByRole("button", { name: "Review details" }).click();
  await expect(page.getByRole("dialog").getByLabel("Task title")).toHaveValue("Review supplier invoices");
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const request = window.rappWork!.request;
    window.rappWork!.request = async (input) => {
      if (input.method === "twin.message") await new Promise<void>((resolve) => { window.__releaseTwin = resolve; });
      return request(input);
    };
  });
  await say(page, "A late private finance request.");
  await expect(page.getByRole("button", { name: "Working…" })).toBeVisible();
  await chooseWorkspace(page, "Retail studio");
  await page.evaluate(() => window.__releaseTwin!());
  await expect.poll(() => page.evaluate(() => window.__testHost!.state.conversations.finance!.turns.length)).toBe(4);
  await expect(page.getByRole("log")).not.toContainText("late private finance");
  await expect(page.getByRole("article", { name: "Task proposal" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [...window.__testHost!.subscriptions.values()])).toEqual(["business-2", "business-2", "business-2", "business-2"]);
});

for (const decision of ["Approve action", "Deny action"]) test(`${decision} is an explicit human choice, never a Twin side effect`, async ({ page }) => {
  await installFixture(page, { populated: true });
  await page.goto("/");
  await say(page, "Review the pending approval and recommend whether to approve or deny.");
  await page.getByRole("button", { name: "Review decision" }).click();
  const dialog = page.getByRole("dialog", { name: "Your approval decision" });
  await expect(dialog.getByLabel("Decision reason")).toHaveValue("Confirm the reviewer and the financial data scope before sending.");
  await dialog.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await page.evaluate(() => window.__testHost!.calls.some((call) => ["approvals.decide", "twin.applyProposal"].includes(call.method)))).toBe(false);
  await dialog.getByRole("button", { name: decision, exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.__testHost!.state.workspaces.finance!.approvals[0]!.state)).toBe(decision === "Approve action" ? "approved" : "denied");
});

test("keyboard review focus is contained and restored, and artifacts remain inert text", async ({ page }) => {
  await installFixture(page, { populated: true });
  await page.goto("/");
  await say(page, "Review supplier invoices.");
  const opener = page.getByRole("button", { name: "Review details" });
  await opener.click();
  const review = page.getByRole("dialog");
  await expect(review.getByLabel("Task title")).toBeFocused();
  await review.getByRole("button", { name: "Approve & create task" }).focus();
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("dialog"))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(review).toBeHidden(); await expect(opener).toBeFocused();
  const panel = await inspect(page, "Tasks");
  await panel.getByRole("tab", { name: "Artifacts & evidence" }).click();
  await page.evaluate(() => { window.__testHost!.content = '<script>alert("untrusted")</script>'; });
  await panel.getByRole("button", { name: "View artifact" }).click();
  await expect(page.getByLabel("Artifact content")).toContainText('<script>alert("untrusted")</script>');
  await expect(page.getByLabel("Artifact content").locator("script")).toHaveCount(0);
});

for (const width of [1360, 375]) for (const theme of ["light", "dark"]) {
  test(`${theme} ${width}px: conversation, inspectors and prefilled reviews meet WCAG and fit the viewport`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
    await installFixture(page, { populated: true, multi: true });
    await page.goto(`/?scoutTheme=${theme}`);
    await say(page, "Review supplier invoices.");
    await expect(page.getByRole("article", { name: "Task proposal" })).toBeVisible();
    const audit = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
      expect(results.violations.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })) }))).toEqual([]);
    };
    await audit();
    await page.screenshot({ path: testInfo.outputPath(`conversation-${theme}-${width}.png`), fullPage: true });
    for (const area of ["Tasks", "Agents", "Routines", "Settings"] as const) {
      const panel = await inspect(page, area);
      await audit();
      await page.screenshot({ path: testInfo.outputPath(`${area.toLowerCase()}-${theme}-${width}.png`), fullPage: true });
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
    }
    await page.getByRole("button", { name: "Review details" }).click();
    await audit();
    const dialog = page.getByRole("dialog");
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.keyboard.press("Escape");
    if (width === 375) {
      await page.getByRole("button", { name: "Toggle workspaces" }).click();
      await audit();
      await page.getByRole("button", { name: "Toggle workspaces" }).click();
      await page.getByRole("button", { name: "Toggle workspace status" }).click();
      await expect(page.getByRole("complementary", { name: "Workspace status" })).toBeInViewport();
      await audit();
      await page.getByRole("button", { name: "Return to Twin conversation" }).click();
      await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toBeFocused();
      await expect(page.getByRole("textbox", { name: "Message your Work Twin" })).toBeInViewport();
    } else {
      const left = await page.getByRole("complementary", { name: "Workspaces" }).boundingBox();
      const center = await page.getByRole("main").boundingBox();
      const right = await page.getByRole("complementary", { name: "Workspace status" }).boundingBox();
      expect(left!.x + left!.width).toBeLessThanOrEqual(center!.x + 1);
      expect(center!.x + center!.width).toBeLessThanOrEqual(right!.x + 1);
    }
    expect(errors).toEqual([]);
  });
}
