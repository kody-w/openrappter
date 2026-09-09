/**
 * Explicitly opt-in, entirely local Chromium proof:
 * RAPP_TEAMS_MEDIA_BROWSER_PROOF=1 node --test beta/tests/e2e/teams-virtual-media.e2e.test.mjs
 * RAPP_PLAYWRIGHT_MODULE may point to an already-installed Playwright entry file.
 * All document requests are fulfilled from memory; there are no Teams requests,
 * meeting joins, STUN/TURN servers, hardware capture calls or speaker playback.
 */
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { createTeamsVirtualMediaSource } from "../../electron/teams-virtual-media.mjs";

const enabled = process.env.RAPP_TEAMS_MEDIA_BROWSER_PROOF === "1";
const fixturePath = "/__rapp_local_virtual_media_proof__";
const teamsUrl = `https://teams.microsoft.com${fixturePath}`;
const liveUrl = `https://teams.live.com${fixturePath}`;
const otherUrl = `https://example.test${fixturePath}`;

function guardSource() {
  const evidence = {
    hardwareCalls: [], speakerConnections: 0, contexts: [], connections: new Map(),
    timers: new Set(), packets: [], maxPacketBytes: { status: 0, audio: 0, video: 0, error: 0 },
    NativePeer: window.RTCPeerConnection,
    nativePermissionQuery: navigator.permissions.query.bind(navigator.permissions),
  };
  window.__fixture = evidence;
  const denied = (name) => () => {
    evidence.hardwareCalls.push(name);
    throw new DOMException("Local proof forbids physical capture.", "NotAllowedError");
  };
  for (const name of ["getUserMedia", "getDisplayMedia", "enumerateDevices", "selectAudioOutput"]) {
    Object.defineProperty(navigator.mediaDevices, name, { configurable: true, writable: true, value: denied(name) });
  }
  for (const name of ["getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
    Object.defineProperty(navigator, name, { configurable: true, writable: true, value: denied(name) });
  }
  const NativeAudio = window.AudioContext;
  window.AudioContext = new Proxy(NativeAudio, {
    construct(target, args, newTarget) {
      const context = Reflect.construct(target, args, newTarget);
      evidence.contexts.push(context);
      return context;
    },
  });
  const connect = AudioNode.prototype.connect;
  const disconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.connect = function (target, ...args) {
    if (target === this.context.destination) {
      evidence.speakerConnections++;
      throw new Error("The local proof forbids speaker connections.");
    }
    const result = Reflect.apply(connect, this, [target, ...args]);
    if (!evidence.connections.has(this)) evidence.connections.set(this, new Set());
    evidence.connections.get(this).add(target);
    return result;
  };
  AudioNode.prototype.disconnect = function (...args) {
    const result = Reflect.apply(disconnect, this, args);
    if (args.length === 0) evidence.connections.delete(this);
    else evidence.connections.get(this)?.delete(args[0]);
    return result;
  };
  const nativeInterval = window.setInterval.bind(window);
  const nativeTimeout = window.setTimeout.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  const nativeClearTimeout = window.clearTimeout.bind(window);
  window.setInterval = (callback, ms, ...args) => {
    const id = nativeInterval(callback, ms, ...args);
    evidence.timers.add(id);
    return id;
  };
  window.setTimeout = (callback, ms, ...args) => {
    const id = nativeTimeout(() => {
      evidence.timers.delete(id);
      callback(...args);
    }, ms);
    evidence.timers.add(id);
    return id;
  };
  window.clearInterval = (id) => { evidence.timers.delete(id); nativeClearInterval(id); };
  window.clearTimeout = (id) => { evidence.timers.delete(id); nativeClearTimeout(id); };
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "rapp-teams-media") return;
    const packet = event.data;
    const size = new TextEncoder().encode(JSON.stringify(packet)).byteLength;
    evidence.maxPacketBytes[packet.type] = Math.max(evidence.maxPacketBytes[packet.type], size);
    if (evidence.packets.length >= 100) throw new Error("Local proof packet queue overflow.");
    evidence.packets.push(packet);
  });
}

