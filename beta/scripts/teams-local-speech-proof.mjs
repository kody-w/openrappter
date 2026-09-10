import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createMeetingSpeech, MEETING_SPEECH_MODEL } from "../electron/teams-local-speech.mjs";

const HELP = `Local meeting speech setup/proof (macOS only; never plays audio).

Requires installed /usr/bin/say voice Samantha and
@huggingface/transformers exactly 4.2.0, installed with --ignore-scripts.
No ffmpeg, capture devices, Teams, or cloud speech API is used.

Usage:
  node beta/scripts/teams-local-speech-proof.mjs --prepare --directory <private-absolute-path>
    [--dependency-prefix <isolated-npm-prefix>] [--offline] [--prepare-only] [--duplex]

--prepare explicitly permits downloading public pinned Whisper-small weights
(about 252 MB) into directory/models/Xenova/whisper-small/<revision>.
Every file is size/SHA-256 verified before local-only model loading.
--offline forbids even model downloads.
The directory must be private (0700), or not yet exist. Models persist;
all service-created WAV files and the owned recognition process are cleaned up.
Only the fixed, non-sensitive phrase "The virtual audio bridge is ready." is used.
--duplex also synthesizes that phrase while recognizing the first generated WAV.

For an isolated proof, after a missing-dependency validation failure:
  npm install --prefix <isolated-prefix> --ignore-scripts --no-audit --no-fund @huggingface/transformers@4.2.0

Electron packaging must retain the speech module and Transformers dependencies,
and unpack node_modules/onnxruntime-node/bin/**, node_modules/@img/**, and native
*.node libraries from ASAR. The owned child requires ELECTRON_RUN_AS_NODE support.
No arbitrary transitive native postinstall/download scripts are needed on the
verified darwin-arm64 runtime. This helper does not install dependencies.

API: createMeetingSpeech({ directory, env, onState }) returns:
  prepare({ signal }) -> JSON-safe status; the only download opt-in.
  status() -> state, ready, busy, phase, current-file progress, error {code,message},
              localOnly, synthesis/recognition capability details, and limits.
  synthesize(text, { signal }) -> { wav: Buffer, mimeType: "audio/wav" }.
  transcribe(wavBuffer, { signal }) -> { text }; digital silence returns "".
  close() -> stops only owned processes and unlinks only owned media.
States: missing-prerequisite, preparing, ready, unavailable, error, closed.
No method captures, plays, joins a meeting, chooses devices, or logs transcripts.
One synthesis and one transcription may run concurrently. Same-kind overlap,
or any overlap with preparation, rejects SPEECH_BUSY; there is no queue.
busy stays true while either slot is occupied; phase is synthesize+transcribe
when both are active. Cancellation/failure of one does not stop the other.
ready means both capabilities are available; a healthy kind remains usable if
the other fails. Preparation is exclusive, including capability recovery.
After cancelled/timed-out inference, explicitly prepare() again.
Text: at most 240 characters/960 UTF-8 bytes, no say directives.
WAV: PCM16 RIFF, mono 16000 Hz, at most 8 seconds/256000 PCM bytes plus
4096 metadata bytes; synthesis returns a canonical 44-byte header.
Timeouts: prepare 15 minutes, synthesize 20 seconds, transcribe 90 seconds.
ASR is English, quantized CPU Whisper-small (two native compute threads).
This is chunked speech, not streaming conversation, diarization, or echo control.
Packaged Electron and virtual mic/camera integration are separate validation.
`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(HELP);
} else {
  let directory;
  let dependencyPrefix;
  let prepare = false;
  let offline = false;
  let prepareOnly = false;
  let duplex = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--prepare") prepare = true;
    else if (argument === "--offline") offline = true;
    else if (argument === "--prepare-only") prepareOnly = true;
    else if (argument === "--duplex") duplex = true;
    else if (argument === "--directory") directory = args[++index];
    else if (argument === "--dependency-prefix") dependencyPrefix = args[++index];
    else throw new Error(`Unknown proof option: ${argument}`);
  }
  if (!prepare || !directory || !path.isAbsolute(directory)) {
    throw new Error(`Explicit --prepare and an absolute --directory are required.\n${HELP}`);
  }
  let transformersModule;
  if (dependencyPrefix) {
    const require = createRequire(path.join(path.resolve(dependencyPrefix), "package.json"));
    transformersModule = pathToFileURL(require.resolve("@huggingface/transformers")).href;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let lastPhase;
  const service = createMeetingSpeech({
    directory,
    env: { TEAMS_LOCAL_SPEECH_OFFLINE: offline ? "1" : "0" },
    transformersModule,
    onState: (status) => {
      if (status.phase !== lastPhase) {
        lastPhase = status.phase;
        console.error(JSON.stringify({ state: status.state, phase: status.phase }));
      }
    },
  });
  try {
    const started = Date.now();
    const status = await service.prepare({ signal: controller.signal });
    assert.equal(status.ready, true);
    if (prepareOnly) {
      console.log(JSON.stringify({ ready: true, offline, model: MEETING_SPEECH_MODEL, prepareMs: Date.now() - started }));
    } else {
      const phrase = "The virtual audio bridge is ready.";
      const prepared = Date.now();
      const { wav, mimeType } = await service.synthesize(phrase, { signal: controller.signal });
      const synthesized = Date.now();
      let transcribed;
      const recognition = service.transcribe(wav, { signal: controller.signal }).then((result) => {
        transcribed = Date.now();
        return result;
      });
      const generation = duplex ? service.synthesize(phrase, { signal: controller.signal }) : null;
      const bothActive = service.status().phase === "synthesize+transcribe";
      const [{ text }, reply] = await Promise.all([recognition, generation]);
      if (duplex) assert.equal(bothActive, true);
      const words = (value) => value.toLowerCase().replace(/[^a-z\s]/gu, "").replace(/\s+/gu, " ").trim();
      assert.equal(words(text), words(phrase), "Local recognition must recover the actual proof words.");
      console.log(JSON.stringify({
        passed: true, offline, phrase, recognized: text, mimeType, wavBytes: wav.length,
        seconds: (wav.length - 44) / 32_000,
        prepareMs: prepared - started, synthesisMs: synthesized - prepared,
        transcriptionMs: transcribed - synthesized, model: MEETING_SPEECH_MODEL,
        ...(duplex ? { duplex: true, concurrentWavBytes: reply.wav.length } : {}),
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({ passed: false, code: error.code || "SPEECH_PROOF_FAILED", error: error.message }));
    process.exitCode = 1;
  } finally {
    await service.close();
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
