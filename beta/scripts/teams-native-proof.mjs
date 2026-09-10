import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TeamsMeeting } from "../electron/teams-meeting.mjs";
import { TeamsConversation } from "../electron/teams-conversation.mjs";
import { CopilotRuntime } from "../electron/copilot-runtime.mjs";
import { createMeetingSpeech } from "../electron/teams-local-speech.mjs";
import { createTeamsVirtualMediaSource } from "../electron/teams-virtual-media.mjs";
import { installProcessOutputRedaction } from "../electron/log-redaction.mjs";

const require = createRequire(import.meta.url);
const self = fileURLToPath(import.meta.url);
const beta = path.resolve(path.dirname(self), "..");
const redaction = installProcessOutputRedaction();
const fixtureUrl = "https://teams.microsoft.com/meet/123?p=local-fixture-only";
const phrase = "The virtual audio bridge is ready.";

function fixtureDocument(challenge) {
  window.__proof = { outgoingRms: 0, ready: false, error: null };
  const html = (value) => { document.body.innerHTML = value; };
  const fail = (error) => { window.__proof.error = String(error.message || error); };
  async function connect(sender, receiver) {
    async function local(peer, description) {
      await peer.setLocalDescription(description);
      if (peer.iceGatheringState !== "complete") {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Local ICE gathering timed out.")), 10000);
          const changed = () => {
            if (peer.iceGatheringState === "complete") {
              clearTimeout(timer);
              peer.removeEventListener("icegatheringstatechange", changed);
              resolve();
            }
          };
          peer.addEventListener("icegatheringstatechange", changed);
        });
      }
    }
    await local(sender, await sender.createOffer());
    await receiver.setRemoteDescription(sender.localDescription);
    await local(receiver, await receiver.createAnswer());
    await sender.setRemoteDescription(receiver.localDescription);
  }
  async function startPeers() {
    const NativePeer = window.__proofNativePeer;
    const incomingContext = new AudioContext({ sampleRate: 16000 });
    await incomingContext.resume();
    const incomingAudio = incomingContext.createMediaStreamDestination();
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const paint = () => {
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#000000";
      context.font = "bold 64px sans-serif";
      context.fillText(`CHECK ${challenge}`, 55, 175);
      context.font = "18px sans-serif";
      context.fillText(String(Date.now()), 55, 245);
    };
    paint();
    setInterval(paint, 200);
    const incomingStream = new MediaStream([
      ...incomingAudio.stream.getAudioTracks(),
      ...canvas.captureStream(5).getVideoTracks(),
    ]);
    const sender = new NativePeer({ iceServers: [] });
    const receiver = new RTCPeerConnection({ iceServers: [] });
    incomingStream.getTracks().forEach((track) => sender.addTrack(track, incomingStream));
    await connect(sender, receiver);

    const outgoing = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const outgoingSender = new NativePeer({ iceServers: [] });
    const outgoingReceiver = new NativePeer({ iceServers: [] });
    outgoingReceiver.addEventListener("track", async (event) => {
      if (event.track.kind !== "audio") return;
      const context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      const sink = context.createMediaStreamDestination();
      context.createMediaStreamSource(new MediaStream([event.track])).connect(analyser).connect(sink);
      const samples = new Float32Array(analyser.fftSize);
      setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        window.__proof.outgoingRms = Math.max(window.__proof.outgoingRms, rms);
      }, 30);
    });
    outgoing.getTracks().forEach((track) => outgoingSender.addTrack(track, outgoing));
    await connect(outgoingSender, outgoingReceiver);
    window.__proof.playIncoming = async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (value) => value.charCodeAt(0));
      const buffer = await incomingContext.decodeAudioData(bytes.buffer);
      const source = incomingContext.createBufferSource();
      source.buffer = buffer;
      source.connect(incomingAudio);
      await new Promise((resolve) => { source.onended = resolve; source.start(); });
      source.disconnect();
    };
    window.__proof.ready = true;
  }
  function joined() {
    html(`<button aria-label="Chat" id="chat-button">Chat</button>
      <button aria-label="People">People</button><button aria-label="Leave">Leave</button>
      <button id="mic-button" aria-label="Mute mic">Mic</button>
      <button id="camera-button" aria-label="Turn camera off">Camera</button>
      <section id="chat-panel" hidden><div id="messages"></div>
      <div id="compose" role="textbox" contenteditable="true" style="min-height:40px;border:1px solid"></div>
      <button aria-label="Send" id="send-button">Send</button></section>`);
    document.getElementById("chat-button").onclick = () => { document.getElementById("chat-panel").hidden = false; };
    document.getElementById("mic-button").onclick = (event) => {
      const button = event.currentTarget;
      button.setAttribute("aria-label", button.getAttribute("aria-label") === "Mute mic" ? "Unmute mic" : "Mute mic");
    };
    document.getElementById("camera-button").onclick = (event) => {
      const button = event.currentTarget;
      button.setAttribute("aria-label", button.getAttribute("aria-label") === "Turn camera off" ? "Turn camera on" : "Turn camera off");
    };
    document.getElementById("send-button").onclick = () => {
      const composer = document.getElementById("compose");
      const message = document.createElement("div");
      message.dataset.tid = "chat-pane-message";
      message.dataset.mid = String(Date.now());
      message.textContent = composer.innerText;
      document.getElementById("messages").appendChild(message);
      composer.textContent = "";
    };
    void startPeers().catch(fail);
  }
  function prejoin() {
    html(`<h1>Local Teams interface fixture</h1>
      <input placeholder="Type your name" id="name">
      <label>Camera<input id="camera" type="checkbox" role="switch" checked></label>
      <label>Microphone<input id="microphone" type="checkbox" role="switch" checked></label>
      <input type="radio" aria-label="Computer audio" checked>
      <button aria-label="Join now" id="join" disabled>Join now</button>`);
    document.getElementById("name").addEventListener("input", () => {
      document.getElementById("join").disabled = !document.getElementById("name").value.trim();
    });
    document.getElementById("join").onclick = joined;
  }
  html('<button aria-label="Join meeting from this browser" id="browser">Continue on this browser</button>');
  document.getElementById("browser").onclick = prejoin;
}

