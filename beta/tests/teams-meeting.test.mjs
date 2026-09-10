import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TeamsMeeting } from "../electron/teams-meeting.mjs";

function fixture(t, { prepare, transcribe, synthesize, loadError, pageStage = "joined", pageNotice } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "rapp-teams-controller-"));
  const events = [];
  const windows = [];
  const sessions = [];
  const speeches = [];
  const ipcMain = new EventEmitter();
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: "https://teams.microsoft.com/v2/" };
      this.webContents.getUserAgent = () => "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) OpenRappter/0.1 Chrome/150.0.0.0 Electron/43.2.0 Safari/537.36";
      this.webContents.setUserAgent = (value) => { this.userAgent = value; };
      this.webContents.setAudioMuted = (value) => { this.audioMuted = value; };
      this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
      this.webContents.isLoadingMainFrame = () => false;
      this.webContents.executeJavaScript = async () => ({
        stage: pageStage, notice: pageNotice, chatOpen: true, messages: [], media: { synthetic: true },
      });
      this.webContents.debugger = {
        attach: (version) => events.push(["attach", version]),
        sendCommand: async (name, payload) => events.push([name, payload]),
      };
      windows.push(this);
    }
    async loadURL(url) {
      events.push(["loadURL", url]);
      if (loadError && url !== "about:blank") throw new Error(`Could not load ${url}`);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
    show() { this.shown = true; }
    focus() { this.focused = true; }
  }
  const manager = new TeamsMeeting({
    BrowserWindow: FakeWindow,
    createBrowserSession: (partition) => {
      const session = {
        partition,
        setPermissionRequestHandler(handler) { this.request = handler; },
        setPermissionCheckHandler(handler) { this.check = handler; },
        setDisplayMediaRequestHandler(handler) { this.display = handler; },
        async clearStorageData() { this.cleared = true; },
      };
      sessions.push(session);
      return session;
    },
    ipcMain,
    safeStorage: { isEncryptionAvailable: () => false },
    runtime: { start: async () => ({ authenticated: true }) },
    createMediaSource: (settings) => {
      events.push(["media-options", settings]);
      return "test-virtual-media-installation";
    },
    createSpeech: () => {
      const index = speeches.length;
      const speech = {
        prepare: async () => prepare?.(index),
        status: () => ({ phase: "ready", ready: true }),
        transcribe: async (...args) => transcribe ? transcribe(...args) : { text: "r1, hello" },
        synthesize: async (...args) => {
          if (synthesize) return synthesize(...args);
          throw new Error("Synthesis must not run while muted.");
        },
        close: async () => { speech.closed = true; },
      };
      speeches.push(speech);
      return speech;
    },
    home,
    preloadPath: "/fixture/teams-media-preload.cjs",
    env: {},
  });
  t.after(async () => {
    await manager.dispose();
    rmSync(home, { recursive: true, force: true });
  });
  return { manager, windows, sessions, events, ipcMain, speeches };
}

const options = {
  url: "https://teams.microsoft.com/meet/123?p=not-a-real-passcode",
  identity: "r1",
  autonomous: false,
};

test("joining owns a nonpersistent, sandboxed window and never grants native capture", async (t) => {
  const { manager, windows, sessions, events } = fixture(t);
  await manager.join(options);
  assert.equal(manager.status().phase, "joined");
  assert.equal(windows.length, 1);
  const window = windows[0];
  assert.equal(window.options.show, false);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.autoplayPolicy, "no-user-gesture-required");
  assert.ok(window.options.webPreferences.partition.startsWith("rapp-teams-"));
  assert.equal(window.audioMuted, true);
  assert.match(window.userAgent, /Chrome\/150\.0\.0\.0/);
  assert.doesNotMatch(window.userAgent, /Electron|OpenRappter/);
  assert.deepEqual(window.openHandler({ url: "https://example.com" }), { action: "deny" });
  let granted;
  sessions[0].request({}, "media", (value) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(sessions[0].check({}, "media"), false);
  let display;
  sessions[0].display({}, (value) => { display = value; });
  assert.deepEqual(display, {});
  const installed = events.findIndex(([name]) => name === "Page.addScriptToEvaluateOnNewDocument");
  const loaded = events.findIndex(([name, url]) => name === "loadURL" && url.startsWith("https://"));
  assert.ok(installed >= 0 && installed < loaded);
  assert.deepEqual(events.find(([name]) => name === "media-options")[1], {
    identity: "r1", captureAudio: false, captureVideo: false,
  });
  assert.equal(JSON.stringify(manager.status()).includes("not-a-real-passcode"), false);
  await assert.rejects(manager.join(options), /Stop the current meeting/);
  await assert.rejects(manager.speak("Do not broadcast this."), /muted/);
});

test("only the owned Teams main frame may supply media", async (t) => {
  const { manager, windows } = fixture(t);
  await manager.join(options);
  const contents = windows[0].webContents;
  const packet = { type: "status", payload: { incomingAudioLevel: 0.2 } };
  await assert.rejects(manager.handleMedia({ sender: {}, senderFrame: contents.mainFrame }, packet), /unowned/);
  await assert.rejects(manager.handleMedia({
    sender: contents, senderFrame: { url: "https://evil.example/" },
  }, packet), /unowned/);
  await manager.handleMedia({ sender: contents, senderFrame: contents.mainFrame }, packet);
  assert.equal(manager.status().media.incomingAudioLevel, 0.2);
});

test("stopping a preparation cannot close a later meeting", async (t) => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { manager, windows } = fixture(t, {
    prepare: (index) => index === 0 ? blocked : undefined,
  });
  const first = manager.join(options);
  const firstFailure = assert.rejects(first, /stopped/);
  await manager.stop();
  await manager.join(options);
  release();
  await firstFailure;
  assert.equal(manager.status().phase, "joined");
  assert.equal(windows.length, 1);
  assert.equal(windows[0].destroyed, false);
});