function createToneWav(durationMs) {
  const rate = 16000;
  const count = Math.round(durationMs * rate / 1000);
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(count * 2, 40);
  for (let index = 0; index < count; index++) bytes.writeInt16LE(Math.round(Math.sin(index * 2 * Math.PI * 440 / rate) * 0.25 * 32767), 44 + index * 2);
  return bytes.toString("base64");
}

async function localDescription(page, kind) {
  return page.evaluate(async (type) => {
    const pc = window.__call;
    await pc.setLocalDescription(type === "offer" ? await pc.createOffer() : await pc.createAnswer());
    if (pc.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pc.removeEventListener("icegatheringstatechange", changed); reject(new Error("Local ICE gathering timed out.")); }, 10000);
      function changed() {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(timer);
          pc.removeEventListener("icegatheringstatechange", changed);
          resolve();
        }
      }
      pc.addEventListener("icegatheringstatechange", changed);
    });
    return pc.localDescription.toJSON();
  }, kind);
}

test("real Chromium proves virtual media with denied hardware and local-only WebRTC", {
  skip: !enabled,
  timeout: 90000,
}, async (t) => {
  const modulePath = process.env.RAPP_PLAYWRIGHT_MODULE;
  const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : "playwright");
  const work = path.resolve(`.teams-local-media-proof-${process.pid}`);
  await mkdir(work);
  const oldTemp = process.env.TMPDIR;
  process.env.TMPDIR = work;
  let context;
  const pages = [];
  try {
    context = await chromium.launchPersistentContext(path.join(work, "profile"), {
      headless: true,
      acceptDownloads: false,
      serviceWorkers: "block",
      args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
    });
    const requested = [];
    await context.route("**/*", async (route) => {
      requested.push(route.request().url());
      if (![teamsUrl, liveUrl, otherUrl].includes(route.request().url())) {
        await route.abort();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: { "Content-Security-Policy": "default-src 'none'; img-src data:; media-src blob:;" },
        body: "<!doctype html><meta charset=utf-8><title>Local media fixture</title><body>LOCAL SYNTHETIC MEDIA ONLY</body>",
      });
    });
    // An empty permission allowlist denies everything, including physical media.
    for (const origin of ["https://teams.microsoft.com", "https://teams.live.com"]) {
      await context.grantPermissions([], { origin });
    }
    const pageErrors = [];
    async function newFixture(adapter, url = teamsUrl) {
      const page = await context.newPage();
      pages.push(page);
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const cdp = await context.newCDPSession(page);
      await cdp.send("Page.enable");
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `;(${guardSource.toString()})();\n${adapter ? createTeamsVirtualMediaSource() : ""}`,
      });
      await page.goto(url);
      assert.equal(await page.evaluate(() => typeof window.__fixture), "object", pageErrors.join("; "));
      return page;
    }
    const page = await newFixture(true);
    const remote = await newFixture(false);
    const deniedPermissions = await page.evaluate(async () => ({
      camera: (await __fixture.nativePermissionQuery({ name: "camera" })).state,
      microphone: (await __fixture.nativePermissionQuery({ name: "microphone" })).state,
      virtual: (await navigator.permissions.query({ name: "microphone" })).state,
    }));
    assert.deepEqual(deniedPermissions, { camera: "denied", microphone: "denied", virtual: "granted" });

    const prejoin = await page.evaluate(async () => {
      const first = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const firstIds = first.getTracks().map((track) => track.id);
      const recursive = first.clone();
      const microphoneClone = recursive.getAudioTracks()[0].clone();
      first.getTracks().forEach((track) => track.stop());
      recursive.getTracks().forEach((track) => track.stop());
      microphoneClone.stop();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: __rappTeamsMedia.status().devices.audioId }, echoCancellation: true },
        video: { deviceId: { exact: __rappTeamsMedia.status().devices.videoId }, width: { exact: 640 }, height: { exact: 360 }, frameRate: { exact: 15 } },
      });
      window.__virtualStream = stream;
      let unknown;
      try { await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: "physical-fixture-forbidden" } } }); }
      catch (error) { unknown = { name: error.name, constraint: error.constraint }; }
      let display;
      try { await navigator.mediaDevices.getDisplayMedia({ video: true }); }
      catch (error) { display = error.name; }
      return {
        actualStream: stream instanceof MediaStream,
        actualTracks: stream.getTracks().every((track) => track instanceof MediaStreamTrack),
        firstStopped: first.getTracks().every((track) => track.readyState === "ended"),
        clonesStopped: recursive.getTracks().every((track) => track.readyState === "ended") && microphoneClone.readyState === "ended",
        live: stream.getTracks().every((track) => track.readyState === "live"),
        independentIds: stream.getTracks().every((track) => !firstIds.includes(track.id)),
        labels: stream.getTracks().map((track) => track.label).sort(),
        video: stream.getVideoTracks()[0].getSettings(),
        devices: (await navigator.mediaDevices.enumerateDevices()).map((device) => device.toJSON()),
        unknown, display,
      };
    });
    assert.equal(prejoin.actualStream && prejoin.actualTracks && prejoin.firstStopped && prejoin.clonesStopped && prejoin.live && prejoin.independentIds, true);
    assert.deepEqual(prejoin.labels, ["r1 Virtual Camera", "r1 Virtual Microphone"]);
    assert.equal(prejoin.video.width, 640);
    assert.equal(prejoin.video.height, 360);
    assert.equal(prejoin.video.frameRate, 15);
    assert.deepEqual(prejoin.devices.map(({ kind }) => kind).sort(), ["audioinput", "videoinput"]);
    assert.deepEqual(prejoin.unknown, { name: "OverconstrainedError", constraint: "deviceId" });
    assert.equal(prejoin.display, "NotAllowedError");

    const selfEcho = await page.evaluate(async () => {
      const sender = new RTCPeerConnection({ iceServers: [] });
      const receiver = new RTCPeerConnection({ iceServers: [] });
      async function describe(pc, kind) {
        await pc.setLocalDescription(kind === "offer" ? await pc.createOffer() : await pc.createAnswer());
        if (pc.iceGatheringState !== "complete") await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Same-document local ICE gathering timed out.")), 10000);
          pc.addEventListener("icegatheringstatechange", function changed() {
            if (pc.iceGatheringState === "complete") {
              clearTimeout(timeout);
              pc.removeEventListener("icegatheringstatechange", changed);
              resolve();
            }
          });
        });
        return pc.localDescription;
      }
      try {
        __virtualStream.getTracks().forEach((track) => sender.addTrack(track, __virtualStream));
        await receiver.setRemoteDescription(await describe(sender, "offer"));
        await sender.setRemoteDescription(await describe(receiver, "answer"));
        return {
          ignored: __rappTeamsMedia.status().counters.ignoredLocalTracks,
          audio: __rappTeamsMedia.status().incoming.audioTracks,
          video: __rappTeamsMedia.status().incoming.videoTracks,
        };
      } finally {
        sender.close();
        receiver.close();
      }
    });
    assert.deepEqual(selfEcho, { ignored: 2, audio: 0, video: 0 });

    const peerSemantics = await page.evaluate(() => {
      class LocalPeer extends RTCPeerConnection {}
      const pc = new LocalPeer({ iceServers: [] });
      window.__call = pc;
      window.__nativeRemoteTracks = [];
      pc.ontrack = (event) => window.__nativeRemoteTracks.push(event.track);
      __virtualStream.getTracks().forEach((track) => pc.addTrack(track, __virtualStream));
      return {
        native: pc instanceof __fixture.NativePeer,
        wrapped: pc instanceof RTCPeerConnection,
        subclass: pc instanceof LocalPeer,
        samePrototype: RTCPeerConnection.prototype === __fixture.NativePeer.prototype,
      };
    });
    assert.deepEqual(peerSemantics, { native: true, wrapped: true, subclass: true, samePrototype: true });
    await remote.evaluate(async () => {
      const context = new AudioContext({ sampleRate: 16000, sinkId: { type: "none" } });
      await context.resume();
      const destination = context.createMediaStreamDestination();
      destination.channelCount = 1;
      const gain = context.createGain();
      gain.gain.value = 0;
      const oscillator = context.createOscillator();
      oscillator.frequency.value = 700;
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      const canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 360;
      const paint = canvas.getContext("2d");
      let frame = 0;
      const draw = () => {
        paint.fillStyle = "#235adf";
        paint.fillRect(0, 0, 640, 360);
        paint.fillStyle = "#ffffff";
        paint.font = "28px sans-serif";
        paint.fillText(`LOCAL REMOTE FIXTURE ${frame++}`, 40, 180);
      };
      draw();
      const timer = setInterval(draw, 1000 / 15);
      const stream = new MediaStream([
        destination.stream.getAudioTracks()[0],
        canvas.captureStream(15).getVideoTracks()[0],
      ]);
      const pc = new RTCPeerConnection({ iceServers: [] });
      window.__call = pc;
      window.__remoteSource = { context, destination, gain, oscillator, timer, stream };
      window.__received = { audio: null, video: null };
      pc.ontrack = async ({ track }) => {
        if (track.kind === "audio") {
          const audio = document.createElement("audio");
          audio.muted = true;
          audio.volume = 0;
          audio.srcObject = new MediaStream([track]);
          await audio.play();
          const source = context.createMediaStreamSource(new MediaStream([track]));
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          const sink = context.createMediaStreamDestination();
          source.connect(analyser);
          analyser.connect(sink);
          __received.audio = { source, analyser, sink, element: audio };
        } else {
          const video = document.createElement("video");
          video.muted = true;
          video.playsInline = true;
          video.srcObject = new MediaStream([track]);
          await video.play();
          __received.video = video;
        }
      };
      window.__receivedLevel = () => {
        if (!__received.audio) return 0;
        const samples = new Float32Array(1024);
        __received.audio.analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      };
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    });
    const offer = await localDescription(page, "offer");
    await remote.evaluate((description) => __call.setRemoteDescription(description), offer);
    const answer = await localDescription(remote, "answer");
    await page.evaluate((description) => __call.setRemoteDescription(description), answer);
    await Promise.all([
      page.waitForFunction(() => __call.connectionState === "connected", null, { timeout: 15000 }),
      remote.waitForFunction(() => __call.connectionState === "connected" && __received.video?.videoWidth > 0, null, { timeout: 15000 }),
    ]);
    const disabled = await page.evaluate(() => ({
      tracks: __nativeRemoteTracks.map((track) => track.kind).sort(),
      status: __rappTeamsMedia.status(), snapshot: __rappTeamsMedia.snapshotRemoteVideo(),
    }));
    assert.deepEqual(disabled.tracks, ["audio", "video"]);
    assert.equal(disabled.status.incoming.audioTracks, 1);
    assert.equal(disabled.status.incoming.videoTracks, 1);
    assert.equal(disabled.status.incoming.capturingAudioTracks, 0);
    assert.equal(disabled.status.incoming.capturingVideoTracks, 0);
    assert.equal(disabled.snapshot, null);
    await remote.waitForFunction(() => __receivedLevel() < 0.005);
    const idleCamera = await remote.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      const paint = canvas.getContext("2d");
      paint.drawImage(__received.video, 0, 0, 640, 360);
      const pixels = paint.getImageData(0, 0, 640, 360).data;
      let bright = 0;
      for (let at = 0; at < pixels.length; at += 4) if (pixels[at] + pixels[at + 1] + pixels[at + 2] > 350) bright++;
      return { width: __received.video.videoWidth, height: __received.video.videoHeight, bright };
    });
    assert.equal(idleCamera.width, 640);
    assert.equal(idleCamera.height, 360);
    assert.ok(idleCamera.bright > 1000, "the slate contains actual decoded pixels");

    await page.evaluate((base64) => {
      window.__clip = null;
      void __rappTeamsMedia.playAudio({ base64 }).then(
        (result) => { __clip = result; }, (error) => { __clip = { error: error.name }; },
      );
    }, createToneWav(1600));
    const busy = await page.evaluate(async () => {
      try { await __rappTeamsMedia.playAudio({ base64: "invalid" }); }
      catch (error) { return error.name; }
    });
    assert.equal(busy, "InvalidStateError");
    await Promise.all([
      page.waitForFunction(() => __rappTeamsMedia.status().microphone.rms > 0.08, null, { timeout: 5000 }),
      remote.waitForFunction(() => __receivedLevel() > 0.04, null, { timeout: 5000 }),
    ]);
    await page.waitForFunction(() => __clip !== null);
    assert.deepEqual(await page.evaluate(() => __clip), { durationMs: 1600 });
    await remote.waitForFunction(() => __receivedLevel() < 0.005);
    assert.equal(await page.evaluate(() => __fixture.packets.filter((packet) => packet.type === "audio").length), 0);

    await page.evaluate(() => __rappTeamsMedia.setCaptureEnabled({ audio: true, video: true }));
    await page.waitForFunction(() => __rappTeamsMedia.status().incoming.capturingAudioTracks === 1
      && __rappTeamsMedia.status().incoming.capturingVideoTracks === 1
      && __fixture.packets.some((packet) => packet.type === "video"));
    await delay(1100);
    assert.equal(await page.evaluate(() => __fixture.packets.filter((packet) => packet.type === "audio").length), 0, "incoming silence never becomes a transcript packet");
    const snapshot = await page.evaluate(async () => {
      const frame = __rappTeamsMedia.snapshotRemoteVideo();
      const same = Array.from({ length: 10 }, () => __rappTeamsMedia.snapshotRemoteVideo().at).every((at) => at === frame.at);
      const image = new Image();
      image.src = `data:image/jpeg;base64,${frame.jpegBase64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = frame.width; canvas.height = frame.height;
      const paint = canvas.getContext("2d");
      paint.drawImage(image, 0, 0);
      return {
        keys: Object.keys(frame).sort(), width: frame.width, height: frame.height,
        bytes: new TextEncoder().encode(JSON.stringify(frame)).byteLength,
        pixel: Array.from(paint.getImageData(10, 10, 1, 1).data),
        same,
      };
    });
    assert.deepEqual(snapshot.keys, ["at", "height", "jpegBase64", "width"]);
    assert.ok(snapshot.bytes <= 128 * 1024);
    assert.equal(snapshot.same, true);
    assert.ok(snapshot.pixel[2] > 150 && snapshot.pixel[0] < 80, "the snapshot is the foreign blue fixture, not our own slate");

    await remote.evaluate(() => __remoteSource.gain.gain.setValueAtTime(0.2, __remoteSource.context.currentTime));
    await page.waitForFunction(() => __rappTeamsMedia.status().incoming.rms > 0.08);
    await delay(1200);
    await remote.evaluate(() => __remoteSource.gain.gain.setValueAtTime(0, __remoteSource.context.currentTime));
    await page.waitForFunction(() => __fixture.packets.some((packet) => packet.type === "audio"));
    const speech = await page.evaluate(() => __fixture.packets.find((packet) => packet.type === "audio").payload);
    assert.deepEqual(Object.keys(speech).sort(), ["durationMs", "forced", "mimeType", "rms", "sampleRate", "wavBase64"]);
    assert.equal(speech.sampleRate, 16000);
    assert.equal(speech.mimeType, "audio/wav");
    assert.equal(speech.forced, false);
    assert.ok(speech.durationMs >= 1000 && speech.durationMs < 3000);
    assert.ok(speech.rms > 0.05);
    const pcm = Buffer.from(speech.wavBase64, "base64");
    assert.equal(pcm.toString("ascii", 0, 4), "RIFF");
    assert.equal(pcm.readUInt32LE(4) + 8, pcm.length);
    assert.equal(pcm.readUInt16LE(20), 1);
    assert.equal(pcm.readUInt16LE(22), 1);
    assert.equal(pcm.readUInt32LE(24), 16000);
    assert.equal(pcm.readUInt16LE(34), 16);
    assert.equal(pcm.length, 44 + speech.durationMs * 32);

    await remote.evaluate(() => __remoteSource.gain.gain.setValueAtTime(0.2, __remoteSource.context.currentTime));
    await page.waitForFunction(() => __fixture.packets.some((packet) => packet.type === "audio" && packet.payload.forced), null, { timeout: 12000 });
    await remote.evaluate(() => __remoteSource.gain.gain.setValueAtTime(0, __remoteSource.context.currentTime));
    const forced = await page.evaluate(() => {
      const packet = __fixture.packets.find((entry) => entry.type === "audio" && entry.payload.forced);
      return { durationMs: packet.payload.durationMs, bytes: new TextEncoder().encode(JSON.stringify(packet)).byteLength, wavBytes: atob(packet.payload.wavBase64).length };
    });
    assert.equal(forced.durationMs, 8000);
    assert.equal(forced.wavBytes, 256044);
    assert.ok(forced.bytes <= 350 * 1024);

    await page.evaluate(() => __rappTeamsMedia.setCaptureEnabled({ audio: false, video: false }));
    const off = await page.evaluate(() => ({ status: __rappTeamsMedia.status(), snapshot: __rappTeamsMedia.snapshotRemoteVideo() }));
    assert.equal(off.status.incoming.capturingAudioTracks, 0);
    assert.equal(off.status.incoming.capturingVideoTracks, 0);
    assert.equal(off.snapshot, null);
    await page.evaluate((base64) => {
      window.__cancelled = null;
      void __rappTeamsMedia.playAudio({ base64 }).catch((error) => { __cancelled = error.name; });
    }, createToneWav(2000));
    await page.waitForFunction(() => __rappTeamsMedia.status().microphone.rms > 0.05);
    await page.evaluate(() => __rappTeamsMedia.stop());
    await page.waitForFunction(() => __cancelled === "AbortError" && __fixture.contexts.every((context) => context.state === "closed"));
    const cleanup = await page.evaluate(async () => {
      let refused;
      try { await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (error) { refused = error.name; }
      return {
        status: __rappTeamsMedia.status(), refused,
        allIssuedEnded: __virtualStream.getTracks().every((track) => track.readyState === "ended"),
        remoteStillOwnedByWebRTC: __nativeRemoteTracks.every((track) => track.readyState === "live"),
        peerState: __call.signalingState,
        peerRestored: RTCPeerConnection === __fixture.NativePeer,
        timers: __fixture.timers.size,
        connections: __fixture.connections.size,
        hardwareCalls: __fixture.hardwareCalls,
        speakerConnections: __fixture.speakerConnections,
        maxPacketBytes: __fixture.maxPacketBytes,
        packetCount: __fixture.packets.length,
        videoTimes: __fixture.packets.filter((packet) => packet.type === "video").map((packet) => packet.payload.at),
      };
    });
    assert.equal(cleanup.status.state, "stopped");
    assert.equal(cleanup.status.peerConnections, 0);
    assert.equal(cleanup.status.incoming.audioTracks, 0);
    assert.equal(cleanup.status.incoming.videoTracks, 0);
    assert.equal(cleanup.refused, "InvalidStateError");
    assert.equal(cleanup.allIssuedEnded && cleanup.remoteStillOwnedByWebRTC && cleanup.peerRestored, true);
    assert.equal(cleanup.peerState, "stable");
    assert.equal(cleanup.timers, 0);
    assert.equal(cleanup.connections, 0);
    assert.deepEqual(cleanup.hardwareCalls, []);
    assert.equal(cleanup.speakerConnections, 0);
    for (let index = 1; index < cleanup.videoTimes.length; index++) assert.ok(cleanup.videoTimes[index] - cleanup.videoTimes[index - 1] >= 1000);
    await delay(1100);
    assert.equal(await page.evaluate(() => __fixture.packets.length), cleanup.packetCount);
    const remoteCleanup = await remote.evaluate(async () => {
      clearInterval(__remoteSource.timer);
      __remoteSource.oscillator.stop();
      __remoteSource.stream.getTracks().forEach((track) => track.stop());
      __received.audio?.sink.stream.getTracks().forEach((track) => track.stop());
      __received.audio?.element.pause();
      if (__received.audio) __received.audio.element.srcObject = null;
      __received.video?.pause();
      if (__received.video) __received.video.srcObject = null;
      __call.close();
      await __remoteSource.context.close();
      return { hardware: __fixture.hardwareCalls, speakers: __fixture.speakerConnections };
    });
    assert.deepEqual(remoteCleanup, { hardware: [], speakers: 0 });

    await page.reload();
    assert.equal(await page.evaluate(() => __rappTeamsMedia.status().audioContextState), "not-created");
    assert.equal(await page.evaluate(() => __rappTeamsMedia.status().state), "ready");
    await page.goto(liveUrl);
    assert.equal(await page.evaluate(() => __rappTeamsMedia.status().state), "ready");
    await page.goto(otherUrl);
    assert.equal(await page.evaluate(() => typeof window.__rappTeamsMedia), "undefined");
    assert.deepEqual(pageErrors, []);
    assert.ok(requested.every((url) => [teamsUrl, liveUrl, otherUrl].includes(url)), "no request escaped the in-memory fixtures");
    t.diagnostic(JSON.stringify({
      physicalPermissions: deniedPermissions,
      actualStreamsAndClones: true, localWebRTC: true, ignoredOwnLoopbackTracks: selfEcho.ignored, syntheticCameraPixels: idleCamera.bright,
      speechDurationMs: speech.durationMs, forcedDurationMs: forced.durationMs,
      maxPacketBytes: cleanup.maxPacketBytes,
      hardwareCalls: 0, speakerConnections: 0, remainingAdapterTimers: 0, remainingAdapterConnections: 0,
    }));
  } catch (error) {
    for (const [index, page] of pages.entries()) {
      if (page.isClosed()) continue;
      const diagnostic = await page.evaluate(async () => ({
        status: window.__rappTeamsMedia?.status(),
        clip: window.__clip,
        contexts: window.__fixture?.contexts.map((context) => ({ state: context.state, currentTime: context.currentTime, sampleRate: context.sampleRate })),
        receivedLevel: window.__receivedLevel?.(),
        rtc: window.__call ? [...(await __call.getStats()).values()].filter((stat) => ["inbound-rtp", "outbound-rtp"].includes(stat.type)).map((stat) => ({
          type: stat.type, kind: stat.kind, bytesReceived: stat.bytesReceived, bytesSent: stat.bytesSent,
          totalAudioEnergy: stat.totalAudioEnergy, audioLevel: stat.audioLevel, packetsReceived: stat.packetsReceived,
        })) : [],
      })).catch(() => ({ diagnostic: "page unavailable" }));
      t.diagnostic(`Local fixture ${index}: ${JSON.stringify(diagnostic)}`);
    }
    throw error;
  } finally {
    for (const page of pages) {
      if (!page.isClosed()) await page.evaluate(() => window.__rappTeamsMedia?.stop()).catch(() => {});
    }
    await context?.close();
    if (oldTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = oldTemp;
    await rm(work, { recursive: true, force: true });
  }
});