function guards() {
  window.__proofNativePeer = window.RTCPeerConnection;
  window.__proofHardwareCalls = 0;
  window.__proofSpeakerConnections = 0;
  const denied = () => {
    window.__proofHardwareCalls += 1;
    throw new DOMException("Physical capture is forbidden in this proof.", "NotAllowedError");
  };
  for (const name of ["getUserMedia", "getDisplayMedia", "enumerateDevices", "selectAudioOutput"]) {
    Object.defineProperty(navigator.mediaDevices, name, { configurable: true, writable: true, value: denied });
  }
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (destination, ...args) {
    if (destination === this.context.destination) {
      window.__proofSpeakerConnections += 1;
      throw new Error("Physical speaker routing is forbidden in this proof.");
    }
    return Reflect.apply(connect, this, [destination, ...args]);
  };
}

async function waitFor(condition, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

export async function runNativeTeamsProof(electron) {
  const { app, BrowserWindow, ipcMain, session, safeStorage } = electron;
  const directory = process.env.RAPP_NATIVE_PROOF_SPEECH_DIRECTORY;
  const work = process.env.RAPP_NATIVE_PROOF_HOME;
  if (!directory || !work) throw new Error("The native proof must be started by its isolated launcher.");
  console.log("Native proof: starting isolated Electron.");
  mkdirSync(path.join(work, "browser"), { recursive: true, mode: 0o700 });
  app.setName("RAPP Teams Local Proof");
  app.setPath("userData", path.join(work, "browser"));
  await app.whenReady();
  console.log("Native proof: Electron ready.");
  if (process.platform === "darwin") app.setActivationPolicy("accessory");
  const challenge = String(randomInt(10000, 100000));
  let proofFinished = false;
  let passed = false;
  app.on("before-quit", (event) => { if (!proofFinished) event.preventDefault(); });
  const html = `<!doctype html><html><body><script>(${fixtureDocument.toString()})(${JSON.stringify(challenge)})</script></body></html>`;
  const runtime = new CopilotRuntime({ workingDirectory: beta });
  const conversation = new TeamsConversation({ runtime, identity: "r1" });
  let mediaEvents = 0;
  let state;
  let lastPhase = "";
  const manager = new TeamsMeeting({
    BrowserWindow: function ProofWindow(options) {
      console.log("Native proof: creating owned BrowserWindow.");
      const window = new BrowserWindow(options);
      console.log("Native proof: owned BrowserWindow created.");
      return window;
    },
    ipcMain,
    safeStorage,
    runtime,
    createBrowserSession: (partition) => {
      console.log("Native proof: creating fenced browser session.");
      const owned = session.fromPartition(partition, { cache: false });
      owned.protocol.handle("https", (request) => {
        if (request.url !== fixtureUrl) return new Response("Fixture blocks all other network destinations.", { status: 403 });
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      });
      console.log("Native proof: fenced browser session ready.");
      return owned;
    },
    createMediaSource: (options) => {
      console.log("Native proof: installing the virtual media source.");
      return `(${guards.toString()})();\n${createTeamsVirtualMediaSource(options)}`;
    },
    createSpeech: createMeetingSpeech,
    home: path.join(work, "controller"),
    preloadPath: path.join(beta, "electron", "teams-media-preload.cjs"),
    env: { ...process.env, RAPP_TEAMS_SPEECH_DIRECTORY: directory },
    onState: (value) => {
      state = value;
      const phase = `${value.phase}:${value.speech?.phase || ""}`;
      if (phase !== lastPhase) {
        console.log(`Native proof: ${phase} (speech=${value.speech?.state || "none"}, runAsNode=${Boolean(process.env.ELECTRON_RUN_AS_NODE)})`);
        lastPhase = phase;
      }
    },
  });
  ipcMain.on("beta:teams-media", () => { mediaEvents += 1; });
  try {
    await manager.join({
      url: fixtureUrl, identity: "r1", listen: true, speak: true,
      camera: true, vision: true, autonomous: false, headless: true, remember: false,
    });
    await waitFor(() => {
      if (state?.error) throw new Error(state.error);
      return state?.phase === "joined";
    }, "native guest controls");
    await waitFor(async () => {
      const status = await manager.runPage("({ready: window.__proof.ready, error: window.__proof.error})");
      if (status.error) throw new Error(status.error);
      return status.ready;
    }, "local-only WebRTC peers");
    console.log("Native proof: local WebRTC connected.");
    await waitFor(() => state.receivedVideoFrames > 0, "remote video through the real preload/IPC boundary");
    const sample = await manager.speech.synthesize(phrase);
    await manager.runPage(`window.__proof.playIncoming(${JSON.stringify(sample.wav.toString("base64"))})`);
    await waitFor(() => state.receivedAudioSegments > 0, "local transcription of received WebRTC audio");
    assert.match(state.lastTranscript, /virtual audio bridge is ready/i);
    console.log("Native proof: received speech transcribed.");

    const sent = await manager.sendChat("Local native controls are ready. -- r1", "native-proof");
    const duplicate = await manager.sendChat("Local native controls are ready. -- r1", "native-proof");
    assert.equal(sent.messageId, duplicate.messageId);
    assert.equal(await manager.runPage('document.querySelectorAll("[data-tid=chat-pane-message]").length'), 1);

    const speech = await manager.speak(phrase);
    assert.equal(speech.stopped, false);
    await waitFor(async () => (await manager.runPage("window.__proof.outgoingRms")) > 0.01, "speech received from the virtual microphone");
    const completedBeforeStop = await manager.runPage("window.__rappTeamsMedia.status().counters.completedClips");
    const interrupted = manager.speak(phrase).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    await waitFor(async () => (await manager.runPage("window.__rappTeamsMedia.status().microphone.busy")), "active virtual speech");
    await manager.configure({ speak: false });
    const interruption = await interrupted;
    if (!interruption.ok) throw interruption.error;
    assert.equal(interruption.value.stopped, true);
    assert.equal(await manager.runPage("window.__rappTeamsMedia.status().counters.completedClips"), completedBeforeStop);
    console.log("Native proof: outgoing speech and immediate mute confirmed.");
    await manager.configure({ camera: false });
    assert.equal(await manager.runPage('document.getElementById("camera-button").getAttribute("aria-label")'), "Turn camera on");

    await conversation.prepare();
    const answer = await conversation.respond({
      text: "Read the five-digit code after CHECK in the attached meeting view. Reply with only those five digits.",
      source: "operator",
      frame: manager.lastFrame,
    });
    assert.equal(answer.text, challenge);
    console.log("Native proof: synthetic visual challenge read.");
    const safety = await manager.runPage("({hardwareCalls: window.__proofHardwareCalls, speakerConnections: window.__proofSpeakerConnections})");
    assert.deepEqual(safety, { hardwareCalls: 0, speakerConnections: 0 });
    const result = {
      passed: true,
      nativeElectron: process.versions.electron,
      realPreloadIpcEvents: mediaEvents,
      incomingAudioSegments: state.receivedAudioSegments,
      incomingVideoFrames: state.receivedVideoFrames,
      recognizedMeaning: true,
      virtualMicrophoneReceived: true,
      clipCancellationPreservesCapture: true,
      cameraControlConfirmed: true,
      privateVisionCodeReadExactly: true,
      ...safety,
      realMeetingJoined: false,
    };
    writeFileSync(path.join(work, "result.json"), JSON.stringify(result), { mode: 0o600 });
    console.log(JSON.stringify(result, null, 2));
    passed = true;
  } catch (error) {
    console.error(`Native proof failed: ${String(error.message || error).slice(0, 600)}`);
    throw error;
  } finally {
    try {
      await manager.dispose();
      await conversation.close();
      await runtime.stop();
      redaction.flush();
    } catch (error) {
      passed = false;
      console.error(`Native proof cleanup failed: ${String(error.message || error).slice(0, 600)}`);
    }
    proofFinished = true;
    app.exit(passed ? 0 : 1);
  }
}

async function launch() {
  if (process.argv.includes("--help")) {
    console.log("node beta/scripts/teams-native-proof.mjs --directory <verified-private-speech-cache>\nRuns an isolated native Electron fixture, local-only WebRTC, local speech, and one synthetic-image request through the existing AI connection. Never enters a real meeting or uses hardware capture/speakers.");
    return;
  }
  const index = process.argv.indexOf("--directory");
  const directory = index >= 0 ? process.argv[index + 1] : null;
  if (!directory || !path.isAbsolute(directory)) throw new Error("Supply an absolute --directory for the verified private speech cache.");
  const work = mkdtempSync(path.join(tmpdir(), "rapp-teams-native-proof-"));
  const env = { ...process.env, RAPP_NATIVE_PROOF_HOME: work, RAPP_NATIVE_PROOF_SPEECH_DIRECTORY: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const timeoutMs = Number(process.env.RAPP_NATIVE_PROOF_TIMEOUT_MS || 240000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 30000 || timeoutMs > 240000) {
    throw new Error("The native proof timeout must be between 30 and 240 seconds.");
  }
  try {
    const entry = path.join(beta, "tests", "e2e", "harness", "teams-native-main.mjs");
    const child = spawn(require("electron"), [entry], { env, stdio: "inherit" });
    let forcedStop;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forcedStop = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 5000);
    }, timeoutMs);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (timedOut) throw new Error(`The native media proof exceeded ${timeoutMs / 1000} seconds.`);
      if (code !== 0) throw new Error(`Native media proof exited with code ${code}.`);
      const result = JSON.parse(readFileSync(path.join(work, "result.json"), "utf8"));
      if (result.passed !== true) throw new Error("The native proof exited without verified success.");
    } finally {
      clearTimeout(timeout);
      clearTimeout(forcedStop);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  launch().catch((error) => {
    console.error(String(error.message || error).slice(0, 600));
    process.exitCode = 1;
  });
}
