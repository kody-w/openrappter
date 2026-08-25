import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";


const betaDir = path.resolve(import.meta.dirname, "..");
const appDir = path.join(
  betaDir,
  "release",
  "mac-arm64",
  "OpenRappter.app",
);
const executable = path.join(
  appDir,
  "Contents",
  "MacOS",
  "OpenRappter",
);
const resources = path.join(appDir, "Contents", "Resources");
const mediaTools = path.join(resources, "media-tools");
const results = [];
const require = createRequire(import.meta.url);
const { extractFile } = require("@electron/asar");
const criticalSources = [
  "electron/main.mjs",
  "electron/brainstem-process.mjs",
  "electron/dogg-summon.mjs",
  "electron/drill-app.mjs",
  "electron/neighborhood-identity.mjs",
  "electron/injection-sources.mjs",
  "electron/openrappter-chat-endpoint.mjs",
  "electron/openrappter-hatchery.mjs",
  "electron/openrappter-tile.mjs",
  "electron/qqdrill.mjs",
  "electron/rappter-pack.mjs",
  "electron/semantic-ui-plan.mjs",
  "electron/species-isolation.mjs",
  "electron/video-tools.mjs",
  "resources/media-tool-hashes.json",
  "resources/rappter-pack/rappter_pack_sentinel.py",
  "scripts/openrappter-hatch.mjs",
  "scripts/frontier-ui.mjs",
  "scripts/openrappter-tile.mjs",
  "scripts/rappter-pack.mjs",
  "ui/index.html",
  "ui/autopilot.js",
  "ui/renderer.js",
];
const mediaHashes = JSON.parse(readFileSync(
  path.join(betaDir, "resources", "media-tool-hashes.json"),
  "utf8",
))[`${process.platform}-${process.arch}`] || {};

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function brainstemPython() {
  const candidates = [
    process.env.BRAINSTEM_BETA_PYTHON,
    path.join(
      homedir(),
      ".brainstem",
      "venv",
      process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
    ),
    String(spawnSync("which", ["python3"], {
      encoding: "utf8",
    }).stdout || "").trim(),
  ].filter(Boolean);
  const selected = candidates.find((candidate) => (
    existsSync(candidate)
    && spawnSync(candidate, ["-c", "import flask, requests"], {
      stdio: "ignore",
      windowsHide: true,
    }).status === 0
  ));
  if (!selected) {
    throw new Error("Package smoke requires Python with Brainstem dependencies.");
  }
  return selected;
}

function requirement(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
  process.stdout.write(
    `${pass ? " PASS" : "*FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`,
  );
}

function findNamed(root, name) {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const found = findNamed(filePath, name);
      if (found) return found;
    } else if (entry.name === name) {
      return filePath;
    }
  }
  return null;
}

function newestPathMtime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "release"].includes(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory()
        ? newestPathMtime(filePath)
        : statSync(filePath).mtimeMs,
    );
  }
  return newest;
}

function newestPackagedSourceMtime() {
  const manifest = JSON.parse(
    readFileSync(path.join(betaDir, "package.json"), "utf8"),
  );
  const candidates = new Set([
    "package.json",
    "VERSION",
    "LICENSE",
    "THIRD-PARTY-NOTICES.md",
    "build",
    manifest.build?.afterPack,
  ].filter(Boolean));
  for (const entry of manifest.build?.files || []) {
    if (entry.startsWith("node_modules/")) continue;
    candidates.add(entry.endsWith("/**") ? entry.slice(0, -3) : entry);
  }
  return Math.max(...[...candidates].map((relative) => {
    const candidate = path.join(betaDir, relative);
    if (!existsSync(candidate)) return 0;
    return statSync(candidate).isDirectory()
      ? newestPathMtime(candidate)
      : statSync(candidate).mtimeMs;
  }));
}

