/**
 * Main-world, document-start adapter for an owned Teams window. The host must
 * still deny native media/display permissions, mute the Teams window's own
 * playback, and arrange Web Audio autoplay.
 * Nothing here grants browser/OS permissions, contacts a server, or captures
 * hardware. stop() is terminal until navigation; capture entry points stay
 * fail-closed rather than being restored to physical getUserMedia.
 *
 * window.__rappTeamsMedia:
 *   status() -> JSON-safe health, levels, counters and limits
 *   playAudio({ base64, mimeType = "audio/wav" }) -> Promise<{ durationMs }>
 *     Accepts uncompressed PCM16 WAV (1–2 channels, 8–48 kHz, <=30 s / 2 MiB).
 *     Resolves ONLY on full completion. stopSpeaking()/stop() reject it with
 *     AbortError (interrupted, not completed); concurrent clips still reject.
 *   stopSpeaking() -> { stopped: boolean }
 *     Immediately cancels the active/pending clip only; no-op when idle.
 *     Camera, incoming capture, virtual tracks and shared audio context remain
 *     alive. Already-sent WebRTC audio cannot be recalled.
 *     The host must gate future clips while speaking is disabled.
 *   setCaptureEnabled({ audio?, video? }) -> status (unspecified flags unchanged)
 *   snapshotRemoteVideo() -> null | { jpegBase64, width, height, at }
 *   stop() -> status
 *
 * postMessage to location.origin:
 *   { source: "rapp-teams-media", type: "status"|"audio"|"video"|"error", payload }
 *   status: status(); error: { code, name, message, at } (no native error text)
 *   audio: { wavBase64, mimeType: "audio/wav", sampleRate: 16000,
 *            durationMs, rms, forced } (forced means the 8-second limit)
 *   video: { jpegBase64, width, height, at } (one latest frame, <=1 Hz)
 *
 * status fields (times are epoch milliseconds; RMS is linear, 0–1):
 *   version: 1, identity, state: "ready"|"stopped"|"error", at,
 *   capture: { audio, video }, devices: { audioId, videoId, groupId },
 *   audioContextState: "not-created" or the native AudioContext state,
 *   microphone: { active, tracks, busy, rms },
 *   camera: { active, tracks, width, height, frameRate },
 *   incoming: { audioTracks, videoTracks, capturingAudioTracks,
 *               capturingVideoTracks, rms, lastAudioAt, lastVideoAt },
 *   peerConnections, counters: { requests, rejectedRequests, audioClips,
 *     completedClips, audioSegments, audioSamples, discardedAudioSegments,
 *     videoFrames, ignoredLocalTracks, errors },
 *   limits: { clipBytes, clipMs, audioSegmentMs, audioPacketBytes,
 *     videoPacketBytes, videoIntervalMs, issuedTracks, remoteAudioTracks,
 *     remoteVideoTracks, peerConnections }, lastError: null | error payload.
 *
 * Complete event envelopes are capped at 350 KiB audio, 128 KiB video and
 * 8 KiB status/error. Default devices and ideal constraints select virtual
 * inputs; unknown required device IDs/constraints fail rather than select
 * hardware. Source limits are mono 16 kHz audio and 1280x720@30 canvas video;
 * native canvas track constraints can scale down each independent clone.
 *
 * Remote audio is mixed to mono for local transcription, never to the virtual
 * microphone or speakers. Capture is off by default, and disabling it discards
 * buffered media. RMS gating is not speaker identification or semantic VAD.
 */
export function createTeamsVirtualMediaSource({
  identity = "r1",
  captureAudio = false,
  captureVideo = false,
} = {}) {
  if (typeof identity !== "string" || !identity.trim()
      || typeof captureAudio !== "boolean" || typeof captureVideo !== "boolean") {
    throw new TypeError("Expected a nonempty identity and boolean capture flags.");
  }
  const options = {
    identity: [...identity.replace(/[\u0000-\u001f\u007f]/g, "").trim()].slice(0, 48).join(""),
    captureAudio,
    captureVideo,
  };
  if (!options.identity) throw new TypeError("Identity must contain visible text.");
  const json = JSON.stringify(options).replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `;(${installTeamsVirtualMedia.toString()})(${json});`;
}

