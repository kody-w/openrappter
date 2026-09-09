import { fork, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEETING_SPEECH_MODEL = Object.freeze({
  backend: "transformers.js",
  dependency: "@huggingface/transformers",
  version: "4.2.0",
  id: "Xenova/whisper-small",
  revision: "2d67713f236afa48a18992566e7647f6ca848e13",
  dtype: "q8",
  device: "cpu",
  language: "en",
});

export const MEETING_SPEECH_FILES = Object.freeze([
  ["config.json", 2232, "5a6429d21d7a3379dd0861b74510f9f7076f32b563bffc9fcb072482d55ab3be"],
  ["generation_config.json", 3837, "0b7407a4e53a677f826e03c75d409e6f830663932bf43dda3b08c5efa2223279"],
  ["preprocessor_config.json", 339, "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d"],
  ["tokenizer.json", 2480466, "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566"],
  ["tokenizer_config.json", 282683, "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce"],
  ["onnx/encoder_model_quantized.onnx", 92324809, "969f5ac12974340386bf7a02ea6626003e5e2dee396ffc6ab0eec282bf55ba06"],
  ["onnx/decoder_model_merged_quantized.onnx", 156780950, "fcfc6100dc7339e7507e10f8b274350be7c4f8d8b575f0293f94cc0e156d6d24"],
].map(([file, size, sha256]) => Object.freeze({ file, size, sha256 })));

export const MEETING_SPEECH_LIMITS = Object.freeze({
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
  maxSeconds: 8,
  maxPcmBytes: 256_000,
  maxWavBytes: 260_096,
  maxTextCharacters: 240,
  maxTextBytes: 960,
  maxTranscriptCharacters: 4_096,
  maxConcurrentOperations: 1,
  maxQueuedOperations: 0,
});

const VOICE = "Samantha";
const SAY = "/usr/bin/say";
const WORKER_ARGUMENT = "--teams-local-speech-worker";
const DEFAULT_TIMEOUTS = Object.freeze({
  prepareMs: 900_000,
  synthesizeMs: 20_000,
  transcribeMs: 90_000,
  killGraceMs: 250,
  killWaitMs: 2_000,
});
const ERRORS = Object.freeze({
  SPEECH_UNSUPPORTED_PLATFORM: "Local meeting speech currently requires macOS with the installed Samantha voice.",
  SPEECH_DIRECTORY_REQUIRED: "Provide an absolute, private directory for local speech models and transient media.",
  SPEECH_DIRECTORY_UNSAFE: "The speech directory and its models directory must be real, private directories (mode 0700), not symbolic links.",
  SPEECH_DIRECTORY_IO: "Cannot create or access the private local speech directory.",
  SPEECH_NOT_READY: "Local speech is not ready. Explicitly call prepare() before using speech.",
  SPEECH_CLOSED: "The local speech service is closed.",
  SPEECH_BUSY: "Local speech is busy. Retry after the current operation; audio is not queued.",
  SPEECH_INVALID_SIGNAL: "signal must be an AbortSignal.",
  SPEECH_ABORTED: "The local speech operation was cancelled.",
  SPEECH_TIMEOUT: "The local speech operation exceeded its time limit.",
  SPEECH_INVALID_TEXT: "Speech text must contain 1–240 plain-text characters, at most 960 UTF-8 bytes, and no control characters or say directives.",
  SPEECH_INVALID_WAV: "Audio must be a complete RIFF WAVE with one PCM16, 16-kHz, mono fmt/data pair and consistent lengths.",
  SPEECH_AUDIO_TOO_LARGE: "Audio exceeds 8 seconds, 256000 PCM bytes, or the 4096-byte WAV metadata allowance.",
  SPEECH_SYNTHESIS_MISSING: "The local /usr/bin/say executable is unavailable.",
  SPEECH_VOICE_MISSING: "The installed Samantha en_US voice is required; no other voice or cloud fallback is used.",
  SPEECH_SYNTHESIS_FAILED: "Local file-only speech synthesis failed; no playback or alternate speech service was attempted.",
  SPEECH_DEPENDENCY_MISSING: "Install @huggingface/transformers exactly 4.2.0 with --ignore-scripts, including its supported onnxruntime-node binaries.",
  SPEECH_DEPENDENCY_VERSION: "Local speech requires @huggingface/transformers exactly 4.2.0.",
  SPEECH_MODEL_NOT_PREPARED: "The pinned local Whisper model is missing or unusable offline. Explicitly prepare it with downloads enabled.",
  SPEECH_MODEL_INTEGRITY: "A public Whisper model download failed its pinned size or SHA-256 check.",
  SPEECH_MODEL_CACHE_UNSAFE: "The model cache must contain regular files and directories, not symbolic links.",
  SPEECH_MODEL_DOWNLOAD_FAILED: "A public pinned Whisper model file could not be downloaded. No audio was sent.",
  SPEECH_RECOGNITION_LOAD_FAILED: "Cannot load the pinned local Whisper model. Check the public model download, private cache, and native ONNX runtime.",
  SPEECH_RECOGNITION_FAILED: "Local Whisper inference failed; no remote transcription was attempted.",
  SPEECH_RECOGNITION_RESULT: "Local Whisper returned an invalid or oversized transcript.",
  SPEECH_CHILD_FAILED: "The owned local recognition process exited or its IPC channel failed. Call prepare() to restart it.",
  SPEECH_CLEANUP_FAILED: "Cannot finish stopping an owned speech process or removing its private media. The service is not ready.",
  SPEECH_FILE_IO: "Cannot safely read or remove the private synthesized WAV.",
  SPEECH_NETWORK_DISABLED: "Only public pinned model GET requests during explicit preparation are allowed.",
});

export class MeetingSpeechError extends Error {
  constructor(code) {
    const known = Object.hasOwn(ERRORS, code) ? code : "SPEECH_CHILD_FAILED";
    super(ERRORS[known]);
    this.code = known;
    this.name = known === "SPEECH_ABORTED" ? "AbortError"
      : known === "SPEECH_TIMEOUT" ? "TimeoutError" : "MeetingSpeechError";
  }
}

const failure = (code) => new MeetingSpeechError(code);
const safeError = (error, fallback) => error instanceof MeetingSpeechError
  ? failure(error.code) : failure(fallback);
const describeError = (error) => ({ code: error.code, message: ERRORS[error.code] });

function checkSignal(signal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw failure("SPEECH_INVALID_SIGNAL");
  }
  if (signal?.aborted) throw failure("SPEECH_ABORTED");
}

