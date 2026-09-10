import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createTeamsVirtualMediaSource } from "../electron/teams-virtual-media.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const settled = () => new Promise((resolve) => setImmediate(resolve));

function wav({ durationMs = 1000, rate = 16000, channels = 1, amplitude = 0.2 } = {}) {
  const frames = Math.round(durationMs / 1000 * rate);
  const bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      bytes.writeInt16LE(Math.round(Math.sin(frame * 2 * Math.PI * 440 / rate) * amplitude * 32767), 44 + (frame * channels + channel) * 2);
    }
  }
  return bytes;
}

function fixture(t, {
  url = "https://teams.microsoft.com/v2/", options, blockedAudio = false, webRTC = true,
  virtualOutput = true, silentSinkWorks = true, jpeg,
} = {}) {
  let milliseconds = 10000;
  let nextTimer = 0;
  let nextTrack = 0;
  const timers = new Map();
  const posts = [];
  const contexts = [];
  const resumes = [];
  const nodes = [];
  const canvases = [];
  const videos = [];
  const decoders = [];
  const allTracks = [];
  const silentSelections = [];
  const hardwareCalls = [];
  const speakerConnections = [];
  const native = (name) => () => { hardwareCalls.push(name); throw new Error("Physical capture must never be used"); };
  const schedule = (fn, delay, repeating) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: milliseconds + delay, delay, repeating });
    return id;
  };
  function advance(amount) {
    const end = milliseconds + amount;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      milliseconds = timer.at;
      if (timer.repeating) timer.at += timer.delay;
      else timers.delete(id);
      timer.fn();
    }
    milliseconds = end;
  }
  class Track extends EventTarget {
    constructor(kind) {
      super();
      this.kind = kind;
      this.id = `track-${++nextTrack}`;
      this.readyState = "live";
      this.muted = false;
      this.enabled = true;
      this.settings = kind === "audio" ? { sampleRate: 16000, channelCount: 1 } : { width: 1280, height: 720, frameRate: 30 };
      allTracks.push(this);
    }
    get label() { return "native synthetic track"; }
    stop() { this.readyState = "ended"; }
    clone() {
      const clone = new Track(this.kind);
      clone.settings = { ...this.settings };
      clone.readyState = this.readyState;
      return clone;
    }
    getSettings() { return { ...this.settings }; }
    getCapabilities() { return { width: { min: 1, max: 1280 } }; }
    async applyConstraints(constraints) {
      for (const key of ["width", "height", "frameRate"]) {
        const required = constraints[key]?.exact;
        if (required !== undefined) {
          if (required > this.settings[key]) {
            const error = new DOMException("Unsupported video size", "OverconstrainedError");
            Object.defineProperty(error, "constraint", { value: key });
            throw error;
          }
          this.settings[key] = required;
        }
      }
    }
    end() { this.readyState = "ended"; this.dispatchEvent(new Event("ended")); }
  }
  class Stream {
    constructor(tracks = []) { this.tracks = [...tracks]; }
    getTracks() { return [...this.tracks]; }
    getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
    getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
    clone() { return new Stream(this.tracks.map((track) => Track.prototype.clone.call(track))); }
  }
  class AudioNode {
    constructor(ctx) { this.ctx = ctx; this.connections = new Set(); nodes.push(this); }
    connect(target) {
      this.connections.add(target);
      if (target === this.ctx.destination) speakerConnections.push(this);
      return target;
    }
    disconnect() { this.connections.clear(); }
  }
  class AudioContext {
    constructor(settings = {}) {
      this.options = settings;
      this.sampleRate = settings.sampleRate ?? 48000;
      this.selectedSink = silentSinkWorks ? (settings.sinkId ?? "") : "";
      this.state = blockedAudio ? "suspended" : "running";
      this.destination = new AudioNode(this);
      contexts.push(this);
    }
    get sinkId() { return this.selectedSink; }
    async setSinkId(id) {
      if (id?.type !== "none") hardwareCalls.push("AudioContext.setSinkId");
      if (!silentSinkWorks) throw new DOMException("No-device sinks unsupported.", "NotSupportedError");
      silentSelections.push(id);
      this.selectedSink = id;
    }
    resume() { return blockedAudio ? new Promise((resolve) => resumes.push(resolve)) : Promise.resolve(); }
    close() { this.state = "closed"; return Promise.resolve(); }
    createGain() { return Object.assign(new AudioNode(this), { gain: { value: 1 } }); }
    createAnalyser() {
      return Object.assign(new AudioNode(this), { getFloatTimeDomainData: (array) => array.fill(0) });
    }
    createMediaStreamDestination() {
      return Object.assign(new AudioNode(this), { stream: new Stream([new Track("audio")]) });
    }
    createConstantSource() {
      return Object.assign(new AudioNode(this), { offset: { value: 0 }, start() { this.started = true; }, stop() { this.stopped = true; } });
    }
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (channel) => data[channel] };
    }
    createBufferSource() {
      return Object.assign(new AudioNode(this), {
        start() { this.started = true; },
        stop() { this.stopped = true; },
      });
    }
    createMediaStreamSource(stream) { return Object.assign(new AudioNode(this), { stream }); }
    createMediaElementSource(element) {
      if (element.boundSource) throw new DOMException("Element is already bound.", "InvalidStateError");
      const source = Object.assign(new AudioNode(this), { mediaElement: element });
      element.boundSource = source;
      return source;
    }
    createScriptProcessor() { return Object.assign(new AudioNode(this), { onaudioprocess: null }); }
  }
  if (!virtualOutput) {
    delete AudioContext.prototype.sinkId;
    delete AudioContext.prototype.setSinkId;
    delete AudioContext.prototype.createMediaElementSource;
  }
  class MediaElement extends EventTarget {
    constructor() {
      super();
      this.readyState = 2;
      this.videoWidth = 640;
      this.videoHeight = 360;
      this.muted = false;
      this.defaultMuted = false;
      this.volume = 1;
      this.srcObject = null;
    }
    get sinkId() { return "unselected-native-output"; }
    async setSinkId() { hardwareCalls.push("HTMLMediaElement.setSinkId"); }
    async play() { this.paused = false; }
    pause() { this.paused = true; }
    remove() { this.removed = true; }
  }
  class Peer extends EventTarget {
    constructor(configuration) {
      super();
      this.configuration = configuration;
      this.senders = [];
      this.receivers = [];
      this.connectionState = "new";
      this.signalingState = "stable";
    }
    static generateCertificate(value) { return value; }
    addTrack(track) { const sender = { track }; this.senders.push(sender); return sender; }
    getSenders() { return [...this.senders]; }
    getReceivers() { return [...this.receivers]; }
    receive(track) {
      const receiver = { track };
      this.receivers.push(receiver);
      const event = new Event("track");
      Object.assign(event, { track, receiver, streams: [] });
      this.dispatchEvent(event);
      this.ontrack?.(event);
    }
    close() { this.connectionState = "closed"; this.signalingState = "closed"; }
  }
  function canvas() {
    const result = {
      width: 0, height: 0, text: [], frames: 0,
      captureStream() { return new Stream([new Track("video")]); },
      getContext() {
        return {
          fillRect() {}, beginPath() {}, arc() {}, fill() {},
          fillText: (text) => result.text.push(text),
          drawImage: () => { result.frames++; },
        };
      },
      toDataURL: () => jpeg ?? "data:image/jpeg;base64,/9j/2Q==",
    };
    canvases.push(result);
    return result;
  }
  const originalQuery = async ({ name }) => ({ name, state: "denied" });
  const sandbox = Object.assign(new EventTarget(), {
    location: new URL(url),
    document: {
      createElement(name) {
        if (name === "canvas") return canvas();
        if (!["audio", "video"].includes(name)) throw new Error(`Unexpected DOM element: ${name}`);
        const video = new MediaElement();
        (name === "video" ? videos : decoders).push(video);
        return video;
      },
    },
    navigator: {
      mediaDevices: {
        getUserMedia: native("getUserMedia"),
        enumerateDevices: native("enumerateDevices"),
        getDisplayMedia: native("getDisplayMedia"),
        selectAudioOutput: native("selectAudioOutput"),
      },
      getUserMedia: native("legacy"),
      webkitGetUserMedia: native("webkit"),
      permissions: { query: originalQuery },
    },
    Date: class extends Date { static now() { return milliseconds; } },
    AudioContext, RTCPeerConnection: webRTC ? Peer : undefined, webkitRTCPeerConnection: webRTC ? Peer : undefined,
    MediaStream: Stream, HTMLMediaElement: MediaElement,
    EventTarget, Event, DOMException, TextEncoder, structuredClone,
    atob, btoa,
    setInterval: (fn, delay) => schedule(fn, delay, true),
    setTimeout: (fn, delay) => schedule(fn, delay, false),
    clearInterval: (id) => timers.delete(id),
    clearTimeout: (id) => timers.delete(id),
    postMessage: (packet, origin) => posts.push({ packet: plain(packet), origin }),
  });
  sandbox.window = sandbox;
  const realm = vm.createContext(sandbox);
  const source = createTeamsVirtualMediaSource(options);
  vm.runInContext(source, realm);
  t.after(() => {
    sandbox.__rappTeamsMedia?.stop();
    assert.deepEqual(hardwareCalls, []);
    assert.deepEqual(speakerConnections, []);
    for (const { packet, origin } of posts) {
      assert.equal(origin, sandbox.location.origin);
      assert.equal(packet.source, "rapp-teams-media");
      const bound = packet.type === "audio" ? 350 * 1024 : packet.type === "video" ? 128 * 1024 : 8192;
      assert.ok(Buffer.byteLength(JSON.stringify(packet)) <= bound);
    }
  });
  function feed(durationMs, amplitude = 0, sampleRate = 16000) {
    const samples = new Float32Array(Math.round(durationMs * 16));
    for (let index = 0; index < samples.length; index++) samples[index] = Math.sin(index * Math.PI / 8) * amplitude;
    const output = new Float32Array(samples.length).fill(1);
    const processor = nodes.findLast((node) => node.onaudioprocess);
    assert.ok(processor, "capture pipeline exists");
    processor.onaudioprocess({
      inputBuffer: { sampleRate, getChannelData: () => samples },
      outputBuffer: { getChannelData: () => output },
    });
    assert.equal(output.every((value) => value === 0), true);
  }
  return {
    sandbox, api: sandbox.__rappTeamsMedia, source, realm, Track, Peer, Stream,
    posts, contexts, nodes, timers, canvases, videos, decoders, allTracks, originalQuery, silentSelections,
    NativeAudioContext: AudioContext,
    resumeAudio: () => resumes.splice(0).forEach((resolve) => resolve()),
    advance, feed, packets: (type) => posts.filter(({ packet }) => packet.type === type).map(({ packet }) => packet.payload),
  };
}

