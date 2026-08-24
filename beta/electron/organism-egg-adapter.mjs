import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const MAX_OUTPUT = 2 * 1024 * 1024;

/**
 * Typed seam between the Quantum RAPPID/XPedition shell and the installed
 * OpenRappter organism-egg implementation. The desktop never parses or
 * extracts egg content itself; the installed CLI remains the single verifier.
 */
export class OrganismEggAdapter {
  constructor({ openRappterHome, packageDir, cliPath = process.env.OPENRAPPTER_CLI } = {}) {
    if (!openRappterHome || !packageDir) {
      throw new Error("OrganismEggAdapter requires openRappterHome and packageDir.");
    }
    this.openRappterHome = path.resolve(openRappterHome);
    const developmentCli = path.resolve(
      packageDir,
      "..",
      "typescript",
      "bin",
      "openrappter.mjs",
    );
    this.cliPath = cliPath || (existsSync(developmentCli) ? developmentCli : "openrappter");
    this.capabilities = Object.freeze({
      inspect: true,
      exportPortable: true,
      exportSealed: true,
      previewImport: true,
      applyImport: true,
      semanticControlMayApplySealed: false,
      requiredDesktop: "0.1.0-beta.11",
    });
  }

  command(args, { passphrase } = {}) {
    const script = this.cliPath.endsWith(".mjs");
    const command = script ? process.execPath : this.cliPath;
    const commandArgs = script ? [this.cliPath, ...args] : args;
    return new Promise((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          OPENRAPPTER_HOME: this.openRappterHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let size = 0;
      const collect = (target) => (chunk) => {
        size += chunk.length;
        if (size > MAX_OUTPUT) {
          child.kill();
          reject(new Error("OpenRappter egg command exceeded its output limit."));
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.on("error", reject);
      child.on("close", (code) => {
        const errorText = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) {
          reject(new Error(errorText || `OpenRappter egg command exited ${code}.`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")));
        } catch {
          reject(new Error("OpenRappter egg command did not return typed JSON."));
        }
      });
      if (passphrase !== undefined) child.stdin.end(`${passphrase}\n`);
      else child.stdin.end();
    });
  }

  inspect(file, { passphrase } = {}) {
    return this.command([
      "egg", "inspect", file, "--json",
      ...(passphrase ? ["--decrypt", "--passphrase-stdin"] : []),
    ], { passphrase });
  }

  export(file, { mode, includeHistory = false, includeMedia = false, passphrase } = {}) {
    return this.command([
      "egg", "export", "--mode", mode, "--output", file, "--json",
      ...(includeHistory ? ["--include-history"] : []),
      ...(includeMedia ? ["--include-media"] : []),
      ...(mode === "sealed-backup" ? ["--passphrase-stdin"] : []),
    ], { passphrase });
  }

  preview(file, { semantics = "restore", passphrase } = {}) {
    return this.command([
      "egg", "import", file, "--preview", "--semantics", semantics, "--json",
      ...(passphrase ? ["--passphrase-stdin"] : []),
    ], { passphrase });
  }

  apply(file, { semantics = "restore", approval, passphrase } = {}) {
    return this.command([
      "egg", "import", file, "--apply", "--semantics", semantics,
      "--approval", approval, "--passphrase-stdin", "--json",
    ], { passphrase });
  }
}