function executableCheck(label, filePath) {
  requirement(`${label} exists in packaged media-tools`, Boolean(filePath), filePath || "");
  if (!filePath) return;
  let observedHash = sha256(readFileSync(filePath));
  if (process.platform === "darwin") {
    const unsigned = path.join(
      tmpdir(),
      `openrappter-${label}-${process.pid}-${Date.now()}`,
    );
    cpSync(filePath, unsigned);
    try {
      const stripped = spawnSync(
        "codesign",
        ["--remove-signature", unsigned],
        { encoding: "utf8" },
      );
      requirement(
        `${label} carries a valid nested code signature`,
        spawnSync("codesign", ["--verify", "--strict", filePath]).status === 0,
      );
      if (stripped.status === 0) {
        observedHash = sha256(readFileSync(unsigned));
      }
    } finally {
      rmSync(unsigned, { force: true });
    }
  }
  requirement(
    `${label} matches its canonical packaged SHA-256 pin`,
    observedHash === (
      mediaHashes.packaged_unsigned?.[label]
      || mediaHashes.source?.[label]
    ),
    observedHash,
  );
  const version = spawnSync(filePath, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const versionDetail = version.error?.message
    || version.stderr?.trim()
    || version.stdout?.trim()
    || "";
  requirement(`${label} executes`, version.status === 0, versionDetail);
  if (process.platform === "darwin" && process.arch === "arm64") {
    const architecture = spawnSync("file", [filePath], { encoding: "utf8" });
    requirement(
      `${label} is native arm64 or universal`,
      architecture.status === 0 && /arm64|universal/i.test(architecture.stdout),
      architecture.stdout.trim(),
    );
  }
}

function main() {
  const releaseDirectory = path.join(betaDir, "release");
  const unexpectedArchives = existsSync(releaseDirectory)
    ? readdirSync(releaseDirectory)
      .filter((name) => /\.(?:dmg|zip|blockmap)$/i.test(name))
    : [];
  requirement(
    "source-only gate has no publishable ZIP, DMG, or blockmap",
    unexpectedArchives.length === 0,
    unexpectedArchives.join(", "),
  );
  requirement("packaged macOS app exists", existsSync(executable), executable);
  const asarPath = path.join(resources, "app.asar");
  requirement("packaged app.asar exists", existsSync(asarPath), asarPath);
  if (existsSync(asarPath)) {
    requirement(
      "packaged app is newer than beta source",
      statSync(asarPath).mtimeMs >= newestPackagedSourceMtime(),
      new Date(statSync(asarPath).mtimeMs).toISOString(),
    );
    for (const relative of criticalSources) {
      let packaged = null;
      let error = "";
      try {
        packaged = extractFile(asarPath, relative);
      } catch (cause) {
        error = cause.message;
      }
      const source = readFileSync(path.join(betaDir, relative));
      requirement(
        `packaged ${relative} matches source`,
        packaged && sha256(packaged) === sha256(source),
        error || sha256(source),
      );
    }
  }
  executableCheck("ffmpeg", findNamed(mediaTools, "ffmpeg"));
  executableCheck("ffprobe", findNamed(mediaTools, "ffprobe"));

  if (existsSync(executable)) {
    if (process.platform === "darwin") {
      const signature = spawnSync(
        "codesign",
        ["--verify", "--deep", "--strict", appDir],
        { encoding: "utf8" },
      );
      requirement(
        "packaged app has a valid deep local signature",
        signature.status === 0,
        signature.stderr.trim(),
      );
    }
    const isolatedHome = mkdtempSync(path.join(tmpdir(), "rapp-beta-package-gate-"));
    try {
      const smokeReadyFile = path.join(isolatedHome, "smoke-ready.json");
      const userData = path.join(isolatedHome, "user-data");
      const isolatedRuntime = path.join(
        isolatedHome,
        "brainstem",
        "src",
        "rapp_brainstem",
      );
      mkdirSync(path.dirname(isolatedRuntime), { recursive: true });
      cpSync(path.resolve(betaDir, "..", "rapp_brainstem"), isolatedRuntime, {
        filter(source) {
          return ![
            ".brainstem_data",
            ".copilot_token",
            ".env",
            "__pycache__",
          ].includes(path.basename(source));
        },
        recursive: true,
      });
      const smoke = spawnSync(executable, [
        `--user-data-dir=${userData}`,
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENRAPPTER_HOME: isolatedHome,
          OPENRAPPTER_BRAINSTEM_HOME: path.join(isolatedHome, "brainstem"),
          BRAINSTEM_HOME: path.join(isolatedHome, "brainstem"),
          BRAINSTEM_BETA_HEADLESS: "1",
          BRAINSTEM_BETA_HOME: path.join(isolatedHome, "desktop"),
          BRAINSTEM_BETA_SOURCE_DIR: isolatedRuntime,
          BRAINSTEM_BETA_PYTHON: brainstemPython(),
          BRAINSTEM_BETA_SMOKE_EXIT_MS: "3000",
          BRAINSTEM_BETA_SMOKE_READY_FILE: smokeReadyFile,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          XDG_CACHE_HOME: path.join(isolatedHome, "xdg-cache"),
          XDG_CONFIG_HOME: path.join(isolatedHome, "xdg-config"),
          XDG_DATA_HOME: path.join(isolatedHome, "xdg-data"),
        },
        timeout: 30000,
        windowsHide: true,
      });
      requirement(
        "packaged app passes isolated headless smoke",
        smoke.status === 0 && existsSync(smokeReadyFile),
        String(smoke.stderr || smoke.stdout || "").trim(),
      );
      if (existsSync(smokeReadyFile)) {
        const readiness = JSON.parse(readFileSync(smokeReadyFile, "utf8"));
        requirement(
          "packaged smoke proves window, /chat, and active route readiness",
          readiness.schema === "openrappter-smoke-ready/1.0"
            && readiness.window_created === true
            && /^http:\/\/127\.0\.0\.1:\d+\/chat$/.test(
              readiness.chat_endpoint,
            )
            && /^http:\/\/127\.0\.0\.1:\d+$/.test(readiness.active_route),
        );
      }

      const hatchProofFile = path.join(
        isolatedHome,
        "package-hatch-proof.json",
      );
      const hatchProof = spawnSync(process.execPath, [
        path.join(betaDir, "scripts", "package-hatch-proof.mjs"),
        executable,
        path.join(isolatedHome, "hatch-home"),
        isolatedRuntime,
        brainstemPython(),
        hatchProofFile,
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
        },
        timeout: 180_000,
        windowsHide: true,
      });
      requirement(
        "packaged app hatches and capability-stops a real neighborhood",
        hatchProof.status === 0 && existsSync(hatchProofFile),
        String(hatchProof.stderr || hatchProof.stdout || "").trim(),
      );
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }

  const version = JSON.parse(
    readFileSync(path.join(betaDir, "package.json"), "utf8"),
  ).version;
  const zip = path.join(
    betaDir,
    "release",
    `OpenRappter-${version}-mac-arm64.zip`,
  );
  const blockmap = `${zip}.blockmap`;
  if (existsSync(blockmap)) {
    let covered = -1;
    try {
      const value = JSON.parse(gunzipSync(readFileSync(blockmap)));
      covered = (value.files || []).reduce(
        (total, file) => total + (file.sizes || [])
          .reduce((sum, size) => sum + Number(size || 0), 0),
        0,
      );
    } catch {
      covered = -1;
    }
    requirement(
      "ZIP blockmap covers the adjacent ZIP exactly",
      existsSync(zip) && covered === statSync(zip).size,
      `covered=${covered} zip=${existsSync(zip) ? statSync(zip).size : "missing"}`,
    );
  }

  const failures = results.filter((result) => !result.pass);
  process.stdout.write(
    `\n${failures.length ? "LOCAL PACKAGE NOT READY" : "LOCAL PACKAGE READY"} — ${
      results.length - failures.length
    }/${results.length} pass (source release only; notarized distribution is not claimed)\n`,
  );
  process.exit(failures.length ? 1 : 0);
}

main();