test("generator validates options and embeds identity as data, not HTML", () => {
  assert.throws(() => createTeamsVirtualMediaSource({ identity: "" }), TypeError);
  assert.throws(() => createTeamsVirtualMediaSource({ captureAudio: "true" }), TypeError);
  const source = createTeamsVirtualMediaSource({ identity: "</script><img onerror=alert(1)>\u2028" });
  assert.equal(source.includes("</script>"), false);
  assert.ok(source.includes("\\u003c"));
  assert.ok(!source.includes("innerHTML"));
});

test("installation is limited to the two canonical HTTPS Teams origins", async (t) => {
  for (const url of [
    "http://teams.microsoft.com/", "https://teams.microsoft.com.evil.test/",
    "https://sub.teams.microsoft.com/", "https://teams.live.com:444/",
    "https://example.test/", "file:///fixture.html", "about:blank",
  ]) {
    const f = fixture(t, { url });
    assert.equal(f.api, undefined, url);
    assert.equal(f.posts.length, 0);
    assert.equal(f.timers.size, 0);
    assert.equal(f.sandbox.RTCPeerConnection, f.Peer);
  }
  assert.ok(fixture(t, { url: "https://teams.live.com/meet/" }).api);
});

test("virtual inputs, permission facade, idempotence and physical non-use", async (t) => {
  const f = fixture(t, { options: { identity: "<r1>" } });
  assert.deepEqual(Object.keys(f.api).sort(), ["playAudio", "setCaptureEnabled", "snapshotRemoteVideo", "status", "stop", "stopSpeaking"]);
  const beforeTimers = f.timers.size;
  vm.runInContext(f.source, f.realm);
  assert.equal(f.sandbox.__rappTeamsMedia, f.api);
  assert.equal(f.timers.size, beforeTimers);
  const devices = plain(await f.sandbox.navigator.mediaDevices.enumerateDevices());
  assert.deepEqual(devices.map(({ kind, label }) => ({ kind, label })), [
    { kind: "audioinput", label: "<r1> Virtual Microphone" },
    { kind: "videoinput", label: "<r1> Virtual Camera" },
    { kind: "audiooutput", label: "<r1> Virtual Speaker (Silent)" },
  ]);
  assert.deepEqual(plain(f.api.status().capture), { audio: false, video: false });
  const permission = await f.sandbox.navigator.permissions.query({ name: "microphone" });
  assert.equal(permission.state, "granted");
  assert.equal((await f.originalQuery({ name: "microphone" })).state, "denied");
  assert.equal((await f.sandbox.navigator.permissions.query({ name: "geolocation" })).state, "denied");
  let changes = 0;
  permission.onchange = () => changes++;
  permission.addEventListener("change", () => changes++);
  await assert.rejects(f.sandbox.navigator.mediaDevices.getDisplayMedia({ video: true }), { name: "NotAllowedError" });
  await assert.rejects(f.sandbox.navigator.mediaDevices.selectAudioOutput({ deviceId: "physical-speaker" }), { name: "NotFoundError" });
  f.api.stop();
  assert.equal(permission.state, "denied");
  assert.equal(changes, 2);
  assert.deepEqual(plain(await f.sandbox.navigator.mediaDevices.enumerateDevices()), []);
  await assert.rejects(f.sandbox.navigator.mediaDevices.getUserMedia({ audio: true }), { name: "InvalidStateError" });
});

