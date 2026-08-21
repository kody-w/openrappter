import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";


const betaDir = path.resolve(import.meta.dirname, "..");
const appDir = path.join(
  betaDir,
  "release",
  "mac-arm64",
  "RAPP Brainstem Frontier.app",
);
const executable = path.join(
  appDir,
  "Contents",
  "MacOS",
  "RAPP Brainstem Frontier",
);
const resources = path.join(appDir, "Contents", "Resources");
const unpackedModules = path.join(resources, "app.asar.unpacked", "node_modules");
const results = [];

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

function newestSourceMtime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "release"].includes(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory()
        ? newestSourceMtime(filePath)
        : statSync(filePath).mtimeMs,
    );
  }
  return newest;
}

function executableCheck(label, filePath) {
  requirement(`${label} exists in app.asar.unpacked`, Boolean(filePath), filePath || "");
  if (!filePath) return;
  const version = spawnSync(filePath, ["-version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  requirement(`${label} executes`, version.status === 0, version.stderr.trim());
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
  requirement("packaged macOS app exists", existsSync(executable), executable);
  const asarPath = path.join(resources, "app.asar");
  requirement("packaged app.asar exists", existsSync(asarPath), asarPath);
  if (existsSync(asarPath)) {
    requirement(
      "packaged app is newer than beta source",
      statSync(asarPath).mtimeMs >= newestSourceMtime(betaDir),
      new Date(statSync(asarPath).mtimeMs).toISOString(),
    );
  }
  executableCheck("ffmpeg", findNamed(unpackedModules, "ffmpeg"));
  executableCheck("ffprobe", findNamed(unpackedModules, "ffprobe"));

  if (existsSync(executable)) {
    const isolatedHome = mkdtempSync(path.join(tmpdir(), "rapp-beta-package-gate-"));
    try {
      const smoke = spawnSync(executable, [], {
        encoding: "utf8",
        env: {
          ...process.env,
          BRAINSTEM_BETA_HEADLESS: "1",
          BRAINSTEM_BETA_HOME: isolatedHome,
          BRAINSTEM_BETA_SMOKE_EXIT_MS: "3000",
        },
        timeout: 30000,
        windowsHide: true,
      });
      requirement(
        "packaged app passes isolated headless smoke",
        smoke.status === 0,
        String(smoke.stderr || smoke.stdout || "").trim(),
      );
    } finally {
      rmSync(isolatedHome, { recursive: true, force: true });
    }
  }

  const failures = results.filter((result) => !result.pass);
  process.stdout.write(
    `\n${failures.length ? "PACKAGE NOT READY" : "PACKAGE READY"} — ${
      results.length - failures.length
    }/${results.length} pass\n`,
  );
  process.exit(failures.length ? 1 : 0);
}

main();
