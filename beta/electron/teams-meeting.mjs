import path from "node:path";
import { randomUUID } from "node:crypto";
import { TeamsSettings } from "./teams-settings.mjs";
import { TeamsConversation } from "./teams-conversation.mjs";
import { createTeamsPageControlSource } from "./teams-page-control.mjs";
import {
  decodeMeetingMedia,
  isMeetingNavigationAllowed,
  isTeamsPage,
  MAX_MEETING_AUDIO_BYTES,
  MAX_MEETING_IMAGE_BYTES,
  meetingMentionsIdentity,
  normalizeMeetingOptions,
  splitMeetingSpeech,
} from "./teams-meeting-policy.mjs";

function mediaSummary(value) {
  const result = {};
  for (const [key, item] of Object.entries(value || {}).slice(0, 40)) {
    if (key.length > 60) continue;
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) result[key] = item;
    else if (typeof item === "string" && item.length <= 120) result[key] = item;
  }
  return result;
}

export class TeamsMeeting {
  constructor({
    BrowserWindow,
    createBrowserSession,
    ipcMain,
    safeStorage,
    runtime,
    createMediaSource,
    createSpeech,
    home,
    preloadPath,
    onState = () => {},
    env = process.env,
  }) {
    this.BrowserWindow = BrowserWindow;
    this.createBrowserSession = createBrowserSession;
    this.ipcMain = ipcMain;
    this.runtime = runtime;
    this.createMediaSource = createMediaSource;
    this.createSpeech = createSpeech;
    this.home = path.resolve(home);
    this.preloadPath = preloadPath;
    this.onState = onState;
    this.env = env;
    this.settings = new TeamsSettings({ directory: path.join(this.home, "private"), safeStorage });
    this.options = null;
    this.window = null;
    this.browserSession = null;
    this.speech = null;
    this.conversation = null;
    this.abortController = null;
    this.generation = 0;
    this.timer = null;
    this.pollTask = null;
    this.audioTask = null;
    this.answerTask = null;
    this.speakingTask = null;
    this.lastFrame = null;
    this.lastReplyAt = 0;
    this.lastEmitAt = 0;
    this.seen = new Set();
    this.ownMessages = new Set();
    this.pending = [];
    this.stopping = null;
    this.ignoreEnvironmentMeeting = false;
    this.forgetOnStop = false;
    this.state = {
      phase: "idle",
      message: "Join a Teams meeting with isolated virtual media.",
      options: normalizeMeetingOptions(),
      speech: { phase: "unprepared" },
      brain: { phase: "unprepared" },
      media: {},
      receivedAudioSegments: 0,
      receivedVideoFrames: 0,
      replies: 0,
      speaking: false,
      lastTranscript: "",
      lastReply: "",
      error: null,
    };
    this.mediaListener = (event, packet) => {
      if (event.sender !== this.window?.webContents) return;
      const generation = this.generation;
      void this.handleMedia(event, packet).catch((error) => {
        if (generation === this.generation) this.reportError(error);
      });
    };
    ipcMain.on("beta:teams-media", this.mediaListener);
  }

  status() {
    return structuredClone(this.state);
  }

  emit(immediate = true) {
    if (!immediate && Date.now() - this.lastEmitAt < 1000) return;
    this.lastEmitAt = Date.now();
    this.onState(this.status());
  }

  reportError(error) {
    let message = String(error?.message || error);
    if (this.options?.url) message = message.split(this.options.url).join("[meeting invitation]");
    this.state.error = message.slice(0, 500);
    this.emit();
  }

  preferences() {
    const saved = this.settings.read();
    const defaults = normalizeMeetingOptions({
      identity: this.env.RAPP_TEAMS_IDENTITY || "RAPP",
      ...(this.env.RAPP_TEAMS_MEETING_URL && !this.ignoreEnvironmentMeeting
        ? { url: this.env.RAPP_TEAMS_MEETING_URL } : {}),
    });
    const preferences = { ...defaults, ...saved, ...this.options };
    if (!this.window) {
      preferences.speak = false;
      if (this.forgetOnStop) delete preferences.url;
    }
    return preferences;
  }

  forget() {
    this.settings.forget();
    this.ignoreEnvironmentMeeting = true;
    this.forgetOnStop = true;
    if (this.options) {
      this.options.remember = false;
      if (!this.window) delete this.options.url;
    }
    this.state.options.remember = false;
    this.state.message = this.window
      ? "Saved invitation removed. The current meeting remains connected."
      : "Saved invitation removed.";
    this.emit();
    return this.status();
  }