test("virtual speaker selection creates a real silent media-element route, not a hardware alias", async (t) => {
  const f = fixture(t);
  const devices = await f.sandbox.navigator.mediaDevices.enumerateDevices();
  const speaker = devices.find((device) => device.kind === "audiooutput");
  assert.equal(speaker.deviceId, "rapp-teams-virtual-speaker");
  assert.equal(speaker.label, "r1 Virtual Speaker (Silent)");
  const permission = await f.sandbox.navigator.permissions.query({ name: "speaker-selection" });
  assert.equal(permission.state, "granted");
  assert.equal((await f.originalQuery({ name: "speaker-selection" })).state, "denied");
  assert.deepEqual(plain(await f.sandbox.navigator.mediaDevices.selectAudioOutput()), plain(speaker));
  const element = f.sandbox.document.createElement("audio");
  assert.equal(element.sinkId, "");
  await Promise.all([element.setSinkId(speaker.deviceId), element.setSinkId("default")]);
  assert.equal(element.sinkId, speaker.deviceId);
  assert.equal(element.muted && element.defaultMuted, true);
  assert.equal(element.volume, 0);
  assert.ok(element.boundSource, "a real MediaElementAudioSource is required for success");
  const [discardGain] = element.boundSource.connections;
  assert.equal(discardGain.gain.value, 0);
  const [destination] = discardGain.connections;
  assert.equal(destination.stream.getTracks()[0].readyState, "live");
  assert.equal(f.api.status().microphone.active, false, "speaker routing must not create or feed the microphone");
  for (const id of ["", "communications", speaker.deviceId]) {
    await element.setSinkId(id);
    assert.equal(element.sinkId, speaker.deviceId);
  }
  assert.equal(f.nodes.filter((node) => node.mediaElement === element).length, 1);
  await assert.rejects(element.setSinkId("physical-speaker"), { name: "NotFoundError" });
  assert.equal(element.sinkId, speaker.deviceId, "an invalid selection must not tear down the existing route");
  assert.equal(element.boundSource.connections.size, 1);
  f.api.stop();
  assert.equal(permission.state, "denied");
  assert.equal(element.paused, true);
  assert.equal(element.boundSource.connections.size, 0);
  assert.equal(destination.stream.getTracks()[0].readyState, "ended");
  assert.equal(f.contexts[0].state, "closed");
  await assert.rejects(element.setSinkId(speaker.deviceId), { name: "InvalidStateError" });
  await assert.rejects(f.sandbox.navigator.mediaDevices.selectAudioOutput(), { name: "InvalidStateError" });
});

