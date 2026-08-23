#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ffmpegPackage = require.resolve("ffmpeg-static/package.json");
const ffmpegDirectory = path.dirname(ffmpegPackage);
const ffmpeg = path.join(
  ffmpegDirectory,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);
if (!existsSync(ffmpeg)) {
  const installed = spawnSync(
    process.execPath,
    [path.join(ffmpegDirectory, "install.js")],
    {
      cwd: ffmpegDirectory,
      encoding: "utf8",
      stdio: "inherit",
      windowsHide: true,
    },
  );
  if (installed.status !== 0 || !existsSync(ffmpeg)) {
    throw new Error("ffmpeg-static did not install its platform binary.");
  }
}

const ffprobe = require("@ffprobe-installer/ffprobe").path;
if (!existsSync(ffprobe)) {
  throw new Error("The platform ffprobe binary is missing.");
}
const manifest = JSON.parse(readFileSync(
  path.join(packageRoot, "resources", "media-tool-hashes.json"),
  "utf8",
));
const platform = `${process.platform}-${process.arch}`;
const expected = manifest[platform]?.source || {
  ffmpeg: process.env.OPENRAPPTER_FFMPEG_SHA256,
  ffprobe: process.env.OPENRAPPTER_FFPROBE_SHA256,
};
const sha256 = (file) => createHash("sha256")
  .update(readFileSync(file))
  .digest("hex");
for (const [name, file] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe]]) {
  if (!/^[0-9a-f]{64}$/.test(String(expected?.[name] || ""))) {
    throw new Error(`No pinned ${name} hash is configured for ${platform}.`);
  }
  const observed = sha256(file);
  if (observed !== expected[name]) {
    throw new Error(
      `${name} failed its ${platform} SHA-256 pin: ${observed}.`,
    );
  }
}
if (process.platform !== "win32") {
  chmodSync(ffmpeg, 0o755);
  chmodSync(ffprobe, 0o755);
}
const staging = path.join(packageRoot, ".release-media-tools", platform);
mkdirSync(staging, { recursive: true, mode: 0o700 });
const stagedFfmpeg = path.join(
  staging,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);
const stagedFfprobe = path.join(
  staging,
  process.platform === "win32" ? "ffprobe.exe" : "ffprobe",
);
copyFileSync(ffmpeg, stagedFfmpeg);
copyFileSync(ffprobe, stagedFfprobe);
if (process.platform !== "win32") {
  chmodSync(stagedFfmpeg, 0o755);
  chmodSync(stagedFfprobe, 0o755);
}
process.stdout.write(`${JSON.stringify({
  ffmpeg: stagedFfmpeg,
  ffprobe: stagedFfprobe,
  platform,
})}\n`);
