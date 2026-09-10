import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  createMeetingSpeech,
  MEETING_SPEECH_FILES,
  MEETING_SPEECH_LIMITS,
  MEETING_SPEECH_MODEL,
} from "../electron/teams-local-speech.mjs";

function chunk(id, data) {
  const header = Buffer.alloc(8);
  header.write(id);
  header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

function riff(chunks) {
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WAVE", 8);
  return Buffer.concat([header, body]);
}

function wav({ samples = [16_384, -32_768, 0, 32_767], extra = [], pcmBytes } = {}) {
  const format = Buffer.alloc(16);
  format.writeUInt16LE(1);
  format.writeUInt16LE(1, 2);
  format.writeUInt32LE(16_000, 4);
  format.writeUInt32LE(32_000, 8);
  format.writeUInt16LE(2, 12);
  format.writeUInt16LE(16, 14);
  const pcm = pcmBytes === undefined ? Buffer.alloc(samples.length * 2) : Buffer.alloc(pcmBytes, 1);
  if (pcmBytes === undefined) samples.forEach((value, index) => pcm.writeInt16LE(value, index * 2));
  return riff([chunk("fmt ", format), ...extra, chunk("data", pcm)]);
}

let nextPid = 1_000_000;
class FakeChild extends EventEmitter {
  constructor(behavior) {
    super();
    this.behavior = behavior;
    this.pid = nextPid++;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new PassThrough();
    this.connected = true;
    this.done = false;
    this.signals = [];
  }
  finish(code = 0, signal = null) {
    if (this.done) return;
    this.done = true;
    this.connected = false;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
  kill(signal) {
    this.signals.push(signal);
    this.emit("kill", signal);
    if (this.behavior.ignoreTerm && signal === "SIGTERM") return true;
    if (this.behavior.ignoreKill && signal === "SIGKILL") return true;
    queueMicrotask(() => this.finish(null, signal));
    return true;
  }
}

function fakeRuntime(options = {}) {
  const behavior = { ...options };
  const calls = [];
  const outputs = [];
  const workers = [];
  const requests = [];
  const events = new EventEmitter();
  function spawnImpl(executable, args, settings) {
    if (behavior.missingSay) {
      throw Object.assign(new Error("private spawn diagnostics"), { code: "ENOENT" });
    }
    const child = new FakeChild(behavior);
    calls.push({ executable, args, settings, child });
    if (args.includes("?")) {
      queueMicrotask(() => {
        child.stdout.write(behavior.missingVoice ? "Alex en_US\n" : "Samantha en_US # public voice\n");
        child.finish(0);
      });
    } else {
      let input = "";
      child.stdin.on("data", (data) => { input += data.toString(); });
      child.stdin.on("finish", () => {
        const output = args[args.indexOf("-o") + 1];
        const mode = statSync(output).mode & 0o777;
        writeFileSync(output, behavior.output ?? wav({ extra: [chunk("FLLR", Buffer.alloc(4_044))] }));
        outputs.push({ output, input, mode, child });
        events.emit("output", outputs.at(-1));
        if (!behavior.holdSynthesis) queueMicrotask(() => child.finish(behavior.sayExitCode ?? 0));
      });
    }
    return child;
  }
  function forkImpl(file, args, settings) {
    const child = new FakeChild(behavior);
    workers.push({ file, args, settings, child });
    child.send = (message, callback) => {
      const copy = structuredClone(message);
      requests.push(copy);
      queueMicrotask(() => {
        callback?.(null);
        events.emit("request", { message: copy, child });
        if (child.done || behavior.holdRequest === copy.type) return;
        if (behavior.workerError) {
          child.emit("message", { id: copy.id, type: "error", code: behavior.workerError, message: "private backend text" });
        } else if (copy.type === "prepare") {
          child.emit("message", {
            id: copy.id, type: "progress",
            progress: { percent: 500, loadedBytes: 42, totalBytes: Infinity, text: "private progress text" },
          });
          child.emit("message", { id: copy.id, type: "result", result: { ready: true } });
        } else {
          child.emit("message", {
            id: copy.id, type: "result",
            result: behavior.result === undefined ? { text: "The virtual audio bridge is ready." } : behavior.result,
          });
        }
      });
      return true;
    };
    return child;
  }
  return { spawnImpl, forkImpl, calls, outputs, workers, requests, events, behavior };
}

async function fixture(t, { runtimeOptions, configure, ...options } = {}) {
  const directory = path.resolve(".test-scratch", `teams-local-speech-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime = fakeRuntime(runtimeOptions);
  const states = [];
  const configured = await configure?.(directory, runtime) || {};
  const service = createMeetingSpeech({
    directory,
    env: {},
    platform: "darwin",
    spawnImpl: runtime.spawnImpl,
    forkImpl: runtime.forkImpl,
    timeouts: { prepareMs: 3_000, synthesizeMs: 3_000, transcribeMs: 3_000, killGraceMs: 10, killWaitMs: 100 },
    onState: (state) => { states.push(state); runtime.events.emit("state", state); },
    ...options,
    ...configured,
  });
  t.after(async () => {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, directory, runtime, states };
}

const fixtureFiles = () => MEETING_SPEECH_FILES.map(({ file }) => ({
  file, size: 2, sha256: createHash("sha256").update("{}").digest("hex"),
}));

async function seedModel(directory) {
  const root = path.join(directory, "models", ...MEETING_SPEECH_MODEL.id.split("/"), MEETING_SPEECH_MODEL.revision);
  await mkdir(path.join(root, "onnx"), { recursive: true, mode: 0o700 });
  for (const { file } of fixtureFiles()) await writeFile(path.join(root, file), "{}", { mode: 0o600 });
  return root;
}

async function modelFixture(t, { payload = "{}", httpStatus = 200, offline = false, cache, stall = false } = {}) {
  return fixture(t, {
    modelFiles: fixtureFiles(),
    env: { TEAMS_LOCAL_SPEECH_OFFLINE: offline ? "1" : "0" },
    timeouts: { prepareMs: 3_000, killGraceMs: 500, killWaitMs: 1_000 },
    configure: async (directory) => {
      if (cache) {
        const root = await seedModel(directory);
        if (cache === "corrupt") await writeFile(path.join(root, "config.json"), "[]");
        if (cache === "symlink") {
          const target = path.join(directory, "untouched");
          await writeFile(target, "{}");
          await unlink(path.join(root, "config.json"));
          await symlink(target, path.join(root, "config.json"));
        }
      }
      const backend = path.join(directory, "backend.mjs");
      await writeFile(backend, `
        import assert from "node:assert/strict";
        export const env = { version: "4.2.0" };
        async function load(model, options) {
          assert.equal(options.local_files_only, true);
          assert.equal(env.allowRemoteModels, false);
          return {};
        }
        export const WhisperForConditionalGeneration = { from_pretrained: load };
        export const AutoTokenizer = { from_pretrained: load };
        export const AutoProcessor = { from_pretrained: load };
        export class AutomaticSpeechRecognitionPipeline {
          constructor() { return async () => ({ text: "Fixture speech." }); }
        }
      `);
      const preload = path.join(directory, "fetch-fixture.mjs");
      await writeFile(preload, `
        import assert from "node:assert/strict";
        const urls = new Set(${JSON.stringify(MEETING_SPEECH_FILES.map(({ file }) =>
          `https://huggingface.co/${MEETING_SPEECH_MODEL.id}/resolve/${MEETING_SPEECH_MODEL.revision}/${file}`))});
        globalThis.fetch = async (url, options) => {
          assert.equal(${JSON.stringify(offline)}, false, "Offline preparation must not fetch.");
          assert.ok(urls.has(String(url)));
          assert.equal(options.method, "GET");
          assert.equal(options.body, undefined);
          assert.equal(options.credentials, "omit");
          assert.equal(new Headers(options.headers).has("Authorization"), false);
          if (${JSON.stringify(stall)}) {
            return new Response(new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array([123]));
                options.signal.addEventListener("abort", () => controller.error(new Error("cancelled")), { once: true });
              }
            }));
          }
          return new Response(${JSON.stringify(payload)}, { status: ${httpStatus} });
        };
      `);
      return {
        transformersModule: pathToFileURL(backend).href,
        forkImpl: (file, args, options) => fork(file, args, {
          ...options, execArgv: ["--import", pathToFileURL(preload).href],
        }),
      };
    },
  });
}

function beginDuplex(service, runtime, { synthesisSignal, transcriptionSignal } = {}) {
  runtime.behavior.holdRequest = "transcribe";
  runtime.behavior.holdSynthesis = true;
  const requested = once(runtime.events, "request");
  const created = once(runtime.events, "output");
  const transcription = service.transcribe(wav(), { signal: transcriptionSignal });
  const synthesis = service.synthesize("A silent local reply.", { signal: synthesisSignal });
  void transcription.catch(() => {});
  void synthesis.catch(() => {});
  return {
    transcription,
    synthesis,
    started: Promise.all([requested, created]).then(([[request], [output]]) => ({ request, output })),
  };
}

test("construction is inert, readiness is explicit, and no operation downloads implicitly", async (t) => {
  const { service, directory, runtime, states } = await fixture(t);
  assert.equal(service.status().state, "missing-prerequisite");
  assert.equal(service.status().localOnly, true);
  assert.equal(service.status().ready, false);
  await assert.rejects(service.synthesize("Ready."), { code: "SPEECH_NOT_READY" });
  await assert.rejects(service.transcribe(wav()), { code: "SPEECH_NOT_READY" });
  assert.equal(runtime.calls.length, 0);
  assert.deepEqual(await readdir(directory), []);
  const status = await service.prepare();
  assert.equal(status.state, "ready");
  assert.equal(status.ready, true);
  assert.equal(status.busy, false);
  assert.equal(status.phase, "idle");
  assert.equal(status.recognition.revision, MEETING_SPEECH_MODEL.revision);
  assert.ok(states.some((state) => state.state === "preparing"));
  assert.ok(states.some((state) => state.progress?.percent === 100 && state.progress.totalBytes === null));
  assert.equal(runtime.workers.length, 1);
  await service.prepare();
  assert.equal(runtime.workers.length, 1);
});

test("unsupported platforms and missing directory fail before touching processes or files", async () => {
  for (const options of [{ platform: "linux", directory: "/not-used" }, { platform: "darwin" }]) {
    const service = createMeetingSpeech(options);
    const expected = options.platform === "linux" ? "SPEECH_UNSUPPORTED_PLATFORM" : "SPEECH_DIRECTORY_REQUIRED";
    await assert.rejects(service.prepare(), { code: expected });
    assert.equal(service.status().error.code, expected);
    await service.close();
  }
});

test("synthesis always uses fixed file-output argv, stdin, private modes, and canonical PCM WAV", async (t) => {
  const { service, runtime, directory } = await fixture(t);
  await service.prepare();
  const { wav: result, mimeType } = await service.synthesize("  Hello;\n $(nothing) & friend. ");
  assert.equal(mimeType, "audio/wav");
  assert.deepEqual(result, wav());
  const output = runtime.outputs.at(-1);
  const call = runtime.calls.at(-1);
  assert.equal(output.input, "Hello; $(nothing) & friend.\n");
  assert.equal(output.mode, 0o600);
  assert.equal(call.executable, "/usr/bin/say");
  assert.equal(call.settings.shell, false);
  assert.ok(call.args.includes("--file-format=WAVE"));
  assert.ok(call.args.includes("--data-format=LEI16@16000"));
  assert.ok(call.args.includes("--channels=1"));
  assert.deepEqual(call.args.slice(-2), ["-f", "-"]);
  assert.equal(call.args.includes("Hello; $(nothing) & friend."), false);
  assert.equal(call.args[call.args.indexOf("-v") + 1], "Samantha");
  assert.ok(output.output.startsWith(`${directory}${path.sep}`));
  assert.deepEqual(await readdir(path.dirname(output.output)), []);
});

test("recognition receives decoded PCM samples, not WAV headers, and never mutates caller audio", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  const source = wav({ extra: [chunk("JUNK", Buffer.from([0x5a]))] });
  const padded = Buffer.concat([Buffer.alloc(7), source, Buffer.alloc(9)]);
  const sliced = padded.subarray(7, 7 + source.length);
  const original = Buffer.from(sliced);
  assert.deepEqual(await service.transcribe(sliced), { text: "The virtual audio bridge is ready." });
  const request = runtime.requests.at(-1);
  assert.ok(request.samples instanceof Float32Array);
  assert.deepEqual(Array.from(request.samples), [0.5, -1, 0, 32_767 / 32_768]);
  assert.deepEqual(sliced, original);
  assert.equal(Object.hasOwn(request, "wav"), false);
});

test("8-second PCM boundary and 4096-byte WAV header are inclusive", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  const source = wav({ pcmBytes: 256_000, extra: [chunk("FLLR", Buffer.alloc(4_044))] });
  assert.equal(source.length, MEETING_SPEECH_LIMITS.maxWavBytes);
  await service.transcribe(source);
  assert.equal(runtime.requests.at(-1).samples.length, 128_000);
  await assert.rejects(service.transcribe(wav({ pcmBytes: 256_002 })), { code: "SPEECH_AUDIO_TOO_LARGE" });
  await assert.rejects(service.transcribe(wav({ extra: [chunk("JUNK", Buffer.alloc(4_046))] })), { code: "SPEECH_AUDIO_TOO_LARGE" });
  await assert.rejects(service.transcribe(Buffer.alloc(260_097)), { code: "SPEECH_AUDIO_TOO_LARGE" });
});

test("empty PCM, digital silence, and empty model responses are valid without invented words", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  assert.deepEqual(await service.transcribe(wav({ samples: [] })), { text: "" });
  assert.deepEqual(await service.transcribe(wav({ samples: [0, 0, 0] })), { text: "" });
  assert.equal(runtime.requests.filter((request) => request.type === "transcribe").length, 0);
  for (const text of ["", " [BLANK_AUDIO] ", "<|nospeech|>", "[NOISE] [silence]"]) {
    runtime.behavior.result = { text };
    assert.deepEqual(await service.transcribe(wav()), { text: "" });
  }
  runtime.behavior.result = { text: " Thank you. " };
  assert.deepEqual(await service.transcribe(wav()), { text: "Thank you." });
});

const malformed = [
  ["non-Buffer", () => new Uint8Array(wav())],
  ["empty bytes", () => Buffer.alloc(0)],
  ["truncated header", () => wav().subarray(0, 43)],
  ["raw PCM", () => Buffer.alloc(100, 1)],
  ["RIFX", () => { const value = wav(); value.write("RIFX"); return value; }],
  ["high-bit RIFF lookalike", () => { const value = wav(); value[0] |= 0x80; return value; }],
  ["not WAVE", () => { const value = wav(); value.write("AVI ", 8); return value; }],
  ["inconsistent RIFF length", () => { const value = wav(); value.writeUInt32LE(0, 4); return value; }],
  ["trailing bytes", () => Buffer.concat([wav(), Buffer.alloc(1)])],
  ["truncated chunk", () => { const value = wav(); value.writeUInt32LE(0xffff_ffff, 40); return value; }],
  ["odd PCM bytes", () => wav({ pcmBytes: 3 })],
  ["wrong codec", () => { const value = wav(); value.writeUInt16LE(3, 20); return value; }],
  ["stereo", () => { const value = wav(); value.writeUInt16LE(2, 22); return value; }],
  ["wrong rate", () => { const value = wav(); value.writeUInt32LE(48_000, 24); return value; }],
  ["wrong byte rate", () => { const value = wav(); value.writeUInt32LE(16_000, 28); return value; }],
  ["wrong alignment", () => { const value = wav(); value.writeUInt16LE(1, 32); return value; }],
  ["wrong bit depth", () => { const value = wav(); value.writeUInt16LE(8, 34); return value; }],
  ["invalid fmt size", () => { const value = wav(); value.writeUInt32LE(15, 16); return value; }],
  ["missing data", () => riff([wav().subarray(12, 36), chunk("JUNK", Buffer.alloc(8))])],
  ["data before fmt", () => riff([wav().subarray(36), wav().subarray(12, 36)])],
  ["duplicate fmt", () => riff([wav().subarray(12, 36), wav().subarray(12)])],
  ["duplicate data", () => riff([wav().subarray(12), wav().subarray(36)])],
  ["missing odd chunk padding", () => {
    const value = riff([wav().subarray(12), chunk("JUNK", Buffer.from([1]))]).subarray(0, -1);
    value.writeUInt32LE(value.length - 8, 4);
    return value;
  }],
];
for (const [name, make] of malformed) {
  test(`WAV validation rejects ${name} before any backend work`, async () => {
    const service = createMeetingSpeech({ directory: path.resolve(".test-scratch/not-created"), platform: "darwin" });
    await assert.rejects(service.transcribe(make()), { code: "SPEECH_INVALID_WAV" });
    assert.equal(service.status().state, "missing-prerequisite");
    await service.close();
  });
}

test("plain-text validation bounds input and rejects say directives without launching a process", async (t) => {
  const { service, runtime } = await fixture(t);
  for (const text of [null, 42, {}, "", " \n\t ", "...", "a".repeat(241), "x\u0000y", "\u0007hello", "[[slnc 999999]]Hi", "Hi]]"]) {
    await assert.rejects(service.synthesize(text), { code: "SPEECH_INVALID_TEXT" });
  }
  assert.equal(runtime.calls.length, 0);
});

test("oversized or malformed synthesized output is rejected and its WAV is removed", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  runtime.behavior.output = wav({ pcmBytes: 256_002 });
  await assert.rejects(service.synthesize("Bounded output."), { code: "SPEECH_AUDIO_TOO_LARGE" });
  assert.deepEqual(await readdir(path.dirname(runtime.outputs.at(-1).output)), []);
  assert.equal(service.status().ready, false);
  runtime.behavior.output = wav();
  await service.prepare();
  runtime.behavior.output = Buffer.alloc(44);
  await assert.rejects(service.synthesize("Malformed output."), { code: "SPEECH_INVALID_WAV" });
  assert.deepEqual(await readdir(path.dirname(runtime.outputs.at(-1).output)), []);
});

test("growing output is killed at the byte limit instead of waiting for an unbounded child", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  runtime.behavior.output = Buffer.alloc(260_097);
  runtime.behavior.holdSynthesis = true;
  await assert.rejects(service.synthesize("File limit."), { code: "SPEECH_AUDIO_TOO_LARGE" });
  assert.deepEqual(runtime.outputs.at(-1).child.signals, ["SIGTERM"]);
  assert.deepEqual(await readdir(path.dirname(runtime.outputs.at(-1).output)), []);
});

test("missing say, missing named voice, and nonzero synthesis exit are explicit with no fallback", async (t) => {
  for (const [options, code] of [
    [{ missingSay: true }, "SPEECH_SYNTHESIS_MISSING"],
    [{ missingVoice: true }, "SPEECH_VOICE_MISSING"],
    [{ sayExitCode: 1 }, "SPEECH_SYNTHESIS_FAILED"],
  ]) {
    const { service, runtime } = await fixture(t, { runtimeOptions: options });
    await assert.rejects(service.prepare(), { code });
    assert.equal(service.status().ready, false);
    assert.equal(runtime.workers.length, 0);
    assert.ok(!JSON.stringify(service.status()).includes("private spawn diagnostics"));
  }
});

test("unknown worker errors and invalid results are explicit and do not leak private diagnostics", async (t) => {
  const { service, runtime, states } = await fixture(t);
  runtime.behavior.workerError = "secret-url-and-transcript";
  await assert.rejects(service.prepare(), { code: "SPEECH_CHILD_FAILED" });
  assert.equal(service.status().ready, false);
  runtime.behavior.workerError = null;
  for (const result of [{}, null, { text: 4 }, { text: "x".repeat(4_097) }]) {
    await service.prepare();
    runtime.behavior.result = result;
    await assert.rejects(service.transcribe(wav()), { code: "SPEECH_RECOGNITION_RESULT" });
    assert.equal(service.status().ready, false);
  }
  assert.doesNotMatch(JSON.stringify(states), /private backend text|secret-url-and-transcript/);
});

test("status snapshots contain no input, transcripts, credentials, paths, or mutable internal references", async (t) => {
  const secret = "private-meeting-words-should-not-be-in-status";
  const { service, runtime, directory, states } = await fixture(t, {
    env: { HF_TOKEN: secret, AZURE_API_KEY: secret, ELEVENLABS_API_KEY: secret, NODE_OPTIONS: secret, WHISPER_URL: "https://invalid.example" },
  });
  await service.prepare();
  runtime.behavior.result = { text: secret };
  assert.deepEqual(await service.transcribe(wav()), { text: secret });
  await service.synthesize(secret);
  const snapshot = service.status();
  snapshot.recognition.id = "mutated";
  snapshot.limits.maxSeconds = 999;
  assert.equal(service.status().recognition.id, MEETING_SPEECH_MODEL.id);
  assert.equal(service.status().limits.maxSeconds, 8);
  const serialized = JSON.stringify(states);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes(directory));
  for (const call of [...runtime.calls, ...runtime.workers]) {
    assert.equal(call.settings.env.HF_TOKEN, undefined);
    assert.equal(call.settings.env.AZURE_API_KEY, undefined);
    assert.equal(call.settings.env.NODE_OPTIONS, undefined);
    assert.ok(call.settings.env.HOME.startsWith(directory));
    assert.ok(call.settings.env.TMPDIR.startsWith(directory));
  }
  assert.deepEqual(runtime.workers[0].settings.execArgv, []);
  assert.deepEqual(runtime.workers[0].settings.stdio, ["ignore", "ignore", "ignore", "ipc"]);
});

test("throwing state observers cannot interrupt readiness or media cleanup", async (t) => {
  const { service, runtime } = await fixture(t, { onState: () => { throw new Error("observer failure"); } });
  await service.prepare();
  await service.synthesize("Ready.");
  assert.equal(service.status().ready, true);
  assert.deepEqual(await readdir(path.dirname(runtime.outputs.at(-1).output)), []);
});

test("one slot per kind allows continuing recognition during synthesis without a hidden queue", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  runtime.behavior.holdRequest = "transcribe";
  runtime.behavior.holdSynthesis = true;
  const started = once(runtime.events, "request");
  const first = service.transcribe(wav());
  const [{ child, message }] = await started;
  const created = once(runtime.events, "output");
  const synthesis = service.synthesize("Continue listening.");
  const [output] = await created;
  await assert.rejects(service.transcribe(wav()), { code: "SPEECH_BUSY" });
  await assert.rejects(service.synthesize("No queue."), { code: "SPEECH_BUSY" });
  await assert.rejects(service.prepare(), { code: "SPEECH_BUSY" });
  assert.equal(service.status().busy, true);
  assert.equal(service.status().phase, "synthesize+transcribe");
  assert.equal(service.status().limits.maxConcurrentOperations, 2);
  assert.equal(service.status().limits.maxQueuedOperations, 0);
  assert.equal(runtime.requests.filter((request) => request.type === "transcribe").length, 1);
  child.emit("message", { id: message.id, type: "result", result: { text: "First only." } });
  assert.deepEqual(await first, { text: "First only." });
  assert.equal(service.status().busy, true);
  assert.equal(service.status().phase, "synthesize");
  const nextStarted = once(runtime.events, "request");
  const next = service.transcribe(wav());
  const [{ message: nextMessage }] = await nextStarted;
  assert.equal(service.status().phase, "synthesize+transcribe");
  assert.equal(runtime.requests.filter((request) => request.type === "transcribe").length, 2);
  assert.equal(runtime.outputs.length, 2, "Only preparation and one synthesis wrote audio.");
  output.child.finish(0);
  assert.equal((await synthesis).mimeType, "audio/wav");
  assert.equal(service.status().busy, true);
  assert.equal(service.status().phase, "transcribe");
  runtime.behavior.holdSynthesis = false;
  await service.synthesize("The other slot is free.");
  assert.equal(service.status().phase, "transcribe");
  child.emit("message", { id: nextMessage.id, type: "result", result: { text: "Next incoming speech." } });
  assert.deepEqual(await next, { text: "Next incoming speech." });
  assert.equal(service.status().busy, false);
  assert.equal(service.status().phase, "idle");
});

test("pre-aborted and invalid signals do not start work or expose abort reasons", async (t) => {
  const { service, runtime } = await fixture(t);
  const signal = AbortSignal.abort("private abort reason");
  for (const operation of [
    () => service.prepare({ signal }),
    () => service.synthesize("Cancelled.", { signal }),
    () => service.transcribe(wav(), { signal }),
  ]) {
    await assert.rejects(operation(), { code: "SPEECH_ABORTED", name: "AbortError" });
  }
  await assert.rejects(service.prepare({ signal: {} }), { code: "SPEECH_INVALID_SIGNAL" });
  assert.equal(runtime.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(service.status()), /private abort reason/);
});

test("cancelling synthesis stops its owned child and removes only its transient audio", async (t) => {
  const { service, runtime, directory } = await fixture(t);
  await service.prepare();
  const sentinel = path.join(directory, "unrelated.txt");
  await writeFile(sentinel, "keep me");
  runtime.behavior.holdSynthesis = true;
  const controller = new AbortController();
  const created = once(runtime.events, "output");
  const pending = service.synthesize("Cancel without speakers.", { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "SPEECH_ABORTED" });
  await created;
  controller.abort("private reason");
  await rejected;
  assert.deepEqual(runtime.outputs.at(-1).child.signals, ["SIGTERM"]);
  assert.deepEqual(await readdir(path.dirname(runtime.outputs.at(-1).output)), []);
  assert.equal(await readFile(sentinel, "utf8"), "keep me");
  assert.equal(service.status().ready, true);
});

test("cancelling native inference kills its isolated process and requires explicit re-preparation", async (t) => {
  const { service, runtime } = await fixture(t, { runtimeOptions: { ignoreTerm: true } });
  await service.prepare();
  runtime.behavior.holdRequest = "transcribe";
  const controller = new AbortController();
  const started = once(runtime.events, "request");
  const pending = service.transcribe(wav(), { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "SPEECH_ABORTED" });
  await started;
  controller.abort();
  await rejected;
  assert.deepEqual(runtime.workers[0].child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(service.status().ready, false);
  await assert.rejects(service.transcribe(wav()), { code: "SPEECH_NOT_READY" });
  runtime.behavior.holdRequest = null;
  await service.prepare();
  assert.equal(runtime.workers.length, 2);
  assert.equal(service.status().ready, true);
});

test("inference timeout is explicit, stops the worker and releases backpressure", async (t) => {
  const { service, runtime } = await fixture(t, {
    timeouts: { transcribeMs: 30, killGraceMs: 10, killWaitMs: 100 },
  });
  await service.prepare();
  runtime.behavior.holdRequest = "transcribe";
  await assert.rejects(service.transcribe(wav()), { code: "SPEECH_TIMEOUT", name: "TimeoutError" });
  assert.equal(service.status().busy, false);
  assert.equal(service.status().ready, false);
  assert.deepEqual(runtime.workers[0].child.signals, ["SIGTERM"]);
});

test("close cancels preparation, is idempotent and preserves existing files and model weights", async (t) => {
  const { service, directory, runtime } = await fixture(t, { runtimeOptions: { holdRequest: "prepare" } });
  await writeFile(path.join(directory, "unrelated.txt"), "keep me");
  const started = once(runtime.events, "request");
  const pending = service.prepare();
  const rejected = assert.rejects(pending, { code: "SPEECH_ABORTED" });
  await started;
  await writeFile(path.join(directory, "models", "public-model.bin"), "weights");
  const closing = service.close();
  assert.strictEqual(service.close(), closing);
  await closing;
  await rejected;
  assert.equal(service.status().state, "closed");
  assert.deepEqual((await readdir(directory)).sort(), ["models", "unrelated.txt"]);
  assert.equal(await readFile(path.join(directory, "models", "public-model.bin"), "utf8"), "weights");
  await assert.rejects(service.prepare(), { code: "SPEECH_CLOSED" });
  await assert.rejects(service.synthesize("Closed."), { code: "SPEECH_CLOSED" });
  await assert.rejects(service.transcribe(wav()), { code: "SPEECH_CLOSED" });
});

test("an idle worker exit immediately invalidates readiness instead of pretending to be available", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  runtime.workers[0].child.finish(1);
  assert.equal(service.status().state, "error");
  assert.equal(service.status().ready, false);
  assert.equal(service.status().error.code, "SPEECH_CHILD_FAILED");
  await assert.rejects(service.transcribe(wav()), { code: "SPEECH_NOT_READY" });
  await service.prepare();
  assert.equal(service.status().ready, true);
});

test("non-private directories and models symlinks are rejected without altering their targets", async (t) => {
  const { service, directory, runtime } = await fixture(t);
  await chmod(directory, 0o755);
  await assert.rejects(service.prepare(), { code: "SPEECH_DIRECTORY_UNSAFE" });
  assert.equal(statSync(directory).mode & 0o777, 0o755);
  assert.equal(runtime.calls.length, 0);
  await chmod(directory, 0o700);
  const target = path.join(directory, "untouched");
  await mkdir(target, { mode: 0o700 });
  await writeFile(path.join(target, "sentinel"), "untouched");
  await symlink(target, path.join(directory, "models"));
  await assert.rejects(service.prepare(), { code: "SPEECH_DIRECTORY_UNSAFE" });
  assert.deepEqual(await readdir(target), ["sentinel"]);
  assert.equal(runtime.calls.length, 0);
});

test("offline preparation is explicit and does not enable downloads", async (t) => {
  const { service, runtime } = await fixture(t, { env: { TEAMS_LOCAL_SPEECH_OFFLINE: "1" } });
  await service.prepare();
  assert.equal(runtime.requests[0].allowDownload, false);
  assert.equal(service.status().downloadsAllowedDuringPrepare, false);
});

test("real recognition subprocess enforces pinned local CPU configuration and blocks inference network", async (t) => {
  const { service, directory } = await fixture(t);
  await service.close();
  const modelDirectory = await seedModel(directory);
  const backendFile = path.join(directory, "fixture-transformers.mjs");
  await writeFile(backendFile, `
    import assert from "node:assert/strict";
    export const env = { version: "4.2.0" };
    const denied = { code: "SPEECH_NETWORK_DISABLED" };
    async function load(model, options) {
      assert.equal(model, ${JSON.stringify(modelDirectory)});
      assert.equal(options.revision, "${MEETING_SPEECH_MODEL.revision}");
      assert.equal(options.local_files_only, true);
      assert.equal(options.device, "cpu");
      assert.equal(options.dtype, "q8");
      assert.equal(options.session_options.intraOpNumThreads, 2);
      assert.ok(options.cache_dir.startsWith(${JSON.stringify(directory)}));
      assert.equal(env.useBrowserCache, false);
      assert.equal(env.useWasmCache, false);
      assert.equal(env.useFSCache, false);
      assert.equal(env.allowRemoteModels, false);
      assert.equal(process.env.HF_TOKEN, undefined);
      assert.equal(process.env.NODE_OPTIONS, undefined);
      assert.throws(() => env.fetch("https://invalid.example/no-upload"), denied);
      assert.throws(() => env.fetch("https://huggingface.co/Xenova/whisper-small/resolve/main/config.json"), denied);
      assert.throws(() => env.fetch("${`https://huggingface.co/${MEETING_SPEECH_MODEL.id}/resolve/${MEETING_SPEECH_MODEL.revision}/config.json`}", { method: "POST", body: "never-upload" }), denied);
      return { pinned: true };
    }
    export const WhisperForConditionalGeneration = { from_pretrained: load };
    export const AutoTokenizer = { from_pretrained: load };
    export const AutoProcessor = { from_pretrained: load };
    export class AutomaticSpeechRecognitionPipeline {
      constructor({ task, model, tokenizer, processor }) {
        assert.equal(task, "automatic-speech-recognition");
        assert.ok([model, tokenizer, processor].every(component => component.pinned));
        return async (samples, inference) => {
          assert.equal(env.allowRemoteModels, false);
          assert.deepEqual(Array.from(samples), [0.5, -1, 0, 32767/32768]);
          assert.equal(inference.language, "en");
          assert.equal(inference.max_new_tokens, 128);
          assert.throws(() => globalThis.fetch("https://invalid.example/no-upload"), denied);
          return { text: "The worker is private." };
        };
      }
    }
  `);
  const runtime = fakeRuntime();
  const isolated = createMeetingSpeech({
    directory, platform: "darwin", spawnImpl: runtime.spawnImpl,
    transformersModule: pathToFileURL(backendFile).href,
    modelFiles: fixtureFiles(),
    env: { HF_TOKEN: "never pass this", NODE_OPTIONS: "never pass this" },
  });
  try {
    await isolated.prepare();
    assert.deepEqual(await isolated.transcribe(wav()), { text: "The worker is private." });
  } finally { await isolated.close(); }
});

test("real subprocess reports missing and wrong-version dependencies without model or cloud fallback", async (t) => {
  const { service, directory } = await fixture(t);
  await service.close();
  const wrongVersion = path.join(directory, "wrong-version.mjs");
  await writeFile(wrongVersion, 'export const env = { version: "0.0.0" };');
  for (const [file, code] of [
    ["missing-dependency.mjs", "SPEECH_DEPENDENCY_MISSING"],
    ["wrong-version.mjs", "SPEECH_DEPENDENCY_VERSION"],
  ]) {
    const runtime = fakeRuntime();
    const isolated = createMeetingSpeech({
      directory, platform: "darwin", spawnImpl: runtime.spawnImpl,
      transformersModule: pathToFileURL(path.join(directory, file)).href,
    });
    try {
      await assert.rejects(isolated.prepare(), { code });
      assert.equal(isolated.status().ready, false);
      assert.equal(isolated.status().error.code, code);
    } finally { await isolated.close(); }
  }
});

test("preparation downloads only known public files and checks their sizes and SHA-256 pins", async (t) => {
  const { service, directory } = await modelFixture(t);
  await service.prepare();
  const root = path.join(directory, "models", ...MEETING_SPEECH_MODEL.id.split("/"), MEETING_SPEECH_MODEL.revision);
  for (const { file } of fixtureFiles()) {
    const target = path.join(root, file);
    assert.equal(await readFile(target, "utf8"), "{}");
    assert.equal(statSync(target).mode & 0o777, 0o600);
  }
  assert.ok((await readdir(root)).every((file) => !file.includes(".download-")));
  await service.close();
  assert.ok((await readdir(directory)).every((file) => !file.startsWith("media-")));
  assert.equal(await readFile(path.join(root, "config.json"), "utf8"), "{}");
});

test("valid cached model files load offline without any network request", async (t) => {
  const { service } = await modelFixture(t, { offline: true, cache: "valid" });
  await service.prepare();
  assert.equal(service.status().ready, true);
});

test("offline model preparation refuses missing or corrupted cache files", async (t) => {
  for (const cache of [undefined, "corrupt"]) {
    const { service } = await modelFixture(t, { offline: true, cache });
    await assert.rejects(service.prepare(), { code: "SPEECH_MODEL_NOT_PREPARED" });
    assert.equal(service.status().ready, false);
  }
});

test("explicit online preparation repairs only a corrupt pinned cache file", async (t) => {
  const { service, directory } = await modelFixture(t, { cache: "corrupt" });
  await writeFile(path.join(directory, "untouched"), "preserved");
  await service.prepare();
  const root = path.join(directory, "models", ...MEETING_SPEECH_MODEL.id.split("/"), MEETING_SPEECH_MODEL.revision);
  assert.equal(await readFile(path.join(root, "config.json"), "utf8"), "{}");
  assert.equal(await readFile(path.join(directory, "untouched"), "utf8"), "preserved");
});

test("model file symlinks cannot redirect model reads or overwrite another file", async (t) => {
  const { service, directory } = await modelFixture(t, { cache: "symlink" });
  await assert.rejects(service.prepare(), { code: "SPEECH_MODEL_CACHE_UNSAFE" });
  assert.equal(await readFile(path.join(directory, "untouched"), "utf8"), "{}");
});

test("wrong-size and wrong-hash downloads fail closed and remove their incomplete files", async (t) => {
  for (const payload of ["[ ]", "[]", "{"]) {
    const { service, directory } = await modelFixture(t, { payload });
    await assert.rejects(service.prepare(), { code: "SPEECH_MODEL_INTEGRITY" });
    assert.equal(service.status().ready, false);
    const root = path.join(directory, "models", ...MEETING_SPEECH_MODEL.id.split("/"), MEETING_SPEECH_MODEL.revision);
    assert.deepEqual(await readdir(root), ["onnx"]);
  }
});

test("public model HTTP failure is explicit, never a ready model or cloud fallback", async (t) => {
  const { service } = await modelFixture(t, { httpStatus: 503 });
  await assert.rejects(service.prepare(), { code: "SPEECH_MODEL_DOWNLOAD_FAILED" });
  assert.equal(service.status().error.code, "SPEECH_MODEL_DOWNLOAD_FAILED");
  assert.equal(service.status().ready, false);
});

test("cancelling an actual preparation process cleans its partial download and transient audio", async (t) => {
  const { service, directory, runtime } = await modelFixture(t, { stall: true });
  const progress = new Promise((resolve) => {
    runtime.events.on("state", (state) => { if (state.progress?.loadedBytes === 1) resolve(); });
  });
  const controller = new AbortController();
  const pending = service.prepare({ signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "SPEECH_ABORTED" });
  await progress;
  controller.abort();
  await rejected;
  await service.close();
  const root = path.join(directory, "models", ...MEETING_SPEECH_MODEL.id.split("/"), MEETING_SPEECH_MODEL.revision);
  assert.deepEqual(await readdir(root), ["onnx"]);
  assert.ok((await readdir(directory)).every((file) => !file.startsWith("media-")));
});

test("model manifests cannot introduce path traversal or unbounded downloads", () => {
  for (const update of [
    { file: "../outside.json" }, { size: -1 }, { size: 3_000_000_000 }, { sha256: "unpinned" },
  ]) {
    const modelFiles = fixtureFiles();
    modelFiles[0] = { ...modelFiles[0], ...update };
    assert.throws(() => createMeetingSpeech({ modelFiles }), /Invalid speech model manifest/);
  }
  assert.ok(Object.isFrozen(MEETING_SPEECH_FILES));
  assert.ok(MEETING_SPEECH_FILES.every(Object.isFrozen));
});

test("PCM fmt with an empty extension is accepted but nonempty extensions are rejected", async (t) => {
  const { service } = await fixture(t);
  await service.prepare();
  const format = Buffer.concat([wav().subarray(20, 36), Buffer.alloc(2)]);
  await service.transcribe(riff([chunk("fmt ", format), wav().subarray(36)]));
  format.writeUInt16LE(1, 16);
  await assert.rejects(service.transcribe(riff([chunk("fmt ", format), wav().subarray(36)])), { code: "SPEECH_INVALID_WAV" });
});

test("preparation is exclusive and immediate close cannot start late media work", async (t) => {
  const first = await fixture(t, { runtimeOptions: { holdRequest: "prepare" } });
  const started = once(first.runtime.events, "request");
  const pending = first.service.prepare();
  const rejected = assert.rejects(pending, { code: "SPEECH_ABORTED" });
  await started;
  await assert.rejects(first.service.prepare(), { code: "SPEECH_BUSY" });
  await assert.rejects(first.service.synthesize("Busy."), { code: "SPEECH_BUSY" });
  await assert.rejects(first.service.transcribe(wav()), { code: "SPEECH_BUSY" });
  await first.service.close();
  await rejected;
  const second = await fixture(t);
  const immediate = second.service.prepare();
  const stopped = assert.rejects(immediate, { code: "SPEECH_ABORTED" });
  await second.service.close();
  await stopped;
  assert.deepEqual(await readdir(second.directory), []);
  assert.equal(second.runtime.calls.length, 0);
});

test("unconfirmed child termination retains its output and fail-closes all further work", async (t) => {
  const { service, runtime, directory } = await fixture(t);
  await service.prepare();
  Object.assign(runtime.behavior, { holdSynthesis: true, ignoreTerm: true, ignoreKill: true });
  const controller = new AbortController();
  const output = once(runtime.events, "output");
  const pending = service.synthesize("Cannot stop yet.", { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: "SPEECH_CLEANUP_FAILED" });
  const [created] = await output;
  controller.abort();
  await rejected;
  assert.ok(statSync(created.output).isFile());
  assert.deepEqual(created.child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(service.status().ready, false);
  await assert.rejects(service.prepare(), { code: "SPEECH_CLEANUP_FAILED" });
  created.child.finish(null, "SIGKILL");
  Object.assign(runtime.behavior, { ignoreTerm: false, ignoreKill: false });
  await service.close();
  assert.deepEqual(await readdir(directory), ["models"]);
});

test("a recognition crash during synthesis cannot overwrite the honest unavailable status", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  runtime.behavior.holdSynthesis = true;
  const created = once(runtime.events, "output");
  const synthesis = service.synthesize("Still a local file.");
  const [output] = await created;
  runtime.workers[0].child.finish(1);
  output.child.finish(0);
  await synthesis;
  assert.equal(service.status().ready, false);
  assert.equal(service.status().state, "error");
  assert.equal(service.status().error.code, "SPEECH_CHILD_FAILED");
});

test("a worker exiting alongside its ready acknowledgement cannot produce a false ready state", async (t) => {
  const { service, runtime } = await fixture(t, { runtimeOptions: { holdRequest: "prepare" } });
  const started = once(runtime.events, "request");
  const pending = service.prepare();
  const rejected = assert.rejects(pending, { code: "SPEECH_CHILD_FAILED" });
  const [{ child, message }] = await started;
  child.emit("message", { id: message.id, type: "result", result: { ready: true } });
  child.finish(1);
  await rejected;
  assert.equal(service.status().ready, false);
  assert.equal(service.status().state, "error");
});

test("repairing synthesis readiness reuses the already-loaded recognition model", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  runtime.behavior.output = wav({ pcmBytes: 256_002 });
  await assert.rejects(service.synthesize("Too long."), { code: "SPEECH_AUDIO_TOO_LARGE" });
  runtime.behavior.output = wav();
  await service.prepare();
  assert.equal(runtime.requests.filter((request) => request.type === "prepare").length, 1);
  assert.equal(service.status().ready, true);
});

test("cancelling synthesis leaves concurrent recognition running and removes only the synthesis WAV", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  const controller = new AbortController();
  const duplex = beginDuplex(service, runtime, { synthesisSignal: controller.signal });
  const cancelled = assert.rejects(duplex.synthesis, { code: "SPEECH_ABORTED" });
  const { request, output } = await duplex.started;
  controller.abort();
  await cancelled;
  assert.deepEqual(output.child.signals, ["SIGTERM"]);
  assert.deepEqual(request.child.signals, []);
  assert.equal(request.child.done, false);
  assert.equal(service.status().busy, true);
  assert.equal(service.status().phase, "transcribe");
  assert.equal(service.status().ready, true);
  assert.deepEqual(await readdir(path.dirname(output.output)), []);
  request.child.emit("message", { id: request.message.id, type: "result", result: { text: "Still listening." } });
  assert.deepEqual(await duplex.transcription, { text: "Still listening." });
  assert.equal(service.status().busy, false);
});

test("a stopping recognizer neither cancels concurrent synthesis nor delays its WAV cleanup", async (t) => {
  const { service, runtime } = await fixture(t, {
    timeouts: { killGraceMs: 2_000, killWaitMs: 1_000 },
  });
  await service.prepare();
  const controller = new AbortController();
  const duplex = beginDuplex(service, runtime, { transcriptionSignal: controller.signal });
  const cancelled = assert.rejects(duplex.transcription, { code: "SPEECH_ABORTED" });
  const { request, output } = await duplex.started;
  request.child.behavior = { ...runtime.behavior, ignoreTerm: true };
  const stopping = once(request.child, "kill");
  controller.abort();
  await stopping;
  assert.equal(request.child.done, false);
  assert.deepEqual(output.child.signals, []);
  output.child.finish(0);
  assert.deepEqual((await duplex.synthesis).wav, wav());
  assert.deepEqual(await readdir(path.dirname(output.output)), []);
  assert.equal(request.child.done, false, "The recognizer is still terminating during WAV cleanup.");
  assert.equal(service.status().busy, true);
  assert.equal(service.status().phase, "transcribe");
  await assert.rejects(service.prepare(), { code: "SPEECH_BUSY" });
  request.child.finish(null, "SIGTERM");
  await cancelled;
  assert.equal(service.status().busy, false);
  assert.equal(service.status().ready, false);
  assert.equal(service.status().synthesis.state, "ready");
  runtime.behavior.holdSynthesis = false;
  await service.synthesize("Synthesis remains available.");
  await assert.rejects(service.transcribe(wav()), { code: "SPEECH_NOT_READY" });
  runtime.behavior.holdRequest = null;
  await service.prepare();
  assert.equal(service.status().ready, true);
});

test("synthesis failure does not stop current or subsequent incoming recognition", async (t) => {
  const { service, runtime } = await fixture(t);
  await service.prepare();
  runtime.behavior.output = wav({ pcmBytes: 256_002 });
  const duplex = beginDuplex(service, runtime);
  const failed = assert.rejects(duplex.synthesis, { code: "SPEECH_AUDIO_TOO_LARGE" });
  const { request, output } = await duplex.started;
  output.child.finish(0);
  await failed;
  assert.deepEqual(request.child.signals, []);
  assert.equal(service.status().phase, "transcribe");
  assert.equal(service.status().ready, false);
  assert.equal(service.status().recognition.state, "ready");
  request.child.emit("message", { id: request.message.id, type: "result", result: { text: "Incoming speech continues." } });
  assert.deepEqual(await duplex.transcription, { text: "Incoming speech continues." });
  runtime.behavior.holdRequest = null;
  assert.deepEqual(await service.transcribe(wav()), { text: "The virtual audio bridge is ready." });
  assert.equal(service.status().ready, false);
  assert.equal(service.status().error.code, "SPEECH_AUDIO_TOO_LARGE");
  await assert.rejects(service.synthesize("Prepare this kind again."), { code: "SPEECH_NOT_READY" });
  assert.deepEqual(await readdir(path.dirname(output.output)), []);
});

for (const kind of ["synthesize", "transcribe"]) {
  test(`${kind} timeout leaves the other concurrent operation running`, async (t) => {
    const { service, runtime } = await fixture(t, {
      timeouts: { [`${kind}Ms`]: 100, killGraceMs: 10, killWaitMs: 100 },
    });
    await service.prepare();
    const duplex = beginDuplex(service, runtime);
    const timedOut = assert.rejects(kind === "synthesize" ? duplex.synthesis : duplex.transcription, {
      code: "SPEECH_TIMEOUT", name: "TimeoutError",
    });
    const { request, output } = await duplex.started;
    await timedOut;
    assert.equal(service.status().busy, true);
    if (kind === "synthesize") {
      assert.deepEqual(output.child.signals, ["SIGTERM"]);
      assert.deepEqual(request.child.signals, []);
      assert.equal(service.status().phase, "transcribe");
      request.child.emit("message", { id: request.message.id, type: "result", result: { text: "No lost incoming speech." } });
      assert.deepEqual(await duplex.transcription, { text: "No lost incoming speech." });
    } else {
      assert.deepEqual(request.child.signals, ["SIGTERM"]);
      assert.deepEqual(output.child.signals, []);
      assert.equal(service.status().phase, "synthesize");
      output.child.finish(0);
      assert.equal((await duplex.synthesis).mimeType, "audio/wav");
    }
    assert.equal(service.status().busy, false);
    assert.equal(service.status().phase, "idle");
    assert.equal(service.status().ready, false);
    assert.equal(service.status().error.code, "SPEECH_TIMEOUT");
    assert.deepEqual(await readdir(path.dirname(output.output)), []);
  });
}

test("close cancels both occupied slots, waits for both children, and preserves unrelated files", async (t) => {
  const { service, directory, runtime, states } = await fixture(t);
  await service.prepare();
  await writeFile(path.join(directory, "unrelated.txt"), "keep me");
  const duplex = beginDuplex(service, runtime);
  const stopped = Promise.all([
    assert.rejects(duplex.synthesis, { code: "SPEECH_ABORTED" }),
    assert.rejects(duplex.transcription, { code: "SPEECH_ABORTED" }),
  ]);
  const { request, output } = await duplex.started;
  request.child.behavior = { ...runtime.behavior, ignoreTerm: true };
  const closing = service.close();
  assert.strictEqual(service.close(), closing);
  await closing;
  await stopped;
  assert.deepEqual(request.child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(output.child.signals, ["SIGTERM"]);
  assert.equal(request.child.done, true);
  assert.equal(output.child.done, true);
  assert.deepEqual((await readdir(directory)).sort(), ["models", "unrelated.txt"]);
  assert.equal(await readFile(path.join(directory, "unrelated.txt"), "utf8"), "keep me");
  assert.equal(service.status().state, "closed");
  assert.equal(service.status().busy, false);
  assert.equal(service.status().phase, "idle");
  assert.equal(states.at(-1).state, "closed");
});