test("audio-context defaults and sink selection use only native no-device sinks with native instances", async (t) => {
  const f = fixture(t);
  const speaker = (await f.sandbox.navigator.mediaDevices.selectAudioOutput()).deviceId;
  class AppAudio extends f.sandbox.AudioContext {}
  const ctx = new AppAudio({ sampleRate: 24000, sinkId: speaker });
  assert.ok(ctx instanceof f.NativeAudioContext && ctx instanceof f.sandbox.AudioContext && ctx instanceof AppAudio);
  assert.equal(ctx.sampleRate, 24000);
  assert.equal(ctx.sinkId, speaker);
  assert.deepEqual(plain(ctx.options.sinkId), { type: "none" });
  for (const id of ["", "default", "communications", speaker]) {
    await ctx.setSinkId(id);
    assert.equal(ctx.sinkId, speaker);
  }
  await ctx.setSinkId({ type: "none" });
  assert.deepEqual(plain(ctx.sinkId), { type: "none" });
  assert.ok(f.silentSelections.every((selection) => selection.type === "none"));
  await assert.rejects(ctx.setSinkId("physical-speaker"), { name: "NotFoundError" });
  assert.throws(() => new f.sandbox.AudioContext({ sinkId: "physical-speaker" }), { name: "NotFoundError" });
  const defaults = new f.sandbox.AudioContext();
  assert.equal(defaults.sinkId, speaker);
  assert.deepEqual(plain(defaults.options.sinkId), { type: "none" });
  await defaults.close();
  f.api.stop();
  assert.equal(ctx.state, "running", "application contexts remain application-owned, but still have no output device");
  await assert.rejects(ctx.setSinkId(speaker), { name: "InvalidStateError" });
  assert.throws(() => new f.sandbox.AudioContext(), { name: "InvalidStateError" });
  await ctx.close();
});

test("unavailable or unverified silent sinks fail explicitly without a physical fallback", async (t) => {
  const unsupported = fixture(t, { virtualOutput: false });
  assert.equal((await unsupported.sandbox.navigator.mediaDevices.enumerateDevices()).some((device) => device.kind === "audiooutput"), false);
  assert.equal((await unsupported.sandbox.navigator.permissions.query({ name: "speaker-selection" })).state, "denied");
  await assert.rejects(unsupported.sandbox.navigator.mediaDevices.selectAudioOutput(), { name: "NotSupportedError" });
  await assert.rejects(unsupported.sandbox.document.createElement("audio").setSinkId("default"), { name: "NotSupportedError" });
  assert.equal(unsupported.packets("error").at(-1).code, "set-output-sink");
  assert.equal(unsupported.contexts.length, 0);
  const rejectedSink = fixture(t, { silentSinkWorks: false });
  await assert.rejects(rejectedSink.sandbox.navigator.mediaDevices.selectAudioOutput(), { name: "NotSupportedError" });
  assert.equal(rejectedSink.packets("error").at(-1).code, "select-audio-output");
  assert.equal(rejectedSink.contexts[0].state, "closed");
});

test("virtual output bindings are bounded and failed setup never reports a selected sink", async (t) => {
  const f = fixture(t);
  const conflicted = f.sandbox.document.createElement("audio");
  conflicted.boundSource = {};
  await assert.rejects(conflicted.setSinkId("default"), { name: "InvalidStateError" });
  assert.equal(conflicted.sinkId, "");
  assert.equal(conflicted.muted, true);
  for (let index = 0; index < 64; index++) await f.sandbox.document.createElement("audio").setSinkId("default");
  const overflow = f.sandbox.document.createElement("audio");
  await assert.rejects(overflow.setSinkId("default"), { name: "QuotaExceededError" });
  assert.equal(overflow.sinkId, "");
  assert.equal(f.packets("error").at(-1).code, "set-output-sink");
  f.api.stop();
  assert.ok(f.nodes.every((node) => node.connections.size === 0));
  assert.ok(f.allTracks.every((track) => track.readyState === "ended"));
});

test("stopping during virtual speaker startup never connects late nodes or leaves live sink tracks", async (t) => {
  for (let turns = 0; turns < 8; turns++) {
    const f = fixture(t);
    const element = f.sandbox.document.createElement("audio");
    const selection = element.setSinkId("default").catch((error) => error.name);
    for (let turn = 0; turn < turns; turn++) await Promise.resolve();
    f.api.stop();
    await selection;
    await settled();
    assert.equal(element.sinkId, "");
    assert.equal(f.timers.size, 0);
    assert.ok(f.nodes.every((node) => node.connections.size === 0));
    assert.ok(f.allTracks.every((track) => track.readyState === "ended"));
    assert.equal(f.api.status().state, "stopped");
  }
  const suspended = fixture(t, { blockedAudio: true });
  const element = suspended.sandbox.document.createElement("audio");
  const selected = element.setSinkId("default");
  const rejected = assert.rejects(selected, { name: "AbortError" });
  suspended.api.stop();
  await rejected;
  suspended.resumeAudio();
  await settled();
  assert.equal(suspended.contexts[0].state, "closed");
  assert.equal(element.boundSource, undefined);
  assert.equal(suspended.nodes.some((node) => node.stream), false);
});