test("late recognition cannot surface after stopping the call", async (t) => {
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const { manager, windows } = fixture(t, { transcribe: () => delayed });
  await manager.join(options);
  const contents = windows[0].webContents;
  const incoming = manager.handleMedia(
    { sender: contents, senderFrame: contents.mainFrame },
    { type: "audio", payload: {
      wavBase64: Buffer.from("fixture wav").toString("base64"),
      mimeType: "audio/wav", sampleRate: 16000, durationMs: 1000,
    } },
  );
  await manager.stop();
  release({ text: "This belongs to the previous meeting." });
  await incoming;
  assert.equal(manager.status().lastTranscript, "");
  assert.equal(manager.status().phase, "idle");
});

test("cleanup clears only the meeting partition and private input buffers", async (t) => {
  const { manager, windows, sessions, speeches } = fixture(t);
  await manager.join(options);
  await manager.stop();
  assert.equal(windows[0].destroyed, true);
  assert.equal(sessions[0].cleared, true);
  assert.equal(speeches[0].closed, true);
  assert.equal(manager.status().speech.phase, "stopped");
  assert.equal(manager.status().options.speak, false);
});

test("load failures do not expose invitation passcodes in public status", async (t) => {
  const { manager } = fixture(t, { loadError: true });
  await assert.rejects(manager.join(options), /Could not load/);
  assert.equal(manager.status().phase, "error");
  assert.equal(manager.status().error.includes("not-a-real-passcode"), false);
  assert.match(manager.status().error, /\[meeting invitation\]/);
});

test("stopping rejects pending page work without waiting for its normal timeout", async (t) => {
  const { manager, windows } = fixture(t);
  await manager.join(options);
  windows[0].webContents.executeJavaScript = () => new Promise(() => {});
  const pending = manager.runPage("pending operation", 10000);
  const rejected = assert.rejects(pending, /stopped|closed/);
  await manager.stop();
  await Promise.race([
    rejected,
    new Promise((_resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Page work did not cancel within one second.")), 1000);
      timeout.unref?.();
    }),
  ]);
});

test("forgetting the invitation leaves the active call intact but prevents a later automatic rejoin", async (t) => {
  const { manager, windows } = fixture(t);
  manager.env.RAPP_TEAMS_MEETING_URL = options.url;
  await manager.join(options);
  manager.forget();
  assert.equal(manager.status().phase, "joined");
  assert.equal(windows[0].destroyed, false);
  assert.equal(manager.status().options.remember, false);
  await manager.stop();
  assert.equal(manager.preferences().url, undefined);
});

test("mute is committed before a playing clip rejects with AbortError", async (t) => {
  const { manager, windows } = fixture(t, {
    synthesize: async () => ({ wav: Buffer.alloc(44), mimeType: "audio/wav" }),
  });
  await manager.join({ ...options, speak: true });
  let rejectPlayback;
  windows[0].webContents.executeJavaScript = async (source) => {
    if (source.startsWith("window.__rappTeamsMedia.playAudio(")) {
      return new Promise((_resolve, reject) => { rejectPlayback = reject; });
    }
    if (source === "window.__rappTeamsMedia.stopSpeaking()") {
      rejectPlayback?.(Object.assign(new Error("Playback stopped"), { name: "AbortError" }));
      return { stopped: true };
    }
    return { stage: "joined", media: {} };
  };
  const speaking = manager.speak("A short reply.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof rejectPlayback, "function");
  await manager.configure({ speak: false });
  const result = await speaking;
  assert.equal(result.stopped, true);
  assert.equal(result.completedChunks, 0);
  assert.equal(manager.status().speaking, false);
  assert.equal(manager.status().phase, "joined");
});

test("incoming media is not consumed while waiting for admission", async (t) => {
  let transcriptions = 0;
  const { manager, windows } = fixture(t, {
    pageStage: "lobby",
    transcribe: async () => { transcriptions += 1; return { text: "not admitted" }; },
  });
  await manager.join(options);
  const contents = windows[0].webContents;
  await manager.handleMedia(
    { sender: contents, senderFrame: contents.mainFrame },
    { type: "audio", payload: {
      wavBase64: Buffer.from("fixture wav").toString("base64"),
      mimeType: "audio/wav", sampleRate: 16000, durationMs: 1000,
    } },
  );
  assert.equal(manager.status().phase, "lobby");
  assert.equal(manager.captureStarted, false);
  assert.equal(transcriptions, 0);
});

test("audio and automatic replies can be prepared explicitly after a manual join", async (t) => {
  const { manager, speeches } = fixture(t);
  await manager.join({ ...options, listen: false, speak: false });
  assert.equal(speeches.length, 0);
  assert.equal(manager.conversation, null);
  await manager.configure({ listen: true });
  assert.equal(speeches.length, 1);
  assert.equal(manager.status().phase, "joined");
  await manager.configure({ autonomous: true });
  assert.ok(manager.conversation);
  assert.equal(speeches.length, 1, "enabling replies must not replace the prepared speech service");
  assert.equal(manager.status().options.autonomous, true);
});

test("an unanswered admission request closes only this session and preserves the actual notice", async (t) => {
  const notice = "Sorry, no one has responded to your request to join. Please try again.";
  const { manager, windows } = fixture(t, { pageStage: "ended", pageNotice: notice });
  await manager.join(options);
  assert.equal(manager.status().phase, "idle");
  assert.equal(manager.status().message, notice);
  assert.equal(windows[0].destroyed, true);
});