function checkCancelled(signal) {
  if (signal.aborted) {
    throw safeError(signal.reason, "SPEECH_ABORTED");
  }
}

function plainText(text) {
  if (typeof text !== "string" ||
      text.length > MEETING_SPEECH_LIMITS.maxTextCharacters ||
      Buffer.byteLength(text, "utf8") > MEETING_SPEECH_LIMITS.maxTextBytes ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\[\[|\]\]/u.test(text)) {
    throw failure("SPEECH_INVALID_TEXT");
  }
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(normalized)) throw failure("SPEECH_INVALID_TEXT");
  return normalized;
}

function parseWav(wav) {
  if (!Buffer.isBuffer(wav) || wav.length < 44) throw failure("SPEECH_INVALID_WAV");
  if (wav.length > MEETING_SPEECH_LIMITS.maxWavBytes) {
    throw failure("SPEECH_AUDIO_TOO_LARGE");
  }
  if (wav.toString("latin1", 0, 4) !== "RIFF" ||
      wav.toString("latin1", 8, 12) !== "WAVE" ||
      wav.readUInt32LE(4) + 8 !== wav.length) {
    throw failure("SPEECH_INVALID_WAV");
  }
  let format = false;
  let pcm = null;
  for (let offset = 12; offset < wav.length;) {
    if (offset + 8 > wav.length) throw failure("SPEECH_INVALID_WAV");
    const id = wav.toString("latin1", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    const paddedEnd = end + (size % 2);
    if (paddedEnd > wav.length) throw failure("SPEECH_INVALID_WAV");
    if (id === "fmt ") {
      if (format || pcm !== null || (size !== 16 && size !== 18) ||
          (size === 18 && wav.readUInt16LE(start + 16) !== 0) ||
          wav.readUInt16LE(start) !== 1 ||
          wav.readUInt16LE(start + 2) !== 1 ||
          wav.readUInt32LE(start + 4) !== 16_000 ||
          wav.readUInt32LE(start + 8) !== 32_000 ||
          wav.readUInt16LE(start + 12) !== 2 ||
          wav.readUInt16LE(start + 14) !== 16) {
        throw failure("SPEECH_INVALID_WAV");
      }
      format = true;
    } else if (id === "data") {
      if (!format || pcm !== null || size % 2) throw failure("SPEECH_INVALID_WAV");
      if (size > MEETING_SPEECH_LIMITS.maxPcmBytes) {
        throw failure("SPEECH_AUDIO_TOO_LARGE");
      }
      pcm = wav.subarray(start, end);
    }
    offset = paddedEnd;
  }
  if (!format || pcm === null) throw failure("SPEECH_INVALID_WAV");
  if (wav.length - pcm.length > 4_096) throw failure("SPEECH_AUDIO_TOO_LARGE");
  return pcm;
}

function canonicalWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function transcript(result) {
  if (!result || typeof result.text !== "string" ||
      result.text.length > MEETING_SPEECH_LIMITS.maxTranscriptCharacters) {
    throw failure("SPEECH_RECOGNITION_RESULT");
  }
  const text = result.text.replace(
    /<\|nospeech\|>|\[(?:blank_audio|silence|no speech|inaudible|music|noise)\]/giu,
    " ",
  ).replace(/\s+/gu, " ").trim();
  return { text };
}

function progressSnapshot(progress) {
  const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value : null;
  const percent = finite(progress?.percent ?? progress?.progress);
  return {
    scope: "current-file",
    percent: percent === null ? null : Math.min(100, percent),
    loadedBytes: finite(progress?.loadedBytes ?? progress?.loaded),
    totalBytes: finite(progress?.totalBytes ?? progress?.total),
  };
}

async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077)) {
    throw failure("SPEECH_DIRECTORY_UNSAFE");
  }
}