test("source tracks survive prejoin probes and recursively cloned streams", async (t) => {
  const f = fixture(t);
  const first = await f.sandbox.navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  assert.ok(first instanceof f.Stream);
  const cloned = first.clone();
  const twice = cloned.getAudioTracks()[0].clone();
  assert.equal(twice.label, "r1 Virtual Microphone");
  first.getTracks().forEach((track) => track.stop());
  cloned.getTracks().forEach((track) => track.stop());
  twice.stop();
  const second = await f.sandbox.navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: f.api.status().devices.audioId }, echoCancellation: true },
    video: { width: { exact: 640 }, height: { exact: 360 }, frameRate: { ideal: 30 } },
  });
  assert.equal(second.getTracks().every((track) => track.readyState === "live"), true);
  assert.equal(second.getVideoTracks()[0].label, "r1 Virtual Camera");
  assert.equal(second.getVideoTracks()[0].getSettings().width, 640);
  assert.equal(second.getAudioTracks()[0].getSettings().deviceId, f.api.status().devices.audioId);
  assert.equal(second.getAudioTracks()[0].getSettings().echoCancellation, false);
  assert.ok(f.canvases[0].text.includes("r1"));
  assert.ok(f.canvases[0].text.includes("AI participant · virtual camera"));
  const legacy = await new Promise((resolve, reject) => f.sandbox.navigator.webkitGetUserMedia({ audio: true }, resolve, reject));
  assert.equal(legacy.getAudioTracks()[0].label, "r1 Virtual Microphone");
  f.api.stop();
  assert.ok(f.allTracks.every((track) => track.readyState === "ended"));
  assert.ok(f.nodes.every((node) => node.connections.size === 0));
  assert.equal(f.contexts[0].state, "closed");
  assert.equal(f.timers.size, 0);
});

test("exact unknown IDs, impossible constraints and screen sources reject without fallback", async (t) => {
  const f = fixture(t);
  const requests = [
    {},
    { audio: { deviceId: { exact: "physical-id" } }, video: true },
    { video: { advanced: [{ deviceId: { exact: ["physical-id"] } }] } },
    { audio: { mandatory: { sourceId: "physical-id" } } },
    { video: { mandatory: { chromeMediaSource: "desktop" } } },
    { video: { chromeMediaSourceId: "screen:1" } },
    { audio: { sampleRate: { exact: 48000 } } },
    { audio: { channelCount: { min: 2 } } },
    { audio: { echoCancellation: { exact: true } } },
    { video: { facingMode: { exact: "environment" } } },
    { video: { unknown: { exact: true } } },
  ];
  for (const request of requests) await assert.rejects(f.sandbox.navigator.mediaDevices.getUserMedia(request));
  assert.equal(f.contexts.length, 0);
  assert.equal(f.canvases.length, 0);
  await assert.rejects(f.sandbox.navigator.mediaDevices.getUserMedia({ video: { width: { exact: 4000 } } }), { name: "OverconstrainedError" });
  assert.equal(f.api.status().camera.tracks, 0);
  const stream = await f.sandbox.navigator.mediaDevices.getUserMedia({ audio: { deviceId: { ideal: "unavailable" } } });
  await assert.rejects(stream.getAudioTracks()[0].applyConstraints({ deviceId: { exact: "physical-id" } }), { name: "OverconstrainedError", constraint: "deviceId" });
});

test("Web Audio autoplay denial is explicit and bounded", async (t) => {
  const f = fixture(t, { blockedAudio: true });
  const request = f.sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
  const rejected = assert.rejects(request, { name: "NotAllowedError" });
  f.advance(2100);
  await rejected;
  assert.equal(f.api.status().microphone.active, false);
  assert.equal(f.packets("error").at(-1).code, "get-user-media");
});

test("missing WebRTC fails closed, reports unhealthy status and leaves no active installation", async (t) => {
  const f = fixture(t, { webRTC: false });
  assert.equal(f.api.status().state, "error");
  assert.equal(f.api.status().lastError.code, "installation");
  assert.equal(f.timers.size, 0);
  assert.deepEqual(plain(await f.sandbox.navigator.mediaDevices.enumerateDevices()), []);
  await assert.rejects(f.sandbox.navigator.mediaDevices.getUserMedia({ audio: true }), { name: "InvalidStateError" });
  assert.equal((await f.sandbox.navigator.permissions.query({ name: "microphone" })).state, "denied");
});

test("track quota is bounded and failed stream cloning rolls back partial clones", async (t) => {
  const f = fixture(t);
  const stream = await f.sandbox.navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  for (let index = 0; index < 61; index++) stream.getAudioTracks()[0].clone();
  assert.equal(f.api.status().microphone.tracks + f.api.status().camera.tracks, 63);
  assert.throws(() => stream.clone(), { name: "QuotaExceededError" });
  assert.equal(f.api.status().microphone.tracks + f.api.status().camera.tracks, 63);
  assert.equal(f.packets("error").at(-1).code, "virtual-track-overflow");
  f.api.stop();
  assert.ok(f.allTracks.every((track) => track.readyState === "ended"));
});