  async prepare(options, generation, signal) {
    this.state.phase = "preparing";
    this.state.message = "Preparing local speech and the existing Frontier connection.";
    this.state.error = null;
    this.emit();
    if (options.listen || options.speak) {
      this.speech = this.createSpeech({
        directory: this.env.RAPP_TEAMS_SPEECH_DIRECTORY || path.join(this.home, "speech"),
        env: this.env,
        onState: (value) => {
          if (this.generation !== generation) return;
          const changedPhase = this.state.speech?.phase !== value?.phase;
          this.state.speech = value;
          this.emit(changedPhase);
        },
      });
      const speech = this.speech;
      await speech.prepare({ signal });
      signal.throwIfAborted();
      this.state.speech = speech.status();
    }
    if (options.autonomous) {
      this.conversation = new TeamsConversation({
        runtime: this.runtime,
        identity: options.identity,
        onState: (value) => {
          if (this.generation !== generation) return;
          this.state.brain = value;
          this.emit();
        },
      });
      await this.conversation.prepare();
      signal.throwIfAborted();
      this.state.brain = { phase: "ready" };
    }
    signal.throwIfAborted();
  }

  async join(value = {}) {
    if (this.window || this.abortController || this.stopping) {
      throw new Error("Stop the current meeting before starting another.");
    }
    const options = normalizeMeetingOptions({ ...this.preferences(), ...value });
    if (!options.url) throw new Error("Paste a Teams meeting invitation first.");
    this.forgetOnStop = false;
    this.options = options;
    this.state.options = { ...options };
    delete this.state.options.url;
    if (!options.vision) this.lastFrame = null;
    if (!options.listen) this.state.lastTranscript = "";
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const generation = ++this.generation;
    this.startedAt = Date.now();
    this.seen.clear();
    this.ownMessages.clear();
    this.pending = [];
    this.lastFrame = null;
    this.lastReplyAt = 0;
    this.state.receivedAudioSegments = 0;
    this.state.receivedVideoFrames = 0;
    this.state.replies = 0;
    this.state.lastTranscript = "";
    this.state.lastReply = "";
    try {
      this.settings.write(options);
      await this.prepare(options, generation, signal);
      const partition = `rapp-teams-${randomUUID()}`;
      const browserSession = this.createBrowserSession(partition);
      this.browserSession = browserSession;
      // Only synthetic streams are exposed in this partition; native capture is never granted.
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.setDisplayMediaRequestHandler?.((_request, callback) => callback({}));
      const window = new this.BrowserWindow({
        show: !options.headless,
        width: 1280,
        height: 800,
        title: `Teams - ${options.identity} (AI participant)`,
        webPreferences: {
          partition,
          preload: this.preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          autoplayPolicy: "no-user-gesture-required",
          backgroundThrottling: false,
          spellcheck: false,
        },
      });
      this.window = window;
      window.webContents.setAudioMuted(true);
      this.state.phase = "opening";
      this.state.message = "Starting the private meeting renderer.";
      this.emit();
      // Document-start instrumentation needs an initialized, isolated renderer.
      await window.loadURL("about:blank");
      signal.throwIfAborted();
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        if (isMeetingNavigationAllowed(url)) return;
        event.preventDefault();
        this.reportError(new Error("Blocked navigation outside the meeting's Microsoft origins."));
      });
      window.on("closed", () => {
        if (this.window !== window) return;
        void this.stop().catch((error) => this.reportError(error));
      });
      const debuggerApi = window.webContents.debugger;
      debuggerApi.attach("1.3");
      await debuggerApi.sendCommand("Page.enable");
      await debuggerApi.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: this.createMediaSource({
          identity: options.identity,
          captureAudio: options.listen,
          captureVideo: options.vision,
        }),
      });
      await debuggerApi.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      signal.throwIfAborted();
      await window.loadURL(options.url);
      signal.throwIfAborted();
      this.state.phase = "opening";
      this.state.message = "Opening the Teams guest-join flow.";
      this.state.error = null;
      this.joinRequested = false;
      this.joinDeadline = Date.now() + 120000;
      this.emit();
      this.timer = setInterval(() => void this.poll(), 1200);
      this.timer.unref?.();
      await this.poll();
      return this.status();
    } catch (error) {
      if (generation === this.generation) {
        await this.stop();
        this.state.phase = "error";
        this.reportError(error);
      }
      throw error;
    }
  }

  async runPage(source, timeoutMs = 20000) {
    const window = this.window;
    if (!window || window.isDestroyed()) throw new Error("The meeting window is closed.");
    const signal = this.abortController?.signal;
    signal?.throwIfAborted();
    let timeout;
    let cancel;
    const cancelled = new Promise((_resolve, reject) => {
      cancel = () => reject(signal?.reason || new Error("The meeting window closed."));
      signal?.addEventListener("abort", cancel, { once: true });
      window.once("closed", cancel);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          signal?.throwIfAborted();
          if (window.isDestroyed()) throw new Error("The meeting window is closed.");
          return window.webContents.executeJavaScript(source, true);
        }),
        cancelled,
        new Promise((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("The meeting page did not answer in time.")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      window.removeListener("closed", cancel);
    }
  }

  async pageCommand(command) {
    return this.runPage(createTeamsPageControlSource(command));
  }

  async poll() {
    if (this.pollTask || !this.window || this.stopping) return;
    const task = {};
    this.pollTask = task;
    const generation = this.generation;
    try {
      const page = await this.pageCommand(this.joinRequested
        ? { action: "snapshot" }
        : {
            action: "advance",
            displayName: `${this.options.identity} - AI assistant`,
            camera: this.options.camera,
            speak: this.options.speak,
          });
      if (generation !== this.generation) return;
      if (page.action === "join-requested") this.joinRequested = true;
      this.state.media = mediaSummary(page.media);
      this.state.phase = page.stage;
      this.state.message = page.notice || ({
        joined: "Connected through browser-local virtual devices. Computer speakers remain muted.",
        lobby: "Waiting for someone in the meeting to admit this AI participant.",
        attention: "Teams needs human attention. Show the meeting window to continue.",
        joining: "Requesting admission to the meeting.",
        prejoin: "Configuring the synthetic camera and microphone.",
      }[page.stage] || "Loading the Teams meeting.");
      this.emit(false);
      if (page.stage === "ended") {
        await this.stop();
        this.state.message = "The Teams meeting has ended.";
        this.emit();
        return;
      }
      if (page.stage === "joined") {
        if (this.options.autonomous && !page.chatOpen) {
          await this.pageCommand({ action: "open-chat" });
          return;
        }
        this.receiveChat(page.messages || []);
        void this.answerNext();
      } else if (!["lobby", "attention"].includes(page.stage) && Date.now() > this.joinDeadline) {
        throw new Error("Teams did not reach its lobby or meeting within two minutes.");
      }
    } catch (error) {
      if (generation !== this.generation || this.stopping) return;
      if (this.window?.webContents.isLoadingMainFrame?.() && Date.now() < this.joinDeadline) return;
      clearInterval(this.timer);
      this.timer = null;
      this.state.phase = "attention";
      this.reportError(error);
    } finally {
      if (this.pollTask === task) this.pollTask = null;
    }
  }

  receiveChat(messages) {
    for (const message of messages) {
      if (!message?.id || typeof message.text !== "string" || this.seen.has(message.id)) continue;
      const at = Number(message.id);
      const own = this.ownMessages.has(message.id)
        || message.author === `${this.options.identity} - AI assistant`;
      this.seen.add(message.id);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
      if (own || (Number.isFinite(at) && at < this.startedAt)) continue;
      if (/\b(?:no audio|text[- ]only|please mute|stay silent)\b/i.test(message.text)) {
        void this.muteSpeech()
          .catch((error) => this.reportError(error));
        this.state.message = "Speech output is paused at a participant's request.";
        this.emit();
      }
      if (!this.options.autonomous) continue;
      const addressed = meetingMentionsIdentity(message.text, this.options.identity);
      const followUp = this.lastReplyAt && Date.now() - this.lastReplyAt < 120000
        && !/\br2(?:to)?\b/i.test(message.text);
      if (!addressed && !followUp) continue;
      if (this.pending.length >= 8) {
        this.options.autonomous = false;
        this.state.options.autonomous = false;
        this.reportError(new Error("Automatic replies paused because the meeting queue is full."));
        return;
      }
      this.pending.push({ key: `chat-${message.id}`, text: message.text, author: message.author, source: "chat" });
    }
  }

  async handleMedia(event, packet) {
    if (!this.window || this.stopping) return;
    if (event.sender !== this.window.webContents
        || event.senderFrame !== this.window.webContents.mainFrame
        || !isTeamsPage(event.senderFrame?.url)) {
      throw new Error("Rejected media from an unowned Teams frame.");
    }
    const generation = this.generation;
    const payload = packet?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("The virtual media packet is invalid.");
    }
    if (packet.type === "status") {
      this.state.media = mediaSummary(payload);
      this.emit(false);
      return;
    }
    if (packet.type === "error") throw new Error(String(payload.message || "Virtual media failed.").slice(0, 300));
    if (packet.type === "video") {
      if (!this.options.vision) return;
      const bytes = decodeMeetingMedia(payload.jpegBase64, MAX_MEETING_IMAGE_BYTES, "Meeting video");
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Meeting video must be JPEG.");
      this.lastFrame = { jpegBase64: payload.jpegBase64, at: Date.now() };
      this.state.receivedVideoFrames += 1;
      this.emit(false);
      return;
    }
    if (packet.type !== "audio") throw new Error("Unsupported virtual media packet.");
    if (!this.options.listen) return;
    if (payload.mimeType !== "audio/wav" || payload.sampleRate !== 16000
        || !Number.isFinite(payload.durationMs) || payload.durationMs <= 0 || payload.durationMs > 8000) {
      throw new Error("Incoming audio must be a bounded 16-kHz WAV segment.");
    }
    if (!this.speech) throw new Error("Local speech recognition has not been prepared.");
    if (this.audioTask) {
      await this.configure({ listen: false });
      throw new Error("Listening paused rather than dropping audio while recognition is busy.");
    }
    const wav = decodeMeetingMedia(payload.wavBase64, MAX_MEETING_AUDIO_BYTES, "Meeting audio");
    const task = {};
    this.audioTask = task;
    try {
      const result = await this.speech.transcribe(wav, { signal: this.abortController.signal });
      if (generation !== this.generation || !this.options.listen) return;
      if (typeof result?.text !== "string") throw new Error("Local recognition returned an invalid transcript.");
      this.state.receivedAudioSegments += 1;
      this.state.lastTranscript = result.text.slice(0, 2000);
      this.emit();
      if (result.text.trim() && this.options.autonomous
          && (meetingMentionsIdentity(result.text, this.options.identity)
            || (this.lastReplyAt && Date.now() - this.lastReplyAt < 120000))) {
        if (this.pending.length >= 8) throw new Error("The meeting response queue is full.");
        this.pending.push({ key: `speech-${randomUUID()}`, source: "speech", text: result.text, author: "" });
        void this.answerNext();
      }
    } finally {
      if (this.audioTask === task) this.audioTask = null;
    }
  }

  async answerNext() {
    if (this.answerTask || this.stopping || this.state.phase !== "joined"
        || !this.options?.autonomous || !this.pending.length) return;
    const question = this.pending.shift();
    const task = {};
    this.answerTask = task;
    const generation = this.generation;
    try {
      if (!this.conversation) throw new Error("The meeting assistant has not been prepared.");
      const frame = this.options.vision && this.lastFrame && Date.now() - this.lastFrame.at < 15000
        ? this.lastFrame : null;
      const reply = await this.conversation.respond({
        ...question,
        frame,
        signal: this.abortController.signal,
      });
      if (generation !== this.generation || !this.options.autonomous) return;
      if (reply.text === null) return;
      const text = `${reply.text} -- ${this.options.identity}`;
      await this.sendChat(text, question.key);
      this.conversation.commit(reply.input, reply.text);
      this.lastReplyAt = Date.now();
      this.state.lastReply = text;
      this.state.replies += 1;
      this.emit();
      if (this.options.speak) {
        try {
          await this.speak(reply.text);
        } catch (error) {
          if (generation !== this.generation || this.stopping) return;
          this.options.speak = false;
          this.state.options.speak = false;
          this.reportError(new Error(`The reply is in chat, but speech stopped: ${error.message}`));
        }
      }
    } catch (error) {
      if (generation === this.generation && !this.stopping) {
        this.options.autonomous = false;
        this.state.options.autonomous = false;
        this.reportError(error);
      }
    } finally {
      if (this.answerTask === task) this.answerTask = null;
    }
  }

  async sendChat(text, key = `operator-${randomUUID()}`) {
    if (this.state.phase !== "joined") throw new Error("Join the meeting before sending a message.");
    await this.pageCommand({ action: "open-chat" });
    const result = await this.pageCommand({ action: "send-chat", text, key });
    if (result.status !== "sent" || !result.messageId) throw new Error("Meeting chat delivery is unconfirmed.");
    this.ownMessages.add(result.messageId);
    return result;
  }

  async configure(value) {
    if (!this.options || !this.window) throw new Error("There is no active meeting to configure.");
    const previous = this.options;
    const options = normalizeMeetingOptions({ ...previous, ...value });
    if (options.url !== previous.url || options.identity !== previous.identity) {
      throw new Error("Stop the meeting before changing its link or identity.");
    }
    if ((options.listen || options.speak) && !this.speech) {
      throw new Error("Local speech must be prepared before enabling audio.");
    }
    if (options.autonomous && !this.conversation) {
      throw new Error("The meeting conversation must be prepared before enabling automatic replies.");
    }
    if (!options.speak) await this.muteSpeech();
    await this.runPage(`window.__rappTeamsMedia.setCaptureEnabled(${JSON.stringify({
      audio: options.listen, video: options.vision,
    })})`);
    if (this.state.phase === "joined") {
      await this.pageCommand({ action: "set-controls", camera: options.camera, speak: options.speak });
    }
    this.options = options;
    this.state.options = { ...options };
    delete this.state.options.url;
    this.emit();
    return this.status();
  }

  async muteSpeech() {
    if (!this.options) return;
    this.options.speak = false;
    this.state.options.speak = false;
    try {
      if (this.window) await this.runPage("window.__rappTeamsMedia.stopSpeaking()");
    } catch (error) {
      await this.stop();
      throw new Error("Disconnected because virtual speech could not be confirmed muted.", { cause: error });
    }
    this.emit();
  }

  async speak(text) {
    if (this.state.phase !== "joined" || !this.options.speak) {
      throw new Error("Speech output is muted. Enable it explicitly when the meeting permits audio.");
    }
    if (!this.speech) throw new Error("Local speech has not been prepared.");
    if (this.speakingTask) throw new Error("The virtual microphone is already speaking.");
    const chunks = splitMeetingSpeech(text);
    const task = {};
    this.speakingTask = task;
    this.state.speaking = true;
    this.emit();
    const generation = this.generation;
    const signal = this.abortController.signal;
    let completedChunks = 0;
    try {
      for (const chunk of chunks) {
        signal.throwIfAborted();
        if (!this.options.speak) return { stopped: true, completedChunks };
        const audio = await this.speech.synthesize(chunk, { signal });
        if (generation !== this.generation) throw new Error("Speech output was stopped.");
        if (!this.options.speak) return { stopped: true, completedChunks };
        if (!Buffer.isBuffer(audio?.wav) || audio.mimeType !== "audio/wav" || audio.wav.length > 2 * 1024 * 1024) {
          throw new Error("Local synthesis returned invalid or oversized WAV audio.");
        }
        await this.pageCommand({ action: "set-controls", camera: this.options.camera, speak: true });
        const result = await this.runPage(`window.__rappTeamsMedia.playAudio(${JSON.stringify({
          base64: audio.wav.toString("base64"), mimeType: "audio/wav",
        })})`, 35000);
        if (result?.stopped === true || result?.cancelled === true || !this.options.speak) {
          return { stopped: true, completedChunks, interruptedClip: true };
        }
        completedChunks += 1;
      }
      return { injectedIntoVirtualMicrophone: true, stopped: false, completedChunks };
    } catch (error) {
      if (generation === this.generation && !this.options.speak && !signal.aborted) {
        return { stopped: true, completedChunks, interruptedClip: true };
      }
      throw error;
    } finally {
      if (this.speakingTask === task) {
        this.speakingTask = null;
        this.state.speaking = false;
        this.emit();
      }
    }
  }

  show() {
    if (!this.window || this.window.isDestroyed()) throw new Error("There is no meeting window.");
    this.window.show();
    this.window.focus();
    return this.status();
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.generation += 1;
    this.abortController?.abort(new Error("The meeting was stopped."));
    this.abortController = null;
    clearInterval(this.timer);
    this.timer = null;
    const window = this.window;
    const browserSession = this.browserSession;
    const speech = this.speech;
    const conversation = this.conversation;
    this.window = null;
    this.browserSession = null;
    this.speech = null;
    this.conversation = null;
    this.lastFrame = null;
    this.pending = [];
    this.pollTask = null;
    this.audioTask = null;
    this.answerTask = null;
    this.speakingTask = null;
    this.state.speaking = false;
    this.lastReplyAt = 0;
    if (this.options) this.options.speak = false;
    if (this.options && this.forgetOnStop) delete this.options.url;
    this.state.options.speak = false;
    if (window && !window.isDestroyed()) window.destroy();
    this.stopping = (async () => {
      const results = await Promise.allSettled([
        speech?.close(),
        conversation?.close(),
        browserSession?.clearStorageData(),
      ]);
      this.state.phase = "idle";
      this.state.message = "Disconnected from Teams. Virtual media is stopped.";
      this.state.lastTranscript = "";
      this.state.lastReply = "";
      this.state.media = {};
      this.state.speech = { phase: "stopped" };
      this.state.brain = { phase: "stopped" };
      this.emit();
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "Meeting cleanup did not complete.");
    })();
    try {
      await this.stopping;
    } finally {
      this.stopping = null;
    }
    return this.status();
  }

  async dispose() {
    this.ipcMain.removeListener("beta:teams-media", this.mediaListener);
    await this.stop();
  }
}