function installTeamsVirtualMedia(options) {
  "use strict";
  if (location.protocol !== "https:"
      || !["https://teams.microsoft.com", "https://teams.live.com"].includes(location.origin)
      || Object.prototype.hasOwnProperty.call(window, "__rappTeamsMedia")) return;

  const RATE = 16000;
  const AUDIO_ID = "rapp-teams-virtual-microphone";
  const VIDEO_ID = "rapp-teams-virtual-camera";
  const GROUP_ID = "rapp-teams-virtual";
  const LIMITS = Object.freeze({
    clipBytes: 2 * 1024 * 1024,
    clipMs: 30000,
    audioSegmentMs: 8000,
    audioPacketBytes: 350 * 1024,
    videoPacketBytes: 128 * 1024,
    videoIntervalMs: 1000,
    issuedTracks: 64,
    remoteAudioTracks: 16,
    remoteVideoTracks: 8,
    peerConnections: 64,
  });
  const counters = {
    requests: 0, rejectedRequests: 0, audioClips: 0, completedClips: 0,
    audioSegments: 0, audioSamples: 0, discardedAudioSegments: 0,
    videoFrames: 0, ignoredLocalTracks: 0, errors: 0,
  };
  const capture = { audio: options.captureAudio, video: options.captureVideo };
  const issued = new Set();
  const localTracks = new WeakSet();
  const localIds = new Set();
  const remote = new Map();
  const peers = new Map();
  const permissions = new Map();
  const timers = new Set();
  const waits = new Set();
  const constructors = [];
  let stopped = false;
  let installationFailed = false;
  let lastError = null;
  let context = null;
  let contextReady = null;
  let microphone = null;
  let camera = null;
  let intake = null;
  let playing = null;
  let incomingRms = 0;
  let lastLevelAt = 0;
  let lastAudioAt = null;
  let latestVideo = null;
  let latestVideoTrack = null;
  let lastVideoAttempt = -Infinity;
  let lastStatusAt = -Infinity;
  let frameCanvas = null;
  let sequence = 0;

  const now = () => Date.now();
  const rounded = (value) => Math.round(Math.min(1, Math.max(0, value || 0)) * 10000) / 10000;
  function fault(name, message, constraint) {
    const error = name === "TypeError" ? new TypeError(message) : new DOMException(message, name);
    if (constraint) Object.defineProperty(error, "constraint", { value: constraint });
    return error;
  }
  function active() {
    if (stopped) throw fault("InvalidStateError", "Virtual media has been stopped; reload to restart.");
    if (installationFailed) throw fault("NotSupportedError", "Virtual media installation failed.");
  }
  function packetSize(value) {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }
  function emit(type, payload) {
    const packet = { source: "rapp-teams-media", type, payload };
    const limit = type === "audio" ? LIMITS.audioPacketBytes
      : type === "video" ? LIMITS.videoPacketBytes : 8192;
    if (packetSize(packet) > limit) {
      report("packet-overflow", "QuotaExceededError", "Virtual media packet exceeded its size limit.");
      return false;
    }
    window.postMessage(packet, location.origin);
    return true;
  }
  function report(code, name, message) {
    counters.errors++;
    lastError = { code, name, message, at: now() };
    emit("error", { ...lastError });
  }
  function interval(callback, milliseconds) {
    const id = setInterval(callback, milliseconds);
    timers.add(id);
    return id;
  }
  function clearTimer(id) {
    clearInterval(id);
    clearTimeout(id);
    timers.delete(id);
  }
  function boundedWait(promise, milliseconds) {
    return new Promise((resolve, reject) => {
      const cancel = (error) => {
        clearTimer(id);
        waits.delete(cancel);
        reject(error);
      };
      const id = setTimeout(() => cancel(fault(
        "NotAllowedError", "Web Audio is not running; the owned window needs autoplay or a user gesture.",
      )), milliseconds);
      timers.add(id);
      waits.add(cancel);
      promise.then((value) => {
        clearTimer(id);
        waits.delete(cancel);
        resolve(value);
      }, cancel);
    });
  }
  function rms(samples) {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / (samples.length || 1));
  }
  function outgoingLevel() {
    if (!microphone || context?.state !== "running") return 0;
    microphone.analyser.getFloatTimeDomainData(microphone.levels);
    return rounded(rms(microphone.levels));
  }
  function status() {
    const records = [...remote.values()];
    return {
      version: 1,
      identity: options.identity,
      state: installationFailed ? "error" : stopped ? "stopped" : "ready",
      capture: { ...capture },
      devices: { audioId: AUDIO_ID, videoId: VIDEO_ID, groupId: GROUP_ID },
      audioContextState: context?.state ?? "not-created",
      microphone: {
        active: Boolean(microphone && !stopped),
        tracks: [...issued].filter((track) => track.kind === "audio" && track.readyState === "live").length,
        busy: Boolean(playing),
        rms: outgoingLevel(),
      },
      camera: {
        active: Boolean(camera && !stopped),
        tracks: [...issued].filter((track) => track.kind === "video" && track.readyState === "live").length,
        width: camera?.canvas.width ?? 0,
        height: camera?.canvas.height ?? 0,
        frameRate: camera ? 30 : 0,
      },
      incoming: {
        audioTracks: records.filter((record) => record.track.kind === "audio").length,
        videoTracks: records.filter((record) => record.track.kind === "video").length,
        capturingAudioTracks: records.filter((record) => Boolean(record.node)).length,
        capturingVideoTracks: records.filter((record) => Boolean(record.video)).length,
        rms: capture.audio && now() - lastLevelAt < 300 ? rounded(incomingRms) : 0,
        lastAudioAt,
        lastVideoAt: latestVideo?.at ?? null,
      },
      peerConnections: peers.size,
      counters: { ...counters },
      limits: { ...LIMITS },
      lastError: lastError && { ...lastError },
      at: now(),
    };
  }
  function publishStatus(force = false) {
    if (!force && now() - lastStatusAt < 1000) return;
    lastStatusAt = now();
    emit("status", status());
  }

  async function audioContext() {
    active();
    if (!context) {
      if (typeof window.AudioContext !== "function") {
        throw fault("NotSupportedError", "Web Audio is unavailable.");
      }
      // The silent sink avoids opening an output device on supporting Chromium.
      // No graph in this adapter is ever connected to AudioContext.destination.
      context = new window.AudioContext({
        sampleRate: RATE, latencyHint: "interactive", sinkId: { type: "none" },
      });
      if (context.sampleRate !== RATE) {
        void context.close();
        throw fault("NotSupportedError", "A 16 kHz Web Audio context is required.");
      }
    }
    if (context.state !== "running") {
      if (!contextReady) {
        contextReady = boundedWait(context.resume(), 2000).finally(() => { contextReady = null; });
      }
      await contextReady;
    }
    active();
    if (context.state !== "running") throw fault("NotReadableError", "Web Audio failed to start.");
    return context;
  }
  function rememberLocal(track) {
    localTracks.add(track);
    localIds.add(track.id);
    // Retain a bounded history as a same-document WebRTC echo keeps the sender ID.
    if (localIds.size > 512) localIds.delete(localIds.values().next().value);
  }
  async function ensureMicrophone() {
    const ctx = await audioContext();
    if (microphone) return microphone;
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;
    const input = ctx.createGain();
    input.channelCount = 1;
    input.channelCountMode = "explicit";
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    input.connect(analyser);
    analyser.connect(destination);
    const clock = ctx.createConstantSource();
    clock.offset.value = 0;
    clock.connect(input);
    clock.start();
    microphone = { destination, input, analyser, clock, levels: new Float32Array(1024) };
    destination.stream.getTracks().forEach(rememberLocal);
    return microphone;
  }
  function drawSlate() {
    if (!camera || stopped) return;
    const { canvas, paint } = camera;
    paint.fillStyle = "#0c1729";
    paint.fillRect(0, 0, canvas.width, canvas.height);
    paint.fillStyle = playing ? "#58f5d2" : "#75a7fa";
    paint.beginPath();
    paint.arc(640, 210, 96, 0, Math.PI * 2);
    paint.fill();
    paint.fillStyle = "#0c1729";
    paint.font = "bold 60px sans-serif";
    paint.textAlign = "center";
    paint.fillText("AI", 640, 230);
    paint.fillStyle = "#ffffff";
    paint.font = "bold 64px sans-serif";
    paint.fillText(options.identity, 640, 405, 1120);
    paint.font = "32px sans-serif";
    paint.fillText("AI participant · virtual camera", 640, 470);
    paint.fillStyle = "#bad0ec";
    paint.font = "26px sans-serif";
    paint.fillText(playing ? "Speaking with a synthesized voice" : "Virtual microphone idle · no physical devices", 640, 560);
    paint.fillText(`Local incoming capture: audio ${capture.audio ? "on" : "off"} · video ${capture.video ? "on" : "off"}`, 640, 610);
  }
  function ensureCamera() {
    active();
    if (camera) return camera;
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const paint = canvas.getContext("2d", { alpha: false });
    if (!paint || typeof canvas.captureStream !== "function") {
      throw fault("NotSupportedError", "Canvas virtual camera capture is unavailable.");
    }
    camera = { canvas, paint, stream: null, timer: null };
    try {
      drawSlate();
      camera.stream = canvas.captureStream(30);
      if (camera.stream.getVideoTracks().length !== 1) {
        throw fault("NotReadableError", "Canvas did not produce a video track.");
      }
      camera.stream.getTracks().forEach(rememberLocal);
      camera.timer = interval(drawSlate, 1000 / 30);
      return camera;
    } catch (error) {
      camera.stream?.getTracks().forEach((track) => track.stop());
      camera = null;
      throw error;
    }
  }

  function checkExact(value, allowed, key, bareIsExact = false) {
    const exact = value && typeof value === "object" && !Array.isArray(value)
      ? value.exact : bareIsExact ? value : undefined;
    if (exact === undefined) return;
    const choices = Array.isArray(exact) ? exact : [exact];
    if (!choices.some((choice) => allowed.includes(choice))) {
      throw fault("OverconstrainedError", `The virtual device cannot satisfy ${key}.`, key);
    }
  }
  function fixedConstraint(value, actual, key) {
    checkExact(value, [actual], key);
    if (value && typeof value === "object"
        && ((value.min !== undefined && value.min > actual)
          || (value.max !== undefined && value.max < actual))) {
      throw fault("OverconstrainedError", `The virtual device cannot satisfy ${key}.`, key);
    }
  }
  function normalizeConstraints(value, kind) {
    if (value === true || value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw fault("TypeError", "Media constraints must be booleans or dictionaries.");
    }
    if (JSON.stringify(value).length > 4096) throw fault("TypeError", "Media constraints are too large.");
    const result = {};
    const device = kind === "audio" ? AUDIO_ID : VIDEO_ID;
    const fixed = kind === "audio" ? {
      channelCount: 1, sampleRate: RATE, sampleSize: 16,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    } : { facingMode: "user" };
    for (const [key, setting] of Object.entries(value)) {
      if (key === "deviceId" || key === "groupId") {
        checkExact(setting, key === "deviceId" ? [device, "default", ...(kind === "audio" ? ["communications"] : [])] : [GROUP_ID], key, true);
      } else if (key in fixed) {
        fixedConstraint(setting, fixed[key], key);
      } else if (["width", "height", "frameRate", "aspectRatio", "resizeMode"].includes(key) && kind === "video") {
        result[key] = setting;
      } else if (key === "advanced") {
        if (!Array.isArray(setting) || setting.length > 16) throw fault("TypeError", "Invalid advanced constraints.");
        result.advanced = setting.map((entry) => normalizeConstraints(entry, kind));
      } else if (key === "mandatory" || key === "optional") {
        const entries = key === "optional" ? setting : [setting];
        if (!Array.isArray(entries) || entries.length > 16) throw fault("TypeError", "Invalid legacy constraints.");
        for (const entry of entries) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw fault("TypeError", "Invalid legacy constraints.");
          for (const [legacy, requested] of Object.entries(entry)) {
            if (legacy === "sourceId") checkExact(requested, [device, "default"], "deviceId", true);
            else if (["chromeMediaSource", "chromeMediaSourceId", "mediaSource"].includes(legacy)) {
              throw fault("NotAllowedError", "Display and hardware capture are not available.");
            } else if (key === "mandatory") {
              const match = /^(min|max)(Width|Height|FrameRate)$/.exec(legacy);
              if (match && kind === "video") {
                const modern = match[2][0].toLowerCase() + match[2].slice(1);
                result[modern] = { ...result[modern], [match[1]]: requested };
              } else throw fault("OverconstrainedError", "Unsupported mandatory virtual device constraint.", legacy);
            }
          }
        }
      } else if (["chromeMediaSource", "chromeMediaSourceId", "mediaSource"].includes(key)) {
        throw fault("NotAllowedError", "Display and hardware capture are not available.");
      } else if (setting && typeof setting === "object"
          && ("exact" in setting || "min" in setting || "max" in setting)) {
        throw fault("OverconstrainedError", "Unsupported required virtual device constraint.", key);
      }
    }
    return result;
  }
  function decorateTrack(track, kind, initialConstraints = {}) {
    if (track.readyState === "live" && issued.size >= LIMITS.issuedTracks) {
      track.stop();
      report("virtual-track-overflow", "QuotaExceededError", "Too many active virtual tracks.");
      throw fault("QuotaExceededError", "Too many active virtual tracks.");
    }
    rememberLocal(track);
    if (track.readyState === "live") issued.add(track);
    let constraints = structuredClone(initialConstraints);
    const nativeStop = track.stop.bind(track);
    const nativeClone = track.clone.bind(track);
    const nativeSettings = track.getSettings.bind(track);
    const nativeCapabilities = track.getCapabilities?.bind(track);
    const nativeApply = track.applyConstraints.bind(track);
    const id = kind === "audio" ? AUDIO_ID : VIDEO_ID;
    const fixed = kind === "audio" ? {
      channelCount: 1, sampleRate: RATE, sampleSize: 16,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false,
    } : { facingMode: "user" };
    const end = () => issued.delete(track);
    track.addEventListener("ended", end, { once: true });
    Object.defineProperties(track, {
      label: { get: () => `${options.identity} Virtual ${kind === "audio" ? "Microphone" : "Camera"}` },
      getSettings: { value: () => ({ ...nativeSettings(), ...fixed, deviceId: id, groupId: GROUP_ID }) },
      getCapabilities: { value: () => ({
        ...nativeCapabilities?.(),
        ...Object.fromEntries(Object.entries(fixed).map(([key, value]) => [key,
          typeof value === "number" ? { min: value, max: value } : [value]])),
        deviceId: id, groupId: GROUP_ID,
      }) },
      getConstraints: { value: () => structuredClone(constraints) },
      applyConstraints: { value: async (next = {}) => {
        active();
        const normalized = normalizeConstraints(next, kind);
        await nativeApply(normalized);
        constraints = structuredClone(next);
      } },
      clone: { value: () => {
        active();
        return decorateTrack(nativeClone(), kind, constraints);
      } },
      stop: { value: () => {
        nativeStop();
        track.removeEventListener("ended", end);
        issued.delete(track);
      } },
    });
    return track;
  }
  function virtualStream(tracks) {
    const stream = new MediaStream(tracks);
    Object.defineProperty(stream, "clone", { value: () => {
      const copies = [];
      try {
        for (const track of stream.getTracks()) copies.push(track.clone());
        return virtualStream(copies);
      } catch (error) {
        copies.forEach((track) => track.stop());
        throw error;
      }
    } });
    return stream;
  }
  async function getUserMedia(constraints) {
    counters.requests++;
    const tracks = [];
    try {
      active();
      if (!constraints || typeof constraints !== "object"
          || (!constraints.audio && !constraints.video)) {
        throw fault("TypeError", "Request at least one virtual audio or video track.");
      }
      // Validate both selections before allocating either input.
      const audio = constraints.audio ? normalizeConstraints(constraints.audio, "audio") : null;
      const video = constraints.video ? normalizeConstraints(constraints.video, "video") : null;
      for (const [kind, normalized] of [["audio", audio], ["video", video]]) {
        if (!normalized) continue;
        const source = kind === "audio"
          ? (await ensureMicrophone()).destination.stream.getAudioTracks()[0]
          : ensureCamera().stream.getVideoTracks()[0];
        active();
        const track = decorateTrack(source.clone(), kind, constraints[kind] === true ? {} : constraints[kind]);
        tracks.push(track);
        await track.applyConstraints(constraints[kind] === true ? {} : constraints[kind]);
      }
      active();
      publishStatus();
      return virtualStream(tracks);
    } catch (error) {
      tracks.forEach((track) => track.stop());
      counters.rejectedRequests++;
      if (!stopped) report("get-user-media", error.name, "The requested virtual media stream could not be created.");
      throw error;
    }
  }
  async function enumerateDevices() {
    if (stopped || installationFailed) return [];
    return [["audioinput", AUDIO_ID, "Microphone"], ["videoinput", VIDEO_ID, "Camera"]].map(([kind, deviceId, name]) => {
      const fields = { kind, deviceId, groupId: GROUP_ID, label: `${options.identity} Virtual ${name}` };
      return Object.freeze({ ...fields, toJSON: () => ({ ...fields }) });
    });
  }
  function denyCapture() {
    const error = fault("NotAllowedError", "Only the browser-local virtual camera and microphone are available.");
    if (!stopped) report("capture-denied", error.name, error.message);
    return Promise.reject(error);
  }

  function decodeClip(base64, mimeType) {
    if (!["audio/wav", "audio/x-wav", "audio/wave"].includes(mimeType)) {
      throw fault("NotSupportedError", "Only PCM16 WAV clips are supported.");
    }
    if (typeof base64 !== "string" || !base64.length
        || base64.length > Math.ceil(LIMITS.clipBytes / 3) * 4) {
      throw fault("QuotaExceededError", "The WAV clip is empty or exceeds the input byte limit.");
    }
    if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      throw fault("DataError", "The WAV clip must be canonical base64.");
    }
    const binary = atob(base64);
    if (binary.length > LIMITS.clipBytes) throw fault("QuotaExceededError", "The WAV clip exceeds the input byte limit.");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const tag = (at) => String.fromCharCode(...bytes.subarray(at, at + 4));
    if (bytes.length < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.length) {
      throw fault("DataError", "Invalid RIFF/WAVE container.");
    }
    let format = null;
    let data = null;
    let at = 12;
    for (; at + 8 <= bytes.length;) {
      const size = view.getUint32(at + 4, true);
      const start = at + 8;
      if (start + size > bytes.length) throw fault("DataError", "Truncated WAV chunk.");
      if (tag(at) === "fmt ") {
        if (format || size < 16) throw fault("DataError", "Invalid WAV format chunk.");
        format = {
          encoding: view.getUint16(start, true), channels: view.getUint16(start + 2, true),
          rate: view.getUint32(start + 4, true), byteRate: view.getUint32(start + 8, true),
          align: view.getUint16(start + 12, true), bits: view.getUint16(start + 14, true),
        };
      } else if (tag(at) === "data") {
        if (data) throw fault("DataError", "Multiple WAV data chunks are not supported.");
        data = { start, size };
      }
      at = start + size + (size % 2);
    }
    if (at !== bytes.length) throw fault("DataError", "Invalid WAV chunk padding.");
    if (!format || !data || format.encoding !== 1 || format.bits !== 16
        || ![1, 2].includes(format.channels) || format.rate < 8000 || format.rate > 48000) {
      throw fault("NotSupportedError", "WAV must be PCM16, mono/stereo, at 8–48 kHz.");
    }
    if (!data.size || data.size % (format.channels * 2)
        || format.align !== format.channels * 2 || format.byteRate !== format.rate * format.align) {
      throw fault("DataError", "Invalid WAV sample layout.");
    }
    const frames = data.size / format.align;
    const durationMs = frames / format.rate * 1000;
    if (durationMs > LIMITS.clipMs) throw fault("QuotaExceededError", "The WAV clip exceeds 30 seconds.");
    return { view, ...format, start: data.start, frames, durationMs };
  }
  async function playAudio({ base64, mimeType = "audio/wav" } = {}) {
    active();
    if (playing) {
      report("audio-busy", "InvalidStateError", "The virtual microphone is already playing a clip.");
      throw fault("InvalidStateError", "The virtual microphone is already playing a clip.");
    }
    const job = { source: null, cancel: null, finish: null, cancelled: false, cancellation: null };
    const interrupted = new Promise((_, reject) => {
      job.cancel = (error) => {
        if (job.cancelled) return;
        job.cancelled = true;
        job.cancellation = error;
        if (playing === job) playing = null;
        job.finish?.(error);
        reject(error);
      };
    });
    playing = job;
    try {
      const clip = decodeClip(base64, mimeType);
      // Cancelling a pending clip must not cancel a context resume shared with
      // getUserMedia or incoming capture, nor let that clip start later.
      const mic = await Promise.race([ensureMicrophone(), interrupted]);
      if (playing !== job) throw fault("AbortError", "Virtual microphone playback was cancelled.");
      active();
      const buffer = context.createBuffer(clip.channels, clip.frames, clip.rate);
      for (let channel = 0; channel < clip.channels; channel++) {
        const output = buffer.getChannelData(channel);
        for (let frame = 0; frame < clip.frames; frame++) {
          output[frame] = clip.view.getInt16(clip.start + (frame * clip.channels + channel) * 2, true) / 32768;
        }
      }
      const source = context.createBufferSource();
      job.source = source;
      source.buffer = buffer;
      source.connect(mic.input);
      return await new Promise((resolve, reject) => {
        let finished = false;
        let started = false;
        const finish = (error) => {
          if (finished) return;
          finished = true;
          clearTimer(timeout);
          source.onended = null;
          if (started) source.stop();
          source.disconnect();
          source.buffer = null;
          job.finish = null;
          if (playing === job) playing = null;
          if (error) reject(error);
          else {
            counters.completedClips++;
            resolve({ durationMs: clip.durationMs });
          }
          publishStatus();
        };
        const timeout = setTimeout(() => finish(fault("NotReadableError", "Virtual microphone playback stalled.")), clip.durationMs + 2500);
        timers.add(timeout);
        job.finish = finish;
        source.onended = () => finish();
        try {
          source.start();
          started = true;
          counters.audioClips++;
        } catch (error) {
          finish(error);
        }
        publishStatus();
      });
    } catch (error) {
      if (playing === job) playing = null;
      if (job.source) {
        job.source.onended = null;
        job.source.disconnect();
        job.source.buffer = null;
      }
      if (job.cancelled) throw job.cancellation;
      if (!stopped) report("play-audio", error.name, "The synthesized WAV clip could not be played.");
      throw error;
    }
  }
  function stopSpeaking() {
    if (!playing) return { stopped: false };
    playing.cancel(fault("AbortError", "Virtual microphone playback was cancelled."));
    drawSlate();
    publishStatus();
    return { stopped: true };
  }

  function wavBase64(samples) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const text = (at, value) => [...value].forEach((character, index) => { bytes[at + index] = character.charCodeAt(0); });
    text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE");
    text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, RATE, true);
    view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (let index = 0; index < samples.length; index++) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(44 + index * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
    }
    let binary = "";
    for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
    return btoa(binary);
  }
  function segmenter() {
    const samples = new Float32Array(RATE * 8);
    const frame = new Float32Array(160);
    let pending = 0;
    let length = 0;
    let voiced = 0;
    let quiet = 0;
    let prefix = [];
    const reset = () => {
      pending = 0; length = 0; voiced = 0; quiet = 0; prefix = [];
      samples.fill(0);
      frame.fill(0);
    };
    function flush(forced = false) {
      if (!length) return;
      const end = length - (forced ? 0 : Math.max(0, quiet - RATE * 0.2));
      if (voiced >= RATE * 0.2 && capture.audio && !stopped) {
        const output = samples.subarray(0, end);
        const payload = {
          wavBase64: wavBase64(output), mimeType: "audio/wav", sampleRate: RATE,
          durationMs: end / RATE * 1000, rms: rounded(rms(output)), forced,
        };
        if (emit("audio", payload)) {
          counters.audioSegments++;
          counters.audioSamples += end;
          lastAudioAt = now();
        }
      } else counters.discardedAudioSegments++;
      length = 0; voiced = 0; quiet = 0; prefix = [];
    }
    function consume() {
      const speech = rms(frame) >= 0.012;
      if (!length && !speech) {
        prefix.push(frame.slice());
        if (prefix.length > 16) prefix.shift();
        return;
      }
      if (!length) {
        for (const part of prefix) {
          samples.set(part, length);
          length += part.length;
        }
        prefix = [];
      }
      samples.set(frame, length);
      length += frame.length;
      voiced += speech ? frame.length : 0;
      quiet = speech ? 0 : quiet + frame.length;
      if (length === samples.length) flush(true);
      else if (quiet >= RATE * 0.6) flush(false);
    }
    return {
      reset, flush,
      push(input) {
        for (const sample of input) {
          if (!Number.isFinite(sample)) throw fault("DataError", "Incoming audio contains invalid samples.");
          frame[pending++] = Math.max(-1, Math.min(1, sample));
          if (pending === frame.length) {
            pending = 0;
            consume();
          }
        }
      },
    };
  }
  function ensureIntake() {
    if (intake) return intake;
    if (typeof context.createScriptProcessor !== "function") {
      throw fault("NotSupportedError", "PCM processing is unavailable in this browser.");
    }
    const input = context.createGain();
    input.channelCount = 1;
    input.channelCountMode = "explicit";
    const processor = context.createScriptProcessor(1024, 1, 1);
    const sink = context.createMediaStreamDestination();
    const segments = segmenter();
    input.connect(processor);
    processor.connect(sink);
    intake = { input, processor, sink, segments };
    processor.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0);
      if (stopped || !capture.audio) return;
      try {
        if (event.inputBuffer.sampleRate !== RATE) throw fault("NotSupportedError", "Incoming PCM must be 16 kHz.");
        const input = event.inputBuffer.getChannelData(0);
        incomingRms = rms(input);
        lastLevelAt = now();
        segments.push(input);
      } catch (error) {
        segments.reset();
        report("incoming-audio", error.name, "Incoming audio processing failed.");
      }
    };
    return intake;
  }
  function releaseIntake(flush = false) {
    if (!intake) return;
    if (flush) intake.segments.flush();
    intake.segments.reset();
    intake.processor.onaudioprocess = null;
    intake.input.disconnect();
    intake.processor.disconnect();
    intake.sink.disconnect();
    intake.sink.stream.getTracks().forEach((track) => track.stop());
    intake = null;
    incomingRms = 0;
    lastLevelAt = 0;
  }
  function releaseCapture(record) {
    record.generation++;
    record.node?.disconnect();
    record.node = null;
    for (const key of ["video", "decoder"]) {
      if (record[key]) {
        record[key].pause();
        record[key].srcObject = null;
        record[key].remove();
        record[key] = null;
      }
    }
    record.clone?.stop();
    record.clone = null;
    if (latestVideoTrack === record.track) {
      latestVideo = null;
      latestVideoTrack = null;
    }
  }
  function forgetTrack(track, flush = true) {
    const record = remote.get(track);
    if (!record) return;
    track.removeEventListener("ended", record.ended);
    releaseCapture(record);
    remote.delete(track);
    if (![...remote.values()].some((entry) => entry.node)) releaseIntake(flush);
  }
  async function startCapture(record) {
    const generation = ++record.generation;
    try {
      if (record.track.kind === "audio") await audioContext();
      if (stopped || !capture[record.track.kind] || !remote.has(record.track) || generation !== record.generation) return;
      record.clone = record.track.clone();
      const stream = new MediaStream([record.clone]);
      if (record.track.kind === "audio") {
        const pipeline = ensureIntake();
        record.node = context.createMediaStreamSource(stream);
        record.node.connect(pipeline.input);
        // Chromium needs a media element to pull remote WebRTC audio even when
        // Web Audio consumes it. It stays detached, muted AND at zero volume:
        // only the independent PCM graph above receives the decoded samples.
        const decoder = document.createElement("audio");
        decoder.muted = true;
        decoder.defaultMuted = true;
        decoder.volume = 0;
        decoder.srcObject = stream;
        record.decoder = decoder;
        await decoder.play();
      } else {
        const video = document.createElement("video");
        video.muted = true;
        video.defaultMuted = true;
        video.volume = 0;
        video.playsInline = true;
        video.srcObject = stream;
        record.video = video;
        await video.play();
      }
    } catch (error) {
      if (generation !== record.generation || stopped || !capture[record.track.kind]) return;
      releaseCapture(record);
      if (![...remote.values()].some((entry) => entry.node)) releaseIntake();
      report(`incoming-${record.track.kind}`, error.name, "A remote track could not be captured locally.");
    }
  }
  function receiveTrack(pc, event) {
    const track = event.track;
    if (stopped || !track || !["audio", "video"].includes(track.kind) || track.readyState !== "live") return;
    if (localTracks.has(track) || localIds.has(track.id)
        || [...issued].some((issuedTrack) => issuedTrack.id === track.id)
        || pc.getSenders().some((sender) => sender.track === track)) {
      counters.ignoredLocalTracks++;
      return;
    }
    if (!pc.getReceivers().some((receiver) => receiver.track === track)) return;
    if (remote.has(track)) return;
    const limit = track.kind === "audio" ? LIMITS.remoteAudioTracks : LIMITS.remoteVideoTracks;
    if ([...remote.keys()].filter((entry) => entry.kind === track.kind).length >= limit) {
      report("remote-track-overflow", "QuotaExceededError", "Too many incoming tracks for local capture.");
      return;
    }
    const record = {
      track, pc, generation: 0, sequence: ++sequence,
      clone: null, node: null, video: null, decoder: null, ended: () => forgetTrack(track),
    };
    remote.set(track, record);
    track.addEventListener("ended", record.ended, { once: true });
    if (capture[track.kind]) void startCapture(record);
  }
  function forgetPeer(pc) {
    const record = peers.get(pc);
    if (!record) return;
    pc.removeEventListener("track", record.track);
    pc.removeEventListener("connectionstatechange", record.changed);
    pc.removeEventListener("signalingstatechange", record.changed);
    if (pc.close === record.close) {
      if (record.closeDescriptor) Object.defineProperty(pc, "close", record.closeDescriptor);
      else delete pc.close;
    }
    peers.delete(pc);
    for (const [track, entry] of remote) if (entry.pc === pc) forgetTrack(track, !stopped && capture.audio);
  }
  function observePeer(pc) {
    if (stopped) return;
    if (peers.size >= LIMITS.peerConnections) {
      report("peer-overflow", "QuotaExceededError", "Too many peer connections for local capture.");
      return;
    }
    const close = pc.close;
    const record = {
      track: (event) => receiveTrack(pc, event),
      changed: () => {
        if (pc.connectionState === "closed" || pc.signalingState === "closed") forgetPeer(pc);
      },
      closeDescriptor: Object.getOwnPropertyDescriptor(pc, "close"),
      close: function (...args) {
        try { return Reflect.apply(close, this, args); }
        finally { if (peers.has(this)) forgetPeer(this); }
      },
    };
    peers.set(pc, record);
    pc.addEventListener("track", record.track);
    pc.addEventListener("connectionstatechange", record.changed);
    pc.addEventListener("signalingstatechange", record.changed);
    Object.defineProperty(pc, "close", { configurable: true, writable: true, value: record.close });
  }

  function snapshotRemoteVideo() {
    if (stopped || !capture.video) return null;
    const available = [...remote.values()].filter((entry) => entry.video
      && entry.track.readyState === "live" && !entry.track.muted
      && entry.video.readyState >= 2 && entry.video.videoWidth && entry.video.videoHeight)
      .sort((a, b) => b.sequence - a.sequence);
    if (!available.length) {
      latestVideo = null;
      latestVideoTrack = null;
      return null;
    }
    if (now() - lastVideoAttempt < LIMITS.videoIntervalMs) return latestVideo && { ...latestVideo };
    lastVideoAttempt = now();
    const record = available[0];
    try {
      frameCanvas ??= document.createElement("canvas");
      const scale = Math.min(1, 640 / record.video.videoWidth, 360 / record.video.videoHeight);
      let width = Math.max(1, Math.floor(record.video.videoWidth * scale));
      let height = Math.max(1, Math.floor(record.video.videoHeight * scale));
      for (let attempt = 0; attempt < 5; attempt++) {
        frameCanvas.width = width;
        frameCanvas.height = height;
        const paint = frameCanvas.getContext("2d", { alpha: false });
        if (!paint) throw fault("NotSupportedError", "JPEG canvas is unavailable.");
        paint.drawImage(record.video, 0, 0, width, height);
        const url = frameCanvas.toDataURL("image/jpeg", 0.65);
        if (!url.startsWith("data:image/jpeg;base64,")) throw fault("EncodingError", "JPEG encoding is unavailable.");
        const payload = { jpegBase64: url.slice(23), width, height, at: now() };
        if (packetSize({ source: "rapp-teams-media", type: "video", payload }) <= LIMITS.videoPacketBytes) {
          lastVideoAttempt = payload.at;
          latestVideo = payload;
          latestVideoTrack = record.track;
          counters.videoFrames++;
          emit("video", payload);
          return { ...payload };
        }
        width = Math.max(1, Math.floor(width * 0.7));
        height = Math.max(1, Math.floor(height * 0.7));
      }
      throw fault("QuotaExceededError", "Remote JPEG exceeded its size limit.");
    } catch (error) {
      latestVideo = null;
      latestVideoTrack = null;
      report("incoming-video", error.name, "A bounded remote video frame could not be encoded.");
      return null;
    }
  }
  function setCaptureEnabled(next = {}) {
    active();
    if (!next || typeof next !== "object" || Array.isArray(next)
        || ["audio", "video"].some((key) => next[key] !== undefined && typeof next[key] !== "boolean")) {
      throw fault("TypeError", "Capture flags must be booleans.");
    }
    for (const kind of ["audio", "video"]) {
      if (next[kind] === undefined || next[kind] === capture[kind]) continue;
      capture[kind] = next[kind];
      for (const record of remote.values()) {
        if (record.track.kind !== kind) continue;
        if (capture[kind]) void startCapture(record);
        else releaseCapture(record);
      }
      if (kind === "audio" && !capture.audio) releaseIntake();
      if (kind === "video" && !capture.video) {
        latestVideo = null;
        latestVideoTrack = null;
        frameCanvas = null;
      }
    }
    publishStatus();
    return status();
  }
  function stop() {
    if (stopped) return status();
    stopped = true;
    capture.audio = false;
    capture.video = false;
    playing?.cancel?.(fault("AbortError", "Virtual microphone playback was stopped."));
    playing = null;
    for (const cancel of waits) cancel(fault("AbortError", "Virtual media was stopped."));
    for (const timer of timers) clearTimer(timer);
    for (const pc of peers.keys()) forgetPeer(pc);
    for (const track of remote.keys()) forgetTrack(track, false);
    releaseIntake();
    for (const track of issued) track.stop();
    issued.clear();
    localIds.clear();
    if (microphone) {
      microphone.clock.stop();
      for (const node of [microphone.clock, microphone.input, microphone.analyser, microphone.destination]) node.disconnect();
      microphone.destination.stream.getTracks().forEach((track) => track.stop());
      microphone = null;
    }
    if (camera) {
      camera.stream.getTracks().forEach((track) => track.stop());
      camera.canvas.width = 0;
      camera.canvas.height = 0;
      camera = null;
    }
    frameCanvas = null;
    latestVideo = null;
    latestVideoTrack = null;
    if (context && context.state !== "closed") void context.close().catch(() => {
      report("audio-close", "NotReadableError", "The virtual audio context could not be closed.");
    });
    for (const [name, original, wrapped] of constructors) if (window[name] === wrapped) window[name] = original;
    for (const permission of permissions.values()) permission.dispatchEvent(new Event("change"));
    window.removeEventListener("pagehide", stop);
    publishStatus(true);
    return status();
  }

  Object.defineProperty(window, "__rappTeamsMedia", {
    value: Object.freeze({ status, playAudio, stopSpeaking, setCaptureEnabled, snapshotRemoteVideo, stop }),
  });
  try {
    const devices = navigator.mediaDevices;
    if (!devices) throw fault("NotSupportedError", "MediaDevices is unavailable.");
    const install = (target, name, value) => Object.defineProperty(target, name, { configurable: true, writable: true, value });
    install(devices, "getUserMedia", getUserMedia);
    install(devices, "enumerateDevices", enumerateDevices);
    install(devices, "getDisplayMedia", denyCapture);
    if ("selectAudioOutput" in devices) install(devices, "selectAudioOutput", denyCapture);
    for (const alias of ["getUserMedia", "webkitGetUserMedia", "mozGetUserMedia"]) {
      install(navigator, alias, (constraints, success, failure) => {
        if (typeof success !== "function" || typeof failure !== "function") throw fault("TypeError", "Legacy capture requires success and failure callbacks.");
        void getUserMedia(constraints).then(success, failure);
      });
    }
    if (navigator.permissions?.query) {
      const originalQuery = navigator.permissions.query.bind(navigator.permissions);
      class VirtualPermissionStatus extends EventTarget {
        constructor(name) { super(); this.permissionName = name; this.handler = null; }
        get name() { return this.permissionName; }
        get state() { return stopped || installationFailed ? "denied" : "granted"; }
        get [Symbol.toStringTag]() { return "PermissionStatus"; }
        get onchange() { return this.handler; }
        set onchange(value) {
          if (this.handler) this.removeEventListener("change", this.handler);
          this.handler = typeof value === "function" ? value : null;
          if (this.handler) this.addEventListener("change", this.handler);
        }
      }
      install(navigator.permissions, "query", async (descriptor) => {
        if (!["camera", "microphone"].includes(descriptor?.name)) return originalQuery(descriptor);
        if (!permissions.has(descriptor.name)) permissions.set(descriptor.name, new VirtualPermissionStatus(descriptor.name));
        return permissions.get(descriptor.name);
      });
    }
    for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection"]) {
      const Original = window[name];
      if (typeof Original !== "function") continue;
      const Wrapped = new Proxy(Original, {
        construct(target, args, newTarget) {
          const pc = Reflect.construct(target, args, newTarget);
          try { observePeer(pc); }
          catch (error) {
            forgetPeer(pc);
            report("peer-observer", error.name, "A peer connection could not be observed for local capture.");
          }
          return pc;
        },
      });
      constructors.push([name, Original, Wrapped]);
      window[name] = Wrapped;
    }
    if (!constructors.length) throw fault("NotSupportedError", "WebRTC is unavailable.");
    window.addEventListener("pagehide", stop, { once: true });
    interval(() => {
      for (const [track, record] of remote) {
        if (track.readyState === "ended" || record.pc.signalingState === "closed") forgetTrack(track);
      }
      snapshotRemoteVideo();
      publishStatus();
    }, 1000);
    publishStatus(true);
  } catch (error) {
    installationFailed = true;
    report("installation", error.name, "Virtual media could not be installed; native permissions must remain denied.");
    stop();
  }
}