test("stopping while audio is resuming cancels pending work and capture without late packets", async (t) => {
  const f = fixture(t, { blockedAudio: true, options: { captureAudio: true } });
  const pc = new f.sandbox.RTCPeerConnection();
  const track = new f.Track("audio");
  pc.receive(track);
  const playing = f.api.playAudio({ base64: wav().toString("base64") });
  const rejected = assert.rejects(playing, { name: "AbortError" });
  f.api.stop();
  await rejected;
  await settled();
  const posts = f.posts.length;
  f.advance(10000);
  assert.equal(f.posts.length, posts);
  assert.equal(f.timers.size, 0);
  assert.equal(f.contexts[0].state, "closed");
  assert.equal(f.decoders.length, 0);
  assert.equal(track.readyState, "live");
});

test("playAudio validates PCM, is exclusive, completes and cancels without speaker routing", async (t) => {
  const f = fixture(t);
  const clip = wav({ rate: 24000, channels: 2 });
  const playing = f.api.playAudio({ base64: clip.toString("base64") });
  await settled();
  assert.equal(f.api.status().microphone.busy, true);
  await assert.rejects(f.api.playAudio({ base64: clip.toString("base64") }), { name: "InvalidStateError" });
  const source = f.nodes.findLast((node) => node.buffer);
  assert.equal(source.buffer.numberOfChannels, 2);
  assert.equal(source.buffer.sampleRate, 24000);
  assert.ok(source.buffer.getChannelData(0).some((sample) => sample > 0.19));
  source.onended();
  assert.deepEqual(plain(await playing), { durationMs: 1000 });
  assert.equal(source.buffer, null);
  assert.equal(source.connections.size, 0);
  assert.equal(f.api.status().microphone.busy, false);
  const pending = f.api.playAudio({ base64: clip.toString("base64") });
  await settled();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  f.api.stop();
  await rejected;
  assert.equal(f.api.status().counters.completedClips, 1);
});

test("stopSpeaking cancels only the clip, preserves capture and camera, and does not count completion", async (t) => {
  const f = fixture(t, { options: { captureAudio: true, captureVideo: true } });
  const stream = await f.sandbox.navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  const pc = new f.sandbox.RTCPeerConnection();
  pc.receive(new f.Track("audio"));
  pc.receive(new f.Track("video"));
  await settled();
  assert.deepEqual(plain(f.api.stopSpeaking()), { stopped: false });
  const baselineTimers = f.timers.size;
  const playing = f.api.playAudio({ base64: wav({ durationMs: 2000 }).toString("base64") });
  const rejected = assert.rejects(playing, { name: "AbortError" });
  await settled();
  const source = f.nodes.findLast((node) => node.buffer);
  const lateEnded = source.onended;
  assert.deepEqual(plain(f.api.stopSpeaking()), { stopped: true });
  assert.equal(source.stopped, true);
  assert.equal(source.connections.size, 0);
  assert.equal(source.buffer, null);
  assert.equal(f.api.status().microphone.busy, false);
  assert.equal(f.timers.size, baselineTimers);
  await rejected;
  lateEnded();
  assert.equal(f.api.status().counters.completedClips, 0);
  assert.equal(f.api.status().counters.errors, 0);
  assert.equal(f.api.status().state, "ready");
  assert.equal(f.contexts[0].state, "running");
  assert.equal(stream.getTracks().every((track) => track.readyState === "live"), true);
  assert.deepEqual(plain(f.api.status().capture), { audio: true, video: true });
  assert.equal(f.api.status().incoming.capturingAudioTracks, 1);
  assert.equal(f.api.status().incoming.capturingVideoTracks, 1);
  f.feed(1000, 0.2);
  f.feed(1000);
  assert.equal(f.packets("audio").length, 1);
  assert.ok(f.api.snapshotRemoteVideo());
  assert.deepEqual(plain(f.api.stopSpeaking()), { stopped: false });
  const next = f.api.playAudio({ base64: wav({ durationMs: 500 }).toString("base64") });
  await settled();
  f.nodes.findLast((node) => node.buffer).onended();
  assert.deepEqual(plain(await next), { durationMs: 500 });
  assert.equal(f.api.status().counters.completedClips, 1);
  f.api.stop();
  assert.deepEqual(plain(f.api.stopSpeaking()), { stopped: false });
});

test("stopSpeaking rejects immediately during shared resume without cancelling other capture or a replacement clip", async (t) => {
  const f = fixture(t, { blockedAudio: true, options: { captureAudio: true, captureVideo: true } });
  const pc = new f.sandbox.RTCPeerConnection();
  pc.receive(new f.Track("video"));
  await f.sandbox.navigator.mediaDevices.getUserMedia({ video: true });
  const playing = f.api.playAudio({ base64: wav().toString("base64") });
  const ctx = f.contexts[0];
  const getStream = f.sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
  pc.receive(new f.Track("audio"));
  const rejected = assert.rejects(playing, { name: "AbortError" });
  assert.deepEqual(plain(f.api.stopSpeaking()), { stopped: true });
  const replacement = f.api.playAudio({ base64: wav({ durationMs: 500 }).toString("base64") });
  await rejected;
  assert.equal(f.api.status().microphone.busy, true, "old cancellation must not clear the replacement job");
  assert.equal(f.api.status().counters.audioClips, 0);
  assert.equal(f.api.status().counters.errors, 0);
  assert.equal(ctx.state, "suspended", "shared resume must not be closed or suspended by cancellation");
  ctx.state = "running";
  f.resumeAudio();
  const stream = await getStream;
  await settled();
  assert.equal(stream.getAudioTracks()[0].readyState, "live");
  assert.equal(f.api.status().incoming.capturingAudioTracks, 1);
  assert.equal(f.api.status().incoming.capturingVideoTracks, 1);
  assert.equal(f.api.status().counters.audioClips, 1, "only the replacement may start");
  f.nodes.findLast((node) => node.buffer).onended();
  assert.deepEqual(plain(await replacement), { durationMs: 500 });
  assert.equal(f.api.status().counters.completedClips, 1);
});

