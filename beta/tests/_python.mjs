// One interpreter resolution for every test that shells out to Python.
//
// The installer runs `npm test` as a mandatory gate, on machines where
// "python3" may not exist at all (Windows ships "python", and a clean
// Windows has neither on PATH). The Brainstem the installer just created
// always has a venv, so prefer that, then whatever the environment names.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

let cached = null;

export function testPython() {
  if (cached) return cached;
  const explicit = [
    process.env.BRAINSTEM_BETA_PYTHON,
    process.env.PYTHON,
    path.join(homedir(), ".brainstem", "venv", "bin", "python"),
    path.join(homedir(), ".brainstem", "venv", "Scripts", "python.exe"),
  ].filter(Boolean).find((candidate) => existsSync(candidate));
  if (explicit) {
    cached = explicit;
    return cached;
  }
  const names = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];
  for (const name of names) {
    const probe = spawnSync(name, ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const executable = String(probe.stdout || "").trim();
    if (probe.status === 0 && executable) {
      cached = existsSync(executable) ? executable : name;
      return cached;
    }
  }
  cached = process.platform === "win32" ? "python" : "python3";
  return cached;
}