function waitForExit(record, milliseconds) {
  if (record.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds);
    record.closed.then(() => { clearTimeout(timer); resolve(true); });
  });
}

function modelManifest(files) {
  if (!Array.isArray(files) || files.length !== MEETING_SPEECH_FILES.length ||
      !files.every((entry, index) => entry?.file === MEETING_SPEECH_FILES[index].file &&
        Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= MEETING_SPEECH_FILES[index].size &&
        typeof entry.sha256 === "string" && /^[a-f0-9]{64}$/u.test(entry.sha256))) {
    throw new TypeError("Invalid speech model manifest.");
  }
  return files.map(({ file, size, sha256 }) => ({ file, size, sha256 }));
}

async function cachedModelFile(file, pin, signal) {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) throw failure("SPEECH_MODEL_CACHE_UNSAFE");
    if (info.size !== pin.size) return false;
    const hash = createHash("sha256");
    for await (const data of handle.createReadStream({ autoClose: false, end: pin.size - 1 })) {
      checkCancelled(signal);
      hash.update(data);
    }
    return hash.digest("hex") === pin.sha256;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw safeError(error, "SPEECH_MODEL_CACHE_UNSAFE");
  } finally { await handle?.close(); }
}

async function prepareModelFiles(directory, files, { allowDownload, download, progress, signal }) {
  let root = directory;
  for (const segment of [...MEETING_SPEECH_MODEL.id.split("/"), MEETING_SPEECH_MODEL.revision, "onnx"]) {
    root = path.join(root, segment);
    try { await mkdir(root, { mode: 0o700 }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw failure("SPEECH_MODEL_CACHE_UNSAFE");
  }
  root = path.dirname(root);
  const prefix = `https://huggingface.co/${MEETING_SPEECH_MODEL.id}/resolve/${MEETING_SPEECH_MODEL.revision}/`;
  for (const pin of files) {
    checkCancelled(signal);
    const file = path.join(root, pin.file);
    if (await cachedModelFile(file, pin, signal)) continue;
    if (!allowDownload) throw failure("SPEECH_MODEL_NOT_PREPARED");
    const partial = `${file}.download-${randomUUID()}`;
    let handle;
    try {
      handle = await open(partial, "wx", 0o600);
      const response = await download(prefix + pin.file);
      if (!response.ok || !response.body) throw failure("SPEECH_MODEL_DOWNLOAD_FAILED");
      const hash = createHash("sha256");
      let loaded = 0;
      for await (const data of response.body) {
        checkCancelled(signal);
        loaded += data.length;
        if (loaded > pin.size) throw failure("SPEECH_MODEL_INTEGRITY");
        hash.update(data);
        await handle.writeFile(data);
        progress({ loaded, total: pin.size, progress: loaded / pin.size * 100 });
      }
      if (loaded !== pin.size || hash.digest("hex") !== pin.sha256) throw failure("SPEECH_MODEL_INTEGRITY");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(partial, file);
    } finally {
      await handle?.close();
      await unlink(partial).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
  }
  return root;
}

/**
 * No work, downloads, or capture occurs at construction. prepare() is the only
 * download opt-in; TEAMS_LOCAL_SPEECH_OFFLINE=1 also makes preparation cache-only.
 * Supply a dedicated 0700 directory. There is one operation slot and no queue.
 * forkImpl/spawnImpl/platform/timeouts/transformersModule/modelFiles are
 * test/proof seams, not renderer-controlled configuration.
 */
export function createMeetingSpeech({
  directory,
  env = process.env,
  onState,
  platform = process.platform,
  spawnImpl = spawn,
  forkImpl = fork,
  timeouts = {},
  transformersModule,
  modelFiles = MEETING_SPEECH_FILES,
} = {}) {
  const pinnedFiles = modelManifest(modelFiles);
  const limits = { ...DEFAULT_TIMEOUTS, ...timeouts };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("Invalid speech timeout.");
  }
  const initialError = platform !== "darwin" ? failure("SPEECH_UNSUPPORTED_PLATFORM")
    : typeof directory !== "string" || !path.isAbsolute(directory) || path.parse(directory).root === directory
      ? failure("SPEECH_DIRECTORY_REQUIRED") : null;
  const allowDownload = env.TEAMS_LOCAL_SPEECH_OFFLINE !== "1";
  const children = new Set();
  const artifacts = new Set();
  let mediaDirectory = null;
  let modelsDirectory = null;
  let recognition = null;
  let synthesisReady = false;
  let recognitionReady = false;
  let active = null;
  let closed = false;
  let closing = null;
  let cleanupFailed = false;
  let requestId = 0;
  let current = {
    state: initialError?.code === "SPEECH_UNSUPPORTED_PLATFORM" ? "unavailable" : "missing-prerequisite",
    ready: false,
    busy: false,
    phase: "idle",
    localOnly: true,
    downloadsAllowedDuringPrepare: allowDownload,
    synthesis: { state: "unchecked", backend: "macos-say", voice: VOICE },
    recognition: { state: "unprepared", ...MEETING_SPEECH_MODEL },
    limits: { ...MEETING_SPEECH_LIMITS },
    progress: null,
    error: initialError ? describeError(initialError) : null,
  };
  const status = () => structuredClone(current);
  function update(patch) {
    current = { ...current, ...patch };
    try { onState?.(status()); } catch { /* An observer cannot break media cleanup. */ }
  }
  function childEnv() {
    return {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: mediaDirectory,
      TMPDIR: mediaDirectory,
      LANG: "en_US.UTF-8",
      ELECTRON_RUN_AS_NODE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1",
      OMP_NUM_THREADS: "2",
    };
  }
  function track(child) {
    const record = { child, exited: false, stopping: false, stoppingPromise: null };
    record.closed = new Promise((resolve) => {
      child.once("close", () => {
        record.exited = true;
        children.delete(record);
        resolve();
      });
    });
    child.on("error", () => {});
    children.add(record);
    return record;
  }
  function terminate(record) {
    if (record.exited) return Promise.resolve();
    if (record.stoppingPromise) return record.stoppingPromise;
    record.stopping = true;
    record.stoppingPromise = (async () => {
      try { record.child.kill("SIGTERM"); } catch { /* Escalate only this owned child. */ }
      if (await waitForExit(record, limits.killGraceMs)) return;
      try { record.child.kill("SIGKILL"); } catch { /* Still require a confirmed exit. */ }
      if (!await waitForExit(record, limits.killWaitMs)) {
        cleanupFailed = true;
        throw failure("SPEECH_CLEANUP_FAILED");
      }
    })();
    return record.stoppingPromise;
  }
  async function stopRecognition() {
    recognitionReady = false;
    if (recognition) await terminate(recognition);
  }
  async function removeArtifact(file) {
    if (!artifacts.has(file)) return;
    try { await unlink(file); } catch (error) {
      if (error.code !== "ENOENT") {
        cleanupFailed = true;
        throw failure("SPEECH_CLEANUP_FAILED");
      }
    }
    artifacts.delete(file);
  }
  async function initializeDirectories(signal) {
    try {
      await privateDirectory(directory);
      checkCancelled(signal);
      modelsDirectory = path.join(directory, "models");
      await privateDirectory(modelsDirectory);
      checkCancelled(signal);
      if (!mediaDirectory) {
        const candidate = path.join(directory, `media-${randomUUID()}`);
        await mkdir(candidate, { mode: 0o700 });
        mediaDirectory = candidate;
      }
      checkCancelled(signal);
    } catch (error) {
      throw safeError(error, "SPEECH_DIRECTORY_IO");
    }
  }
  function runSay(args, signal, { text, output } = {}) {
    checkCancelled(signal);
    let record;
    try {
      record = track(spawnImpl(SAY, args, {
        cwd: mediaDirectory,
        env: childEnv(),
        shell: false,
        windowsHide: true,
        stdio: [text === undefined ? "ignore" : "pipe", output ? "ignore" : "pipe", "ignore"],
      }));
    } catch (error) {
      throw failure(error.code === "ENOENT" ? "SPEECH_SYNTHESIS_MISSING" : "SPEECH_SYNTHESIS_FAILED");
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let monitoring = false;
      let bytes = 0;
      const chunks = [];
      const child = record.child;
      const cleanup = () => {
        clearInterval(monitor);
        signal.removeEventListener("abort", abort);
        child.removeListener("close", exited);
        child.removeListener("error", errored);
        child.stdout?.removeListener("data", received);
      };
      const fail = async (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { await terminate(record); } catch { error = failure("SPEECH_CLEANUP_FAILED"); }
        reject(error);
      };
      const abort = () => { void fail(safeError(signal.reason, "SPEECH_ABORTED")); };
      const errored = (error) => {
        void fail(failure(error.code === "ENOENT" ? "SPEECH_SYNTHESIS_MISSING" : "SPEECH_SYNTHESIS_FAILED"));
      };
      const received = (chunk) => {
        bytes += chunk.length;
        if (bytes > 131_072) void fail(failure("SPEECH_SYNTHESIS_FAILED"));
        else chunks.push(Buffer.from(chunk));
      };
      const exited = (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (signal.aborted) reject(safeError(signal.reason, "SPEECH_ABORTED"));
        else if (code !== 0) reject(failure("SPEECH_SYNTHESIS_FAILED"));
        else resolve(Buffer.concat(chunks));
      };
      const monitor = output ? setInterval(async () => {
        if (monitoring || settled) return;
        monitoring = true;
        try {
          if ((await stat(output)).size > MEETING_SPEECH_LIMITS.maxWavBytes) {
            await fail(failure("SPEECH_AUDIO_TOO_LARGE"));
          }
        } catch { if (!settled) await fail(failure("SPEECH_FILE_IO")); }
        finally { monitoring = false; }
      }, 25) : null;
      child.on("error", errored);
      child.on("close", exited);
      child.stdout?.on("data", received);
      signal.addEventListener("abort", abort, { once: true });
      if (text !== undefined) {
        child.stdin.on("error", () => { void fail(failure("SPEECH_SYNTHESIS_FAILED")); });
        try { child.stdin.end(`${text}\n`, "utf8"); } catch (error) { errored(error); }
      }
      if (signal.aborted) abort();
    });
  }
  async function synthesizeFile(text, signal) {
    const output = path.join(mediaDirectory, `speech-${randomUUID()}.wav`);
    try {
      checkCancelled(signal);
      const created = await open(output, "wx", 0o600);
      artifacts.add(output);
      await created.close();
      checkCancelled(signal);
      await runSay([
        "-v", VOICE, "-r", "180", "--file-format=WAVE",
        "--data-format=LEI16@16000", "--channels=1", "-o", output, "-f", "-",
      ], signal, { text, output });
      checkCancelled(signal);
      const file = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile()) throw failure("SPEECH_FILE_IO");
        if (info.size > MEETING_SPEECH_LIMITS.maxWavBytes) throw failure("SPEECH_AUDIO_TOO_LARGE");
        const wav = await file.readFile();
        checkCancelled(signal);
        return { wav: canonicalWav(parseWav(wav)), mimeType: "audio/wav" };
      } finally { await file.close(); }
    } catch (error) {
      throw safeError(error, "SPEECH_FILE_IO");
    } finally {
      // Never unlink an output that a child failed to stop writing.
      if (![...children].some((record) => record.stopping && !record.exited)) {
        await removeArtifact(output);
      }
    }
  }
  function startRecognition() {
    let record;
    try {
      record = track(forkImpl(fileURLToPath(import.meta.url), [WORKER_ARGUMENT], {
        cwd: mediaDirectory,
        env: { ...childEnv(), TEAMS_LOCAL_SPEECH_WORKER: "1" },
        execArgv: [],
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      }));
    } catch { throw failure("SPEECH_CHILD_FAILED"); }
    recognition = record;
    record.child.once("close", () => {
      if (recognition !== record) return;
      recognition = null;
      recognitionReady = false;
      if (!record.stopping && !closed) {
        update({
          state: "error", ready: false,
          recognition: { ...current.recognition, state: "error" },
          error: describeError(failure("SPEECH_CHILD_FAILED")),
        });
      }
    });
    return record;
  }
  function requestRecognition(type, payload, signal) {
    checkCancelled(signal);
    const record = recognition || (type === "prepare" ? startRecognition() : null);
    if (!record || record.exited) throw failure("SPEECH_CHILD_FAILED");
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = record.child;
      const cleanup = () => {
        child.removeListener("message", message);
        child.removeListener("error", errored);
        child.removeListener("close", errored);
        signal.removeEventListener("abort", abort);
      };
      const fail = async (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        recognitionReady = false;
        try { await terminate(record); } catch { error = failure("SPEECH_CLEANUP_FAILED"); }
        reject(error);
      };
      const abort = () => { void fail(safeError(signal.reason, "SPEECH_ABORTED")); };
      const errored = () => { void fail(failure("SPEECH_CHILD_FAILED")); };
      const message = (reply) => {
        if (settled || reply?.id !== id) return;
        if (signal.aborted) return abort();
        if (reply.type === "progress" && type === "prepare") {
          update({ progress: progressSnapshot(reply.progress) });
        } else if (reply.type === "error") {
          void fail(failure(reply.code));
        } else if (reply.type === "result") {
          settled = true;
          cleanup();
          resolve(reply.result);
        }
      };
      child.on("message", message);
      child.on("error", errored);
      child.on("close", errored);
      signal.addEventListener("abort", abort, { once: true });
      try { child.send({ id, type, ...payload }, (error) => { if (error) errored(); }); }
      catch { errored(); }
      if (signal.aborted) abort();
    });
  }
  function run(kind, signal, action) {
    checkSignal(signal);
    if (closed) throw failure("SPEECH_CLOSED");
    if (initialError) throw initialError;
    if (cleanupFailed) throw failure("SPEECH_CLEANUP_FAILED");
    if (active) throw failure("SPEECH_BUSY");
    if (kind !== "prepare" && !current.ready) throw failure("SPEECH_NOT_READY");
    const controller = new AbortController();
    const abort = () => controller.abort(failure("SPEECH_ABORTED"));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(failure("SPEECH_TIMEOUT")), limits[`${kind}Ms`]);
    const operation = { controller, done: null };
    active = operation;
    operation.done = Promise.resolve().then(async () => {
      try {
        checkCancelled(controller.signal);
        const result = await action(controller.signal);
        checkCancelled(controller.signal);
        if (!closed) {
          const ready = synthesisReady && recognitionReady;
          update({
            state: ready ? "ready" : "error", ready,
            error: ready ? null : current.error || describeError(failure("SPEECH_CHILD_FAILED")),
          });
        }
        return result;
      } catch (caught) {
        let error = safeError(caught, kind === "transcribe"
          ? "SPEECH_RECOGNITION_FAILED" : "SPEECH_SYNTHESIS_FAILED");
        if (kind === "prepare" || kind === "transcribe") {
          try { await stopRecognition(); } catch { error = failure("SPEECH_CLEANUP_FAILED"); }
        }
        if (kind !== "transcribe" && error.code !== "SPEECH_ABORTED") synthesisReady = false;
        if (!closed) {
          const missing = /MISSING|NOT_PREPARED|DIRECTORY|ABORTED/.test(error.code);
          const stillReady = synthesisReady && recognitionReady && error.code === "SPEECH_ABORTED";
          update({
            state: stillReady ? "ready" : missing ? "missing-prerequisite" : "error",
            ready: stillReady,
            synthesis: { ...current.synthesis, state: synthesisReady ? "ready" : "unavailable" },
            recognition: { ...current.recognition, state: recognitionReady ? "ready" : "unprepared" },
            error: describeError(error),
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        active = null;
        if (!closed) update({ busy: false, phase: "idle" });
      }
    });
    update({
      state: kind === "prepare" ? "preparing" : "ready",
      ready: kind !== "prepare",
      busy: true,
      phase: kind === "prepare" ? "checking-synthesis" : kind,
      progress: null,
      error: null,
    });
    return operation.done;
  }
  async function prepare({ signal } = {}) {
    await run("prepare", signal, async (operationSignal) => {
      if (synthesisReady && recognitionReady) return;
      await initializeDirectories(operationSignal);
      if (!synthesisReady) {
        const voices = await runSay(["-v", "?"], operationSignal);
        if (!/^Samantha\s+en_US\b/mu.test(voices.toString("utf8"))) throw failure("SPEECH_VOICE_MISSING");
        await synthesizeFile("Ready.", operationSignal);
        checkCancelled(operationSignal);
        synthesisReady = true;
        update({ synthesis: { ...current.synthesis, state: "ready" } });
      }
      if (!recognitionReady) {
        update({
          phase: "preparing-model",
          recognition: { ...current.recognition, state: "preparing" },
        });
        const result = await requestRecognition("prepare", {
          directory: modelsDirectory, allowDownload, transformersModule, modelFiles: pinnedFiles,
        }, operationSignal);
        checkCancelled(operationSignal);
        if (result?.ready !== true) throw failure("SPEECH_RECOGNITION_LOAD_FAILED");
        if (!recognition || recognition.exited || recognition.stopping) throw failure("SPEECH_CHILD_FAILED");
        recognitionReady = true;
        update({ recognition: { ...current.recognition, state: "ready" }, progress: null });
      }
    });
    return status();
  }
  async function synthesize(text, { signal } = {}) {
    const normalized = plainText(text);
    return run("synthesize", signal, (operationSignal) => synthesizeFile(normalized, operationSignal));
  }
  async function transcribe(wavBuffer, { signal } = {}) {
    const pcm = parseWav(wavBuffer);
    return run("transcribe", signal, async (operationSignal) => {
      const samples = new Float32Array(pcm.length / 2);
      let nonzero = false;
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = pcm.readInt16LE(index * 2) / 32_768;
        nonzero ||= samples[index] !== 0;
      }
      try {
        if (!nonzero) return { text: "" };
        return transcript(await requestRecognition("transcribe", { samples }, operationSignal));
      } finally { samples.fill(0); }
    });
  }
  function close() {
    if (closing) return closing;
    closed = true;
    active?.controller.abort(failure("SPEECH_ABORTED"));
    const pending = active?.done;
    closing = (async () => {
      try {
        await Promise.all([...children].map(terminate));
        await pending?.catch(() => {});
        await Promise.all([...children].map(terminate));
        for (const file of [...artifacts]) await removeArtifact(file);
        if (mediaDirectory) {
          await rmdir(mediaDirectory);
          mediaDirectory = null;
        }
        synthesisReady = false;
        recognitionReady = false;
        update({
          state: "closed", ready: false, busy: false, phase: "idle", progress: null,
          synthesis: { ...current.synthesis, state: "unavailable" },
          recognition: { ...current.recognition, state: "unprepared" },
          error: null,
        });
      } catch {
        update({ state: "error", ready: false, busy: false, phase: "idle", error: describeError(failure("SPEECH_CLEANUP_FAILED")) });
        throw failure("SPEECH_CLEANUP_FAILED");
      }
    })();
    return closing;
  }
  update({});
  return { prepare, status, synthesize, transcribe, close };
}