test("cancellation consistently reports AbortError across microphone-setup microtask races", async (t) => {
  for (const fullStop of [false, true]) {
    for (let turns = 0; turns < 8; turns++) {
      const f = fixture(t);
      const playing = f.api.playAudio({ base64: wav().toString("base64") });
      const rejected = assert.rejects(playing, { name: "AbortError" });
      for (let turn = 0; turn < turns; turn++) await Promise.resolve();
      if (fullStop) f.api.stop();
      else assert.deepEqual(plain(f.api.stopSpeaking()), { stopped: true });
      await rejected;
      await settled();
      assert.equal(f.api.status().microphone.busy, false);
      assert.equal(f.api.status().counters.completedClips, 0);
      assert.equal(f.api.status().counters.errors, 0);
      assert.equal(f.nodes.some((node) => node.buffer), false);
    }
  }
});

test("invalid, compressed, over-duration and oversized clips fail explicitly", async (t) => {
  const f = fixture(t);
  const compressed = wav();
  compressed.writeUInt16LE(3, 20);
  const truncated = wav().subarray(0, 45);
  for (const [base64, mimeType, name] of [
    ["%%not-base64%%", "audio/wav", "DataError"],
    [wav().toString("base64"), "audio/mpeg", "NotSupportedError"],
    [compressed.toString("base64"), "audio/wav", "NotSupportedError"],
    [truncated.toString("base64"), "audio/wav", "DataError"],
    [wav({ durationMs: 30001 }).toString("base64"), "audio/wav", "QuotaExceededError"],
    ["A".repeat(3 * 1024 * 1024), "audio/wav", "QuotaExceededError"],
  ]) {
    await assert.rejects(f.api.playAudio({ base64, mimeType }), { name });
    assert.equal(f.api.status().microphone.busy, false);
  }
  assert.equal(f.contexts.length, 0);
  assert.equal(f.packets("error").length, 6);
  assert.equal(JSON.stringify(f.api.status()).includes("base64"), false);
});

test("native peer construction, subclassing, handlers and close behavior are preserved", async (t) => {
  const f = fixture(t);
  const Wrapped = f.sandbox.RTCPeerConnection;
  assert.equal(Wrapped.prototype, f.Peer.prototype);
  assert.deepEqual(Wrapped.generateCertificate({ name: "test" }), { name: "test" });
  class Derived extends Wrapped {}
  const pc = new Derived({ iceServers: [] });
  assert.ok(pc instanceof Wrapped && pc instanceof f.Peer && pc instanceof Derived);
  assert.deepEqual(pc.configuration, { iceServers: [] });
  let events = 0;
  pc.ontrack = () => events++;
  pc.addEventListener("track", () => events++);
  const incoming = new f.Track("audio");
  pc.receive(incoming);
  assert.equal(events, 2);
  assert.equal(f.api.status().incoming.audioTracks, 1);
  assert.equal(f.contexts.length, 0, "opt-out does not read remote samples");
  const local = await f.sandbox.navigator.mediaDevices.getUserMedia({ video: true });
  pc.receive(local.getVideoTracks()[0]);
  assert.equal(f.api.status().incoming.videoTracks, 0);
  assert.equal(f.api.status().counters.ignoredLocalTracks, 1);
  pc.close();
  assert.equal(pc.signalingState, "closed");
  assert.equal(f.api.status().peerConnections, 0);
  assert.equal(f.api.status().incoming.audioTracks, 0);
  assert.equal(incoming.readyState, "live", "the adapter does not stop native remote tracks");
});

test("incoming audio gates silence and emits bounded 16 kHz mono PCM16 segments", async (t) => {
  const f = fixture(t);
  const pc = new f.sandbox.RTCPeerConnection();
  const audio = new f.Track("audio");
  pc.receive(audio);
  f.api.setCaptureEnabled({ audio: true });
  await settled();
  assert.equal(f.decoders[0].muted, true);
  assert.equal(f.decoders[0].defaultMuted, true);
  assert.equal(f.decoders[0].volume, 0);
  f.feed(2000);
  f.feed(2000, 0.005);
  f.feed(100, 0.2);
  f.feed(1000);
  assert.equal(f.packets("audio").length, 0);
  f.feed(2000, 0.2);
  assert.ok(f.api.status().incoming.rms > 0.1);
  f.feed(1000);
  const [packet] = f.packets("audio");
  assert.ok(packet);
  assert.deepEqual(Object.keys(packet).sort(), ["durationMs", "forced", "mimeType", "rms", "sampleRate", "wavBase64"]);
  assert.equal(packet.forced, false);
  assert.equal(packet.sampleRate, 16000);
  assert.equal(packet.mimeType, "audio/wav");
  assert.ok(packet.rms > 0.1);
  assert.equal(packet.durationMs, 2360);
  const bytes = Buffer.from(packet.wavBase64, "base64");
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  assert.equal(bytes.readUInt16LE(20), 1);
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16000);
  assert.equal(bytes.readUInt16LE(34), 16);
  assert.equal(bytes.length, 44 + packet.durationMs * 32);
  f.api.setCaptureEnabled({ audio: false });
  assert.equal(f.api.status().incoming.capturingAudioTracks, 0);
  assert.equal(audio.readyState, "live");
  assert.equal(f.nodes.some((node) => node.onaudioprocess), false);
  assert.equal(f.decoders[0].paused, true);
  assert.equal(f.decoders[0].srcObject, null);
});

