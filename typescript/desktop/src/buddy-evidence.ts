import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_SECONDS = 20 * 60;
const MAX_TEXT_CHARS = 100_000;
const MAX_PROCESS_OUTPUT = 2 * 1024 * 1024;
const MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const EVIDENCE_PREFIX = "openrappter-buddy-evidence-";
const activeChildren = new Set<ChildProcess>();
const activeScratch = new Set<string>();

export type BuddyEvidenceKind = "video" | "audio" | "document";

export interface BuddyEvidenceInput {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

export interface BuddyEvidenceResult {
  schema: "openrappter-buddy-evidence/1.0";
  filename: string;
  mimeType: string;
  kind: BuddyEvidenceKind;
  text: string;
  summary: string;
  truncated: boolean;
}

export interface BuddyEvidenceDependencies {
  transcribe?: (samples: Float32Array) => Promise<{
    text: string;
    segments?: Array<{ atMs: number; endMs: number; text: string }>;
  }>;
  runCommand?: (
    binary: string,
    args: string[],
    timeoutMs: number,
  ) => Promise<string>;
  ffmpegPath?: string;
  ffprobePath?: string;
}

function normalizedFilename(value: string): string {
  const name = path
    .basename(value.replaceAll("\\", "/"))
    .replace(/[\0-\x1f\x7f]/g, "")
    .trim();
  if (!name || name.length > 180) {
    throw new Error("Evidence filename is invalid.");
  }
  return name;
}

function inferredMimeType(filename: string, supplied: string): string {
  if (supplied && supplied !== "application/octet-stream") {
    return supplied.toLowerCase();
  }
  const extension = path.extname(filename).toLowerCase();
  const byExtension: Record<string, string> = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".srt": "application/x-subrip",
    ".vtt": "text/vtt",
  };
  return byExtension[extension] ?? "application/octet-stream";
}

function kindFor(mimeType: string): BuddyEvidenceKind {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/x-subrip" ||
    mimeType === "application/pdf" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "document";
  }
  throw new Error(`Unsupported evidence type: ${mimeType}`);
}

function boundedText(value: string): {
  text: string;
  truncated: boolean;
} {
  const normalized = value.replace(/\0/g, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) {
    throw new Error("The evidence contained no extractable text.");
  }
  return {
    text: normalized.slice(0, MAX_TEXT_CHARS),
    truncated: normalized.length > MAX_TEXT_CHARS,
  };
}