async function recognitionWorker() {
  let pipe = null;
  let preparing = false;
  let busy = false;
  let stopping = false;
  let tf;
  const downloadController = new AbortController();
  const publicFetch = globalThis.fetch.bind(globalThis);
  const prefix = `https://huggingface.co/${MEETING_SPEECH_MODEL.id}/resolve/${MEETING_SPEECH_MODEL.revision}/`;
  const urls = new Set(MEETING_SPEECH_FILES.map((pin) => prefix + pin.file));
  // This process receives audio only after preparation. Even accidental library
  // fetches during inference are blocked, and credentials never enter its env.
  const download = (url, options = {}) => {
    if (!preparing || !urls.has(String(url)) ||
        (options.method && options.method !== "GET") || options.body != null) {
      throw failure("SPEECH_NETWORK_DISABLED");
    }
    const parsed = new URL(url);
    if (!parsed.href.startsWith(prefix) || parsed.search || parsed.hash) throw failure("SPEECH_NETWORK_DISABLED");
    const range = new Headers(options.headers).get("Range");
    return publicFetch(parsed, {
      method: "GET", credentials: "omit",
      headers: range === "bytes=0-0" ? { Range: "bytes=0-0" } : {},
      signal: downloadController.signal,
    });
  };
  globalThis.fetch = download;
  const send = (message) => {
    if (process.connected) process.send(message, () => {});
  };
  process.once("disconnect", () => process.exit(0));
  process.once("SIGTERM", () => {
    stopping = true;
    downloadController.abort(failure("SPEECH_ABORTED"));
    if (!busy) process.exit(0);
  });
  process.on("message", async (message) => {
    if (!Number.isSafeInteger(message?.id)) return;
    const { id, type } = message;
    if (busy || stopping) return send({ id, type: "error", code: "SPEECH_BUSY" });
    busy = true;
    try {
      if (type === "prepare") {
        if (!tf) {
          try {
            if (message.transformersModule && new URL(message.transformersModule).protocol !== "file:") {
              throw failure("SPEECH_DEPENDENCY_MISSING");
            }
            tf = message.transformersModule
              ? await import(message.transformersModule) : await import("@huggingface/transformers");
          } catch { throw failure("SPEECH_DEPENDENCY_MISSING"); }
        }
        if (tf.env.version !== MEETING_SPEECH_MODEL.version) throw failure("SPEECH_DEPENDENCY_VERSION");
        preparing = message.allowDownload === true;
        let lastProgress = 0;
        const progress = (value) => {
          if (Date.now() - lastProgress < 100) return;
          lastProgress = Date.now();
          send({ id, type: "progress", progress: progressSnapshot(value) });
        };
        const modelDirectory = await prepareModelFiles(message.directory, modelManifest(message.modelFiles), {
          allowDownload: preparing, download, progress, signal: downloadController.signal,
        });
        checkCancelled(downloadController.signal);
        preparing = false;
        Object.assign(tf.env, {
          cacheDir: message.directory,
          localModelPath: `${modelDirectory}${path.sep}`,
          allowLocalModels: true,
          allowRemoteModels: false,
          useFSCache: false,
          useBrowserCache: false,
          useCustomCache: false,
          useWasmCache: false,
          remoteHost: "https://huggingface.co/",
          remotePathTemplate: "{model}/resolve/{revision}/",
          fetch: download,
        });
        const options = {
          revision: MEETING_SPEECH_MODEL.revision,
          cache_dir: message.directory,
          local_files_only: true,
          dtype: "q8",
          device: "cpu",
          session_options: {
            enableCpuMemArena: false,
            intraOpNumThreads: 2,
            interOpNumThreads: 1,
            logSeverityLevel: 4,
          },
          progress_callback: progress,
        };
        // 4.2.0's pipeline/tokenizer preflights ignore revision options. Give
        // them only the verified local directory, with all network disabled.
        const [model, tokenizer, processor] = await Promise.all([
          tf.WhisperForConditionalGeneration.from_pretrained(modelDirectory, options),
          tf.AutoTokenizer.from_pretrained(modelDirectory, options),
          tf.AutoProcessor.from_pretrained(modelDirectory, options),
        ]);
        pipe = new tf.AutomaticSpeechRecognitionPipeline({
          task: "automatic-speech-recognition", model, tokenizer, processor,
        });
        preparing = false;
        tf.env.allowRemoteModels = false;
        send({ id, type: "result", result: { ready: true } });
      } else if (type === "transcribe") {
        if (!pipe) throw failure("SPEECH_NOT_READY");
        const samples = message.samples;
        if (!(samples instanceof Float32Array) || samples.length > 128_000 ||
            !samples.every((value) => Number.isFinite(value) && value >= -1 && value <= 1)) {
          throw failure("SPEECH_INVALID_WAV");
        }
        try {
          const result = await pipe(samples, {
            language: "en", task: "transcribe", return_timestamps: false,
            max_new_tokens: 128, do_sample: false, num_beams: 1,
          });
          send({ id, type: "result", result: transcript(result) });
        } finally { samples.fill(0); }
      } else {
        throw failure("SPEECH_CHILD_FAILED");
      }
    } catch (error) {
      const fallback = type === "prepare"
        ? message.allowDownload ? "SPEECH_RECOGNITION_LOAD_FAILED" : "SPEECH_MODEL_NOT_PREPARED"
        : "SPEECH_RECOGNITION_FAILED";
      send({ id, type: "error", code: safeError(error, fallback).code });
    } finally {
      preparing = false;
      if (tf) tf.env.allowRemoteModels = false;
      busy = false;
      if (stopping) process.exit(0);
    }
  });
}

if (process.env.TEAMS_LOCAL_SPEECH_WORKER === "1" &&
    process.argv.includes(WORKER_ARGUMENT) && typeof process.send === "function") {
  await recognitionWorker();
}
