import type { Page } from "@playwright/test";
import { createTestHost, populatedClient, testHostState } from "../test/fixture";
import type { SpeechRecognizer, SpeechResultEvent } from "../src/useDictation";

export async function installFixture(page: Page, options: { empty?: boolean; populated?: boolean; multi?: boolean; speech?: boolean } = {}) {
  const names = options.empty ? [] : options.multi ? ["Finance studio", "Retail studio"] : ["Finance studio"];
  const seed = options.populated ? populatedClient(names).host.state : testHostState(names);
  await page.addInitScript(createTestHost, { seed, install: true });
  await page.addInitScript(({ speech }) => {
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined });
    if (!speech) return;
    class TestSpeech implements SpeechRecognizer {
      lang = ""; continuous = false; interimResults = true;
      onstart: (() => void) | null = null; onresult: ((event: SpeechResultEvent) => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null; onend: (() => void) | null = null;
      start() { window.__speech = this; this.onstart?.(); }
      stop() { this.onend?.(); }
      abort() { window.__speechAborts = (window.__speechAborts ?? 0) + 1; }
    }
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: TestSpeech });
  }, { speech: options.speech ?? false });
}
declare global {
  interface Window { __speech?: SpeechRecognizer; __speechAborts?: number; __releaseTwin?: () => void }
}
export async function say(page: Page, message: string) {
  await page.getByRole("textbox", { name: "Message your Work Twin" }).fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
export async function chooseWorkspace(page: Page, name: string) {
  const toggle = page.getByRole("button", { name: "Toggle workspaces" });
  if (await toggle.isVisible() && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.getByRole("button", { name: `Open workspace ${name}`, exact: true }).click();
  await page.getByRole("heading", { name: `${name} Twin`, level: 1 }).waitFor();
}
export async function inspect(page: Page, area: "Tasks" | "Agents" | "Routines" | "Settings") {
  await page.getByRole("navigation", { name: "Workspace tools" }).getByRole("button", { name: area, exact: true }).click();
  return page.getByRole("dialog").last();
}