function defaultRunCommand(
  binary: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
    activeChildren.add(child);
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout.toString("utf8"));
    };
    const append = (
      current: Buffer<ArrayBufferLike>,
      chunk: Buffer<ArrayBufferLike>,
    ): Buffer<ArrayBufferLike> => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > MAX_PROCESS_OUTPUT) {
        child.kill("SIGKILL");
        finish(new Error(`${binary} output exceeded 2 MiB.`));
      }
      return next;
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${binary} timed out.`));
    }, timeoutMs);
    child.once("error", (error) => {
      activeChildren.delete(child);
      finish(new Error(`${binary} is unavailable: ${error.message}`));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("close", (code) => {
      activeChildren.delete(child);
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `${binary} exited ${code}: ${stderr.toString("utf8").trim()}`,
        ),
      );
    });
  });
}

async function evidenceScratch(): Promise<string> {
  const scratch = await mkdtemp(path.join(os.tmpdir(), EVIDENCE_PREFIX));
  activeScratch.add(scratch);
  return scratch;
}

async function removeEvidenceScratch(scratch: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(scratch, { recursive: true, force: true });
      activeScratch.delete(scratch);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError;
}

export async function pruneStaleBuddyEvidence(): Promise<void> {
  try {
    const entries = await readdir(os.tmpdir(), { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    const candidates = entries
      .filter(
        (entry) =>
          entry.isDirectory() && entry.name.startsWith(EVIDENCE_PREFIX),
      )
      .slice(0, 2_000);
    for (const entry of candidates) {
      const candidate = path.join(os.tmpdir(), entry.name);
      try {
        if ((await stat(candidate)).mtimeMs < cutoff) {
          await rm(candidate, { recursive: true, force: true });
        }
      } catch {
        // Another cleanup may have removed the directory.
      }
    }
  } catch {
    // Per-job cleanup still runs when the temp root cannot be swept.
  }
}

export async function shutdownBuddyEvidenceJobs(): Promise<void> {
  const children = [...activeChildren];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 2_000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
  const cleanup = await Promise.allSettled(
    [...activeScratch].map((scratch) => removeEvidenceScratch(scratch)),
  );
  for (const result of cleanup) {
    if (result.status === "rejected") {
      console.error(
        `Buddy evidence scratch cleanup failed: ${String(result.reason)}`,
      );
    }
  }
}

export function hasActiveBuddyEvidenceJobs(): boolean {
  return activeChildren.size > 0 || activeScratch.size > 0;
}

export function resolveBuddyMediaBinary(name: "ffmpeg" | "ffprobe"): string {
  const override =
    name === "ffmpeg"
      ? (process.env.OPENRAPPTER_FFMPEG_PATH ?? process.env.FFMPEG_PATH)
      : (process.env.OPENRAPPTER_FFPROBE_PATH ?? process.env.FFPROBE_PATH);
  if (override) return override;
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const installed =
    name === "ffmpeg" ? ffmpegInstaller.path : ffprobeInstaller.path;
  const unpackedInstalled = String(installed).replace(
    /([\\/])app\.asar([\\/])/,
    "$1app.asar.unpacked$2",
  );
  const candidates =
    process.platform === "darwin"
      ? [
          unpackedInstalled,
          installed,
          `/opt/homebrew/bin/${name}`,
          `/usr/local/bin/${name}`,
        ]
      : process.platform === "win32"
        ? [
            unpackedInstalled,
            installed,
            path.join(
              process.env.LOCALAPPDATA ?? "",
              "Microsoft",
              "WinGet",
              "Links",
              executable,
            ),
          ]
        : [
            unpackedInstalled,
            installed,
            `/usr/bin/${name}`,
            `/usr/local/bin/${name}`,
          ];
  return (
    candidates.find((candidate) => candidate && existsSync(candidate)) ??
    executable
  );
}

async function mediaDuration(
  source: string,
  runCommand: NonNullable<BuddyEvidenceDependencies["runCommand"]>,
  ffprobePath: string,
): Promise<number> {
  const output = await runCommand(
    ffprobePath,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      source,
    ],
    30_000,
  );
  const duration = Number.parseFloat(output.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not determine the media duration.");
  }
  if (duration > MAX_DURATION_SECONDS) {
    throw new Error("Walkthrough media must be 20 minutes or shorter.");
  }
  return duration;
}

async function extractMediaTranscript(
  data: Uint8Array,
  kind: "video" | "audio",
  dependencies: BuddyEvidenceDependencies,
): Promise<{ text: string; duration: number }> {
  if (!dependencies.transcribe) {
    throw new Error("Local Whisper transcription is unavailable.");
  }
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const ffmpegPath =
    dependencies.ffmpegPath ?? resolveBuddyMediaBinary("ffmpeg");
  const ffprobePath =
    dependencies.ffprobePath ?? resolveBuddyMediaBinary("ffprobe");
  const scratch = await evidenceScratch();
  const source = path.join(scratch, "source-media");
  const rawAudio = path.join(scratch, "audio.f32le");
  try {
    await writeFile(source, data, { mode: 0o600 });
    const duration = await mediaDuration(source, runCommand, ffprobePath);
    try {
      await runCommand(
        ffmpegPath,
        [
          "-v",
          "error",
          "-y",
          "-i",
          source,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "f32le",
          rawAudio,
        ],
        Math.max(60_000, Math.ceil(duration * 2_000)),
      );
    } catch (error) {
      throw new Error(
        "Could not extract narration from the walkthrough. " +
          "For a silent video, attach a transcript alongside it.",
        { cause: error },
      );
    }
    const audio = await readFile(rawAudio);
    if (audio.length === 0 || audio.length % 4 !== 0) {
      throw new Error("The walkthrough had no usable audio track.");
    }
    const samples = new Float32Array(
      audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength),
    );
    const transcript = await dependencies.transcribe(samples);
    const text = transcript.segments?.length
      ? transcript.segments
          .map(
            (segment) =>
              `[${Math.floor(segment.atMs / 1_000)}s-` +
              `${Math.ceil(segment.endMs / 1_000)}s] ${segment.text}`,
          )
          .join("\n")
      : transcript.text;
    return { text, duration };
  } finally {
    await removeEvidenceScratch(scratch);
  }
}

function assertDocxArchiveBounds(data: Uint8Array): void {
  const buffer = Buffer.from(data);
  let entries = 0;
  let uncompressed = 0;
  for (let offset = 0; offset + 46 <= buffer.length; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    entries += 1;
    uncompressed += buffer.readUInt32LE(offset + 24);
    if (entries > 5_000 || uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new Error("DOCX evidence expands beyond the safe archive limit.");
    }
  }
  if (entries === 0)
    throw new Error("DOCX evidence is not a valid ZIP archive.");
}

function assertEvidenceMagic(data: Uint8Array, mimeType: string): void {
  const buffer = Buffer.from(data);
  const starts = (value: string, offset = 0) =>
    buffer.toString("ascii", offset, offset + value.length) === value;
  if (mimeType === "application/pdf" && !starts("%PDF-")) {
    throw new Error("PDF evidence does not have a valid PDF signature.");
  }
  if (mimeType.includes("wordprocessingml")) {
    if (!starts("PK\u0003\u0004")) {
      throw new Error("DOCX evidence does not have a valid ZIP signature.");
    }
    assertDocxArchiveBounds(data);
  }
  if (
    ["video/mp4", "video/quicktime", "video/x-m4v", "audio/mp4"].includes(
      mimeType,
    ) &&
    !starts("ftyp", 4)
  ) {
    throw new Error("MP4 evidence does not have a valid media signature.");
  }
  if (
    mimeType === "video/webm" &&
    !(
      buffer[0] === 0x1a &&
      buffer[1] === 0x45 &&
      buffer[2] === 0xdf &&
      buffer[3] === 0xa3
    )
  ) {
    throw new Error("WebM evidence does not have a valid media signature.");
  }
  if (mimeType === "audio/wav" && !(starts("RIFF") && starts("WAVE", 8))) {
    throw new Error("WAV evidence does not have a valid audio signature.");
  }
  if (mimeType === "audio/ogg" && !starts("OggS")) {
    throw new Error("Ogg evidence does not have a valid audio signature.");
  }
  if (
    mimeType === "audio/mpeg" &&
    !(starts("ID3") || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))
  ) {
    throw new Error("MP3 evidence does not have a valid audio signature.");
  }
  if (
    (mimeType.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/x-subrip") &&
    buffer.subarray(0, 8_192).includes(0)
  ) {
    throw new Error("Text evidence contains binary data.");
  }
}

async function extractDocument(
  data: Uint8Array,
  mimeType: string,
  dependencies: BuddyEvidenceDependencies,
): Promise<string> {
  const buffer = Buffer.from(data);
  if (mimeType === "application/pdf" || mimeType.includes("wordprocessingml")) {
    const runCommand = dependencies.runCommand ?? defaultRunCommand;
    const scratch = await evidenceScratch();
    const source = path.join(scratch, "document");
    try {
      await writeFile(source, buffer, { mode: 0o600 });
      const output = await runCommand(
        process.execPath,
        [
          "--max-old-space-size=256",
          path.join(import.meta.dirname, "document-extractor.js"),
          mimeType,
          source,
        ],
        60_000,
      );
      const result = JSON.parse(output) as { text?: unknown };
      if (typeof result.text !== "string") {
        throw new Error("Document extractor returned no text.");
      }
      return result.text;
    } finally {
      await removeEvidenceScratch(scratch);
    }
  }
  return buffer.toString("utf8");
}

export async function extractBuddyEvidence(
  rawInput: BuddyEvidenceInput,
  dependencies: BuddyEvidenceDependencies = {},
): Promise<BuddyEvidenceResult> {
  await pruneStaleBuddyEvidence();
  const filename = normalizedFilename(rawInput.filename);
  const mimeType = inferredMimeType(filename, rawInput.mimeType);
  const kind = kindFor(mimeType);
  const maxBytes = kind === "document" ? MAX_DOCUMENT_BYTES : MAX_MEDIA_BYTES;
  if (rawInput.data.byteLength === 0 || rawInput.data.byteLength > maxBytes) {
    throw new Error(
      `${kind === "document" ? "Document" : "Media"} evidence exceeds its size limit.`,
    );
  }
  assertEvidenceMagic(rawInput.data, mimeType);

  let extracted: string;
  let summary: string;
  if (kind === "document") {
    extracted = await extractDocument(rawInput.data, mimeType, dependencies);
    summary = `Extracted transcript text from ${filename}.`;
  } else {
    const media = await extractMediaTranscript(
      rawInput.data,
      kind,
      dependencies,
    );
    extracted = media.text;
    summary =
      `Transcribed ${kind} walkthrough ${filename} ` +
      `(${Math.round(media.duration)} seconds) with local Whisper.`;
  }
  const bounded = boundedText(extracted);
  return {
    schema: "openrappter-buddy-evidence/1.0",
    filename,
    mimeType,
    kind,
    text: bounded.text,
    summary,
    truncated: bounded.truncated,
  };
}
