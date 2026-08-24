import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const MAX_DURATION_SECONDS = 20 * 60;
const MAX_TEXT_CHARS = 100_000;
const MAX_PROCESS_OUTPUT = 2 * 1024 * 1024;

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
    });
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
      finish(new Error(`${binary} is unavailable: ${error.message}`));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("close", (code) => {
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

function mediaBinary(name: "ffmpeg" | "ffprobe"): string {
  const override =
    process.env[`OPENRAPPTER_${name.toUpperCase()}_PATH`] ??
    process.env[`${name.toUpperCase()}_PATH`];
  if (override) return override;
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidates =
    process.platform === "darwin"
      ? [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
      : process.platform === "win32"
        ? [
            path.join(
              process.env.LOCALAPPDATA ?? "",
              "Microsoft",
              "WinGet",
              "Links",
              executable,
            ),
          ]
        : [`/usr/bin/${name}`, `/usr/local/bin/${name}`];
  return candidates.find((candidate) => candidate && existsSync(candidate))
    ?? executable;
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
  const ffmpegPath = dependencies.ffmpegPath ?? mediaBinary("ffmpeg");
  const ffprobePath = dependencies.ffprobePath ?? mediaBinary("ffprobe");
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "openrappter-buddy-evidence-"),
  );
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
    await rm(scratch, { recursive: true, force: true });
  }
}

async function extractDocument(
  data: Uint8Array,
  mimeType: string,
): Promise<string> {
  const buffer = Buffer.from(data);
  if (mimeType === "application/pdf") {
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await parser.getInfo({ parsePageInfo: false });
      if (info.total > 200) {
        throw new Error("PDF evidence must contain at most 200 pages.");
      }
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return (await mammoth.extractRawText({ buffer })).value;
  }
  return buffer.toString("utf8");
}

export async function extractBuddyEvidence(
  rawInput: BuddyEvidenceInput,
  dependencies: BuddyEvidenceDependencies = {},
): Promise<BuddyEvidenceResult> {
  const filename = normalizedFilename(rawInput.filename);
  const mimeType = inferredMimeType(filename, rawInput.mimeType);
  const kind = kindFor(mimeType);
  const maxBytes = kind === "document" ? MAX_DOCUMENT_BYTES : MAX_MEDIA_BYTES;
  if (rawInput.data.byteLength === 0 || rawInput.data.byteLength > maxBytes) {
    throw new Error(
      `${kind === "document" ? "Document" : "Media"} evidence exceeds its size limit.`,
    );
  }

  let extracted: string;
  let summary: string;
  if (kind === "document") {
    extracted = await extractDocument(rawInput.data, mimeType);
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
