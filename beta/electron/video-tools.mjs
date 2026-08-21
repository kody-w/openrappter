import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import ffmpegStatic from "ffmpeg-static";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";


function unpackedPath(filePath) {
  return String(filePath || "").replace(
    /([\\/])app\.asar([\\/])/,
    "$1app.asar.unpacked$2",
  );
}

function resolveTool(explicit, bundled, fallback) {
  if (explicit) return explicit;
  const unpacked = unpackedPath(bundled);
  if (unpacked && existsSync(unpacked)) return unpacked;
  if (bundled && existsSync(bundled)) return bundled;
  return fallback;
}

export function resolveFfmpegExecutable(env = process.env) {
  return resolveTool(
    env.BRAINSTEM_BETA_FFMPEG,
    ffmpegStatic,
    "ffmpeg",
  );
}

export function resolveFfprobeExecutable(env = process.env) {
  return resolveTool(
    env.BRAINSTEM_BETA_FFPROBE,
    ffprobeInstaller.path,
    "ffprobe",
  );
}

// Article II: an organ is installed only on first enable, after a prompt that
// names what will be installed. Recording reached straight for ffmpeg and let a
// raw spawn error stand in for that conversation, which is neither a prompt nor
// an explanation. Probe first, and hand back something the UI can turn into the
// one-time consent step.
export function probeMediaOrgan(env = process.env, { run = spawnSync } = {}) {
  const executable = resolveFfmpegExecutable(env);
  let result;
  try {
    result = run(executable, ["-version"], { stdio: "ignore", timeout: 8000 });
  } catch (error) {
    result = { error };
  }
  if (result && !result.error && result.status === 0) {
    return { ok: true, organ: MEDIA_ORGAN.organ, executable };
  }
  const reason = result?.error
    ? String(result.error.code || result.error.message || result.error)
    : `exited ${result?.status === null ? "on a signal" : result?.status}`;
  return {
    ...MEDIA_ORGAN,
    ok: false,
    executable,
    reason,
    // Size is a catalog fact, and no organ catalog is published yet. Null is the
    // honest answer; a prompt cannot claim a number nobody has.
    sizeBytes: null,
  };
}

export const MEDIA_ORGAN = Object.freeze({
  organ: "showtime-media",
  name: "Showtime media tools",
  detail: "ffmpeg and ffprobe, used to record and edit a Showtime film",
  prefix: "organs/showtime-media",
});

export const videoToolInternals = {
  unpackedPath,
};
