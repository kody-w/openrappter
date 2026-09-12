import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { SpeechRecognizer, SpeechResultEvent } from "../src/useDictation";
import { FixtureClient, testHostState } from "./fixture";

class TestSpeech implements SpeechRecognizer {
  static instances: TestSpeech[] = [];
  lang = ""; continuous = true; interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((event: SpeechResultEvent) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn();
  constructor() { TestSpeech.instances.push(this); }
  result(text: string, isFinal: boolean) { this.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal, 0: { transcript: text } } } }); }
}
async function open(supported = true) {
  if (supported) window.webkitSpeechRecognition = TestSpeech;
  const client = new FixtureClient(testHostState(["Finance studio", "Retail studio"]));
  render(<App client={client} />);
  await screen.findByRole("heading", { name: "Finance studio Twin", level: 1 });
  await waitFor(() => expect(screen.getByRole("button", { name: "New task" })).toBeEnabled());
  return { user: userEvent.setup(), client };
}
beforeEach(() => { TestSpeech.instances = []; });
describe("foreground, user-started voice dictation", () => {
  it("shows listening, interim and final transcript states without sending automatically", async () => {
    const { user, client } = await open();
    const composer = screen.getByRole("textbox", { name: "Message your Work Twin" });
    expect(TestSpeech.instances).toHaveLength(0);
    await user.type(composer, "Please");
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    expect(await screen.findByText(/Listening… Speak now/)).toBeVisible();
    const speech = TestSpeech.instances[0]!;
    expect(speech.continuous).toBe(false); expect(speech.interimResults).toBe(true);
    act(() => speech.result("review supplier", false));
    expect(screen.getByText(/Hearing: review supplier \(not final\)/)).toBeVisible();
    expect(composer).toHaveValue("Please");
    act(() => { speech.result("review supplier invoices", true); speech.result("review supplier invoices", true); speech.onend?.(); });
    expect(composer).toHaveValue("Please review supplier invoices");
    expect(screen.getByText(/Transcript added: review supplier invoices/)).toBeVisible();
    expect(client.calls.some((call) => call.method === "twin.message")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("article", { name: "Task proposal" })).toBeVisible();
  });
  it("offers an honest unavailable speech state and a working text fallback", async () => {
    const { user } = await open(false);
    expect(screen.getByRole("button", { name: "Start voice dictation" })).toBeDisabled();
    expect(screen.getByText("Voice dictation is unavailable here. Type your message instead.")).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Message your Work Twin" }), "Review supplier invoices.");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("article", { name: "Task proposal" })).toBeVisible();
  });
  it("does not claim a transcript when permission or the speech service fails", async () => {
    const { user, client } = await open();
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    const speech = TestSpeech.instances[0]!;
    act(() => speech.onerror?.({ error: "not-allowed" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Microphone permission was denied");
    expect(screen.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Start voice dictation" })).toHaveAttribute("aria-pressed", "false");
    expect(speech.abort).toHaveBeenCalledOnce();
    expect(client.calls.some((call) => call.method === "twin.message")).toBe(false);
  });
  it("stops and ignores late transcripts on workspace switches", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    const speech = TestSpeech.instances[0]!, late = speech.onresult!;
    await user.click(screen.getByRole("button", { name: "Open workspace Retail studio" }));
    await screen.findByRole("heading", { name: "Retail studio Twin", level: 1 });
    expect(speech.abort).toHaveBeenCalledOnce();
    act(() => late({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, 0: { transcript: "Private finance recording" } } } }));
    expect(screen.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("");
    expect(screen.queryByText(/Private finance recording/)).not.toBeInTheDocument();
  });
  it("cancels on blur, disconnection, and inspector opening, without background restart", async () => {
    const { user, client } = await open();
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    fireEvent(window, new Event("blur"));
    expect(TestSpeech.instances[0]!.abort).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    await user.click(screen.getByRole("button", { name: "Workspace settings" }));
    expect(TestSpeech.instances[1]!.abort).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Close workspace settings" }));
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    act(() => client.host.connection({ state: "offline", detail: "Host exited." }));
    await waitFor(() => expect(TestSpeech.instances[2]!.abort).toHaveBeenCalledOnce());
    expect(TestSpeech.instances).toHaveLength(3);
  });
  it("can be stopped explicitly and reports an empty recognition honestly", async () => {
    const { user } = await open();
    await user.click(screen.getByRole("button", { name: "Start voice dictation" }));
    await user.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(TestSpeech.instances[0]!.stop).toHaveBeenCalledOnce();
    expect(screen.getByText(/No transcript was received/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message your Work Twin" })).toHaveValue("");
  });
});
