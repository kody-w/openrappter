const { chmodSync, copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  if (
    context.electronPlatformName !== "darwin"
    || process.platform !== "darwin"
    || process.arch !== "arm64"
  ) {
    throw new Error(
      "OpenRappter release media pins currently support darwin-arm64 only.",
    );
  }
  const staging = path.join(
    context.packager.projectDir,
    ".release-media-tools",
    "darwin-arm64",
  );
  const resources = context.electronPlatformName === "darwin"
    ? path.join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        "Contents",
        "Resources",
      )
    : path.join(context.appOutDir, "resources");
  const destination = path.join(resources, "media-tools");
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const [source, name] of [
    [
      path.join(staging, "ffmpeg"),
      "ffmpeg",
    ],
    [
      path.join(staging, "ffprobe"),
      "ffprobe",
    ],
  ]) {
    const target = path.join(destination, name);
    copyFileSync(source, target);
    if (process.platform !== "win32") chmodSync(target, 0o755);
  }
};