test("continuous audio splits at exactly eight seconds and capture opt-out discards pending speech", async (t) => {
  const f = fixture(t, { options: { captureAudio: true } });
  const pc = new f.sandbox.RTCPeerConnection();
  pc.receive(new f.Track("audio"));
  await settled();
  f.feed(20000, 0.2);
  f.feed(1000);
  const packets = f.packets("audio");
  assert.deepEqual(packets.map(({ durationMs, forced }) => ({ durationMs, forced })), [
    { durationMs: 8000, forced: true }, { durationMs: 8000, forced: true }, { durationMs: 4200, forced: false },
  ]);
  assert.equal(Buffer.from(packets[0].wavBase64, "base64").length, 256044);
  f.feed(500, 0.2);
  f.api.setCaptureEnabled({ audio: false });
  assert.equal(f.packets("audio").length, 3);
  f.api.setCaptureEnabled({ audio: true });
  await settled();
  f.feed(1000);
  assert.equal(f.packets("audio").length, 3);
  f.feed(100, 0.2, 48000);
  assert.equal(f.packets("error").at(-1).code, "incoming-audio");
});

test("remote video is opt-in, muted, latest-only, rate-limited and bounded", async (t) => {
  const f = fixture(t);
  const pc = new f.sandbox.RTCPeerConnection();
  const track = new f.Track("video");
  pc.receive(track);
  assert.equal(f.api.snapshotRemoteVideo(), null);
  assert.equal(f.videos.length, 0);
  f.api.setCaptureEnabled({ video: true });
  await settled();
  assert.equal(f.videos[0].muted, true);
  assert.equal(f.videos[0].volume, 0);
  const first = plain(f.api.snapshotRemoteVideo());
  assert.deepEqual(Object.keys(first).sort(), ["at", "height", "jpegBase64", "width"]);
  assert.deepEqual(plain(f.api.snapshotRemoteVideo()), first);
  assert.equal(f.packets("video").length, 1);
  f.advance(1000);
  assert.equal(f.packets("video").length, 2);
  track.muted = true;
  assert.equal(f.api.snapshotRemoteVideo(), null);
  f.api.setCaptureEnabled({ video: false });
  assert.equal(f.videos[0].srcObject, null);
  assert.equal(f.videos[0].paused, true);
  assert.equal(track.readyState, "live");
});

test("JPEG overflow and track/peer resource overflow emit errors, not fake packets", async (t) => {
  const f = fixture(t, { options: { captureVideo: true }, jpeg: `data:image/jpeg;base64,${"A".repeat(150000)}` });
  const pc = new f.sandbox.RTCPeerConnection();
  pc.receive(new f.Track("video"));
  await settled();
  assert.equal(f.api.snapshotRemoteVideo(), null);
  assert.equal(f.packets("video").length, 0);
  assert.equal(f.packets("error").at(-1).code, "incoming-video");
  for (let index = 0; index < 16; index++) pc.receive(new f.Track("video"));
  assert.equal(f.api.status().incoming.videoTracks, 8);
  assert.equal(f.packets("error").at(-1).code, "remote-track-overflow");
  for (let index = 0; index < 64; index++) new f.sandbox.RTCPeerConnection();
  assert.equal(f.api.status().peerConnections, 64);
  assert.equal(f.packets("error").at(-1).code, "peer-overflow");
});

test("pagehide stops every owned track/connection/timer but leaves native WebRTC ownership alone", async (t) => {
  const f = fixture(t, { options: { captureAudio: true, captureVideo: true } });
  const pc = new f.sandbox.RTCPeerConnection();
  const audio = new f.Track("audio");
  const video = new f.Track("video");
  pc.receive(audio);
  pc.receive(video);
  await settled();
  await f.sandbox.navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  f.feed(500, 0.2);
  f.sandbox.dispatchEvent(new Event("pagehide"));
  const count = f.posts.length;
  f.advance(10000);
  assert.equal(f.posts.length, count);
  assert.equal(f.api.status().state, "stopped");
  assert.equal(f.api.status().incoming.audioTracks, 0);
  assert.equal(f.api.status().incoming.videoTracks, 0);
  assert.equal(f.api.status().peerConnections, 0);
  assert.equal(f.api.snapshotRemoteVideo(), null);
  assert.equal(f.packets("audio").length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.contexts[0].state, "closed");
  assert.equal(f.sandbox.RTCPeerConnection, f.Peer);
  assert.equal(audio.readyState, "live");
  assert.equal(video.readyState, "live");
  assert.equal(pc.signalingState, "stable");
  assert.ok(f.allTracks.filter((track) => track !== audio && track !== video).every((track) => track.readyState === "ended"));
  assert.ok(f.nodes.every((node) => node.connections.size === 0));
  f.api.stop();
  assert.equal(f.posts.length, count, "stop is idempotent");
});
