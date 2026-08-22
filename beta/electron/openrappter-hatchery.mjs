import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import {
  createNeighborhoodIdentity,
  ensureNeighborhoodManifest,
} from "./neighborhood-identity.mjs";

export const OPENRAPPTER_TWIN_SCHEMA = "openrappter-twin/1.0";
const SLUG = /^[a-z][a-z0-9-]{2,63}$/;
const MAX_CHILD_NEIGHBORHOODS = 32;
const MAX_NEIGHBORHOOD_GENERATION = 8;
const EXCLUDED_NAMES = new Set([
  ".brainstem_data",
  ".copilot_token",
  ".env",
  "__pycache__",
]);

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows does not expose POSIX modes.
  }
}

function atomicPrivateJson(file, value) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
}

function safeSlug(value) {
  const source = String(value || "").trim();
  if (!source || /[\\/\0]|\.\./.test(source)) {
    throw new Error("OpenRappter twin name must be a safe local name.");
  }
  const slug = source.toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!SLUG.test(slug)) {
    throw new Error("OpenRappter twin name must produce a 3-64 character slug.");
  }
  return slug;
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !["ESRCH", "EINVAL"].includes(error?.code);
  }
}

function copyRuntimeTree(source, destination) {
  const visit = (from, to) => {
    privateDirectory(to);
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      if (
        EXCLUDED_NAMES.has(entry.name)
        || entry.name.endsWith(".pyc")
      ) {
        continue;
      }
      const sourcePath = path.join(from, entry.name);
      const targetPath = path.join(to, entry.name);
      const stats = lstatSync(sourcePath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) visit(sourcePath, targetPath);
      else if (stats.isFile()) {
        copyFileSync(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE);
      }
    }
  };
  visit(source, destination);
}

function copyBirthCredential(sourceRoot, destinationRoot) {
  const source = path.join(sourceRoot, ".copilot_token");
  if (!existsSync(source)) return;
  const stats = lstatSync(source);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || (process.platform !== "win32" && (stats.mode & 0o077))
  ) {
    throw new Error("Parent Copilot token must be a private regular file.");
  }
  const destination = path.join(destinationRoot, ".copilot_token");
  if (existsSync(destination)) return;
  copyFileSync(source, destination, fsConstants.COPYFILE_FICLONE);
  try {
    chmodSync(destination, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
}

function copyPythonEnvironment(sourcePython, destinationHome) {
  const source = path.resolve(sourcePython);
  const sourceRoot = path.dirname(path.dirname(source));
  if (!existsSync(path.join(sourceRoot, "pyvenv.cfg"))) {
    throw new Error("OpenRappter hatching requires a parent virtual environment.");
  }
  const destinationRoot = path.join(destinationHome, "venv");
  const executable = path.join(
    destinationRoot,
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  if (!existsSync(destinationRoot)) {
    privateDirectory(path.dirname(destinationRoot));
    cpSync(sourceRoot, destinationRoot, {
      dereference: true,
      filter(candidate) {
        const name = path.basename(candidate);
        return name !== "__pycache__" && !name.endsWith(".pyc");
      },
      mode: fsConstants.COPYFILE_FICLONE,
      preserveTimestamps: true,
      recursive: true,
    });
  }
  if (!existsSync(executable) || !lstatSync(executable).isFile()) {
    throw new Error("Twin-owned Python environment lacks its interpreter.");
  }
  return executable;
}

function mintInstanceRappid(slug) {
  const uuidBytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  const digest = createHash("sha256")
    .update("rapp/1:rappid\n", "utf8")
    .update(uuidBytes)
    .digest("hex");
  return `rappid:@openrappter/${slug}:${digest}`;
}

function neighborhoodId(slug, rappid) {
  return `openrappter:${slug}:${String(rappid).split(":").at(-1)}`;
}

function identityAgentSource(slug, rappid) {
  const display = slug.split("-")
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return `import json
import os

from agents.basic_agent import BasicAgent

EXPECTED_RAPPID = "${rappid}"

class OpenRappterIdentityAgent(BasicAgent):
    def __init__(self):
        self.name = "OpenRappter${display}"
        self.metadata = {
            "name": self.name,
            "description": "Identifies this hatched OpenRappter twin.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        }
        super().__init__()

    def perform(self, **kwargs):
        identity_file = os.path.join(
            os.environ["BRAINSTEM_BETA_HOME"],
            "identity",
            "openrappter.json",
        )
        with open(identity_file, "r", encoding="utf-8") as handle:
            identity = json.load(handle)
        if identity.get("rappid") != EXPECTED_RAPPID:
            raise RuntimeError("OpenRappter identity authority does not match this twin")
        return identity["rappid"]
`;
}

async function requestInstanceControl(metadata, action = "probe") {
  if (
    !metadata?.beta_home
    || !metadata?.instance_token
    || !processAlive(metadata.pid)
  ) {
    return false;
  }
  try {
    const neighborhoodId = metadata.neighborhood_id
      || `openrappter:${metadata.name}`;
    const endpoint = JSON.parse(readFileSync(
      path.join(metadata.beta_home, "chat-endpoint.json"),
      "utf8",
    ));
    if (
      endpoint?.schema !== "openrappter-chat-endpoint/1.0"
      || endpoint.pid !== metadata.pid
      || endpoint.instance_token !== metadata.instance_token
      || (
        endpoint.neighborhood_id !== undefined
        && endpoint.neighborhood_id !== neighborhoodId
      )
      || !/^http:\/\/127\.0\.0\.1:\d+\/chat$/.test(String(endpoint.url || ""))
    ) {
      return false;
    }
    const response = await fetch(
      `${new URL(endpoint.url).origin}/__openrappter/control`,
      {
        method: action === "stop" ? "POST" : "GET",
        headers: {
          "x-openrappter-instance-token": metadata.instance_token,
        },
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (action === "stop") return response.status === 202;
    if (!response.ok) return false;
    const control = await response.json();
    return control?.schema === "openrappter-instance-control/1.0"
      && control.pid === metadata.pid
      && control.instance_token === metadata.instance_token
      && (
        control.neighborhood_id === undefined
        || control.neighborhood_id === neighborhoodId
      );
  } catch {
    return false;
  }
}

export class OpenRappterHatchery {
  constructor({
    brainstemRuntimeDir,
    electronPath,
    openRappterHome,
    packageDir,
    parentGeneration = 0,
    parentNeighborhoodId = "openrappter:alpha",
    packConfigPath = "",
    instanceControl = requestInstanceControl,
    copyPythonEnvironmentImpl = copyPythonEnvironment,
    processAlive: alive = processAlive,
    pythonPath,
    spawnImpl = spawn,
  } = {}) {
    if (
      !brainstemRuntimeDir
      || !electronPath
      || !openRappterHome
      || !packageDir
      || !pythonPath
    ) {
      throw new Error("OpenRappter hatchery requires runtime, Electron, home, package, and Python paths.");
    }
    this.brainstemRuntimeDir = path.resolve(brainstemRuntimeDir);
    this.electronPath = electronPath;
    this.openRappterHome = path.resolve(openRappterHome);
    this.packageDir = path.resolve(packageDir);
    this.parentGeneration = Number(parentGeneration);
    this.parentNeighborhoodId = String(parentNeighborhoodId);
    this.packConfigPath = packConfigPath ? path.resolve(packConfigPath) : "";
    this.instanceControl = instanceControl;
    this.copyPythonEnvironment = copyPythonEnvironmentImpl;
    this.processAlive = alive;
    this.pythonPath = pythonPath;
    this.spawnImpl = spawnImpl;
    this.twinsRoot = path.join(this.openRappterHome, "twins");
  }

  paths(name) {
    const slug = safeSlug(name);
    const root = path.join(this.twinsRoot, slug);
    return {
      slug,
      root,
      brainstem_home: path.join(root, "brainstem"),
      brainstem_dir: path.join(root, "brainstem", "src", "rapp_brainstem"),
      beta_home: path.join(root, "desktop"),
      user_data: path.join(root, "electron-user-data"),
      metadata_path: path.join(root, "instance.json"),
    };
  }

  readMetadata(file) {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      return value?.schema === OPENRAPPTER_TWIN_SCHEMA
        ? {
            ...value,
            neighborhood_id: value.neighborhood_id
              || `openrappter:${value.name}`,
          }
        : null;
    } catch {
      return null;
    }
  }

  async hatch(name) {
    const locations = this.paths(name);
    if (
      !Number.isSafeInteger(this.parentGeneration)
      || this.parentGeneration < 0
      || this.parentGeneration >= MAX_NEIGHBORHOOD_GENERATION
    ) {
      throw new Error(
        `OpenRappter neighborhoods are limited to ${MAX_NEIGHBORHOOD_GENERATION} generations.`,
      );
    }
    if (
      !existsSync(locations.root)
      && existsSync(this.twinsRoot)
      && readdirSync(this.twinsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
        .length >= MAX_CHILD_NEIGHBORHOODS
    ) {
      throw new Error(
        `A neighborhood may own at most ${MAX_CHILD_NEIGHBORHOODS} direct children.`,
      );
    }
    const previous = this.readMetadata(locations.metadata_path);
    if (previous && this.processAlive(previous.pid)) {
      if (await this.instanceControl(previous, "probe")) {
        throw new Error(`OpenRappter twin ${locations.slug} is already running.`);
      }
      throw new Error(
        `OpenRappter twin ${locations.slug} has a live PID whose instance capability cannot be verified; refusing to replace its authority.`,
      );
    }
    if (!existsSync(locations.brainstem_dir)) {
      copyRuntimeTree(this.brainstemRuntimeDir, locations.brainstem_dir);
    }
    copyBirthCredential(this.brainstemRuntimeDir, locations.brainstem_dir);
    const twinPythonPath = this.copyPythonEnvironment(
      this.pythonPath,
      locations.brainstem_home,
    );
    privateDirectory(locations.beta_home);
    privateDirectory(locations.user_data);
    const identityPath = path.join(
      locations.beta_home,
      "identity",
      "openrappter.json",
    );
    const existingIdentity = existsSync(identityPath)
      ? JSON.parse(readFileSync(identityPath, "utf8"))
      : null;
    const instanceRappid = previous?.instance_rappid
      || existingIdentity?.rappid
      || mintInstanceRappid(locations.slug);
    const childNeighborhoodId = neighborhoodId(
      locations.slug,
      instanceRappid,
    );
    const childGeneration = this.parentGeneration + 1;
    const createdAt = previous?.created_at
      || existingIdentity?.minted_at
      || new Date().toISOString();
    const childIdentity = createNeighborhoodIdentity(locations.slug, {
      generation: childGeneration,
      neighborhoodId: childNeighborhoodId,
      parentNeighborhoodId: this.parentNeighborhoodId,
    });
    if (existingIdentity) {
      if (
        existingIdentity?.schema !== "openrappter-identity/1.0"
        || existingIdentity.rappid !== instanceRappid
        || !new RegExp(
          `^rappid:@openrappter/${locations.slug}:[0-9a-f]{64}$`,
        ).test(instanceRappid)
      ) {
        throw new Error(
          `OpenRappter twin ${locations.slug} has conflicting persisted identity.`,
        );
      }
    } else {
      atomicPrivateJson(identityPath, {
        schema: "openrappter-identity/1.0",
        rappid: instanceRappid,
        minted_at: createdAt,
        origin: "hatched-twin",
      });
    }
    ensureNeighborhoodManifest(locations.beta_home, childIdentity, {
      now: () => new Date(createdAt),
    });
    const identityAgent = path.join(
      locations.brainstem_dir,
      "agents",
      "openrappter_identity_agent.py",
    );
    const identityTemporary = `${identityAgent}.${process.pid}.tmp`;
    writeFileSync(
      identityTemporary,
      identityAgentSource(locations.slug, instanceRappid),
      { mode: 0o600 },
    );
    renameSync(identityTemporary, identityAgent);
    const args = [
      this.packageDir,
      `--user-data-dir=${locations.user_data}`,
    ];
    const instanceToken = randomUUID();
    const child = this.spawnImpl(this.electronPath, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        OPENRAPPTER_HOME: locations.root,
        OPENRAPPTER_INSTANCE: locations.slug,
        OPENRAPPTER_INSTANCE_TOKEN: instanceToken,
        OPENRAPPTER_NEIGHBORHOOD_GENERATION: String(childGeneration),
        OPENRAPPTER_NEIGHBORHOOD_ID: childNeighborhoodId,
        OPENRAPPTER_PARENT_NEIGHBORHOOD_ID: this.parentNeighborhoodId,
        BRAINSTEM_HOME: locations.brainstem_home,
        BRAINSTEM_BETA_HOME: locations.beta_home,
        BRAINSTEM_BETA_SOURCE_DIR: locations.brainstem_dir,
        BRAINSTEM_BETA_PYTHON: twinPythonPath,
        BRAINSTEM_BETA_OWN_PORT: "1",
        ...(this.packConfigPath
          ? { RAPPTER_PACK_CONFIG: this.packConfigPath }
          : {}),
      },
    });
    child.unref();
    const metadata = {
      schema: OPENRAPPTER_TWIN_SCHEMA,
      name: locations.slug,
      instance_rappid: instanceRappid,
      neighborhood_id: childNeighborhoodId,
      parent_neighborhood_id: this.parentNeighborhoodId,
      generation: childGeneration,
      created_at: createdAt,
      launched_at: new Date().toISOString(),
      pid: child.pid,
      instance_token: instanceToken,
      root: locations.root,
      brainstem_home: locations.brainstem_home,
      brainstem_dir: locations.brainstem_dir,
      beta_home: locations.beta_home,
      user_data: locations.user_data,
      python: twinPythonPath,
      metadata_path: locations.metadata_path,
    };
    atomicPrivateJson(locations.metadata_path, metadata);
    return metadata;
  }

  async list() {
    if (!existsSync(this.twinsRoot)) return [];
    const entries = readdirSync(this.twinsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SLUG.test(entry.name))
      .map((entry) => this.readMetadata(
        path.join(this.twinsRoot, entry.name, "instance.json"),
      ))
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name));
    return Promise.all(entries.map(async (entry) => ({
      ...entry,
      running: this.processAlive(entry.pid)
        && await this.instanceControl(entry, "probe"),
    })));
  }

  async stop(name) {
    const locations = this.paths(name);
    const metadata = this.readMetadata(locations.metadata_path);
    if (!metadata || !this.processAlive(metadata.pid)) {
      return { name: locations.slug, stopped: false, reason: "not running" };
    }
    const stopped = await this.instanceControl(metadata, "stop");
    if (!stopped) {
      return {
        name: locations.slug,
        stopped: false,
        reason: "instance capability could not be verified",
      };
    }
    return { name: locations.slug, stopped: true, pid: metadata.pid };
  }

  recover(name) {
    const locations = this.paths(name);
    const metadata = this.readMetadata(locations.metadata_path);
    if (!metadata) {
      return {
        name: locations.slug,
        recovered: false,
        reason: "no durable metadata",
      };
    }
    if (this.processAlive(metadata.pid)) {
      throw new Error(
        `OpenRappter twin ${locations.slug} still has a live PID; stale recovery is fail-closed.`,
      );
    }
    if (!new RegExp(
      `^rappid:@openrappter/${locations.slug}:[0-9a-f]{64}$`,
    ).test(String(metadata.instance_rappid || ""))) {
      throw new Error("Dead neighborhood metadata carries an invalid RAPPID.");
    }
    const identityPath = path.join(
      locations.beta_home,
      "identity",
      "openrappter.json",
    );
    let identity = null;
    if (existsSync(identityPath)) {
      try {
        identity = JSON.parse(readFileSync(identityPath, "utf8"));
      } catch {
        identity = null;
      }
    }
    const repairIdentity = (
      identity?.schema !== "openrappter-identity/1.0"
      || identity?.rappid !== metadata.instance_rappid
    );
    const stamp = Date.now();
    const archive = `${locations.metadata_path}.stale-${stamp}`;
    let identityArchive = null;
    let identityWritten = false;
    try {
      if (repairIdentity) {
        if (existsSync(identityPath)) {
          identityArchive = `${identityPath}.stale-${stamp}`;
          renameSync(identityPath, identityArchive);
        }
        atomicPrivateJson(identityPath, {
          schema: "openrappter-identity/1.0",
          rappid: metadata.instance_rappid,
          minted_at: metadata.created_at,
          origin: "recovered-dead-neighborhood",
        });
        identityWritten = true;
      }
      renameSync(locations.metadata_path, archive);
    } catch (error) {
      if (identityWritten) rmSync(identityPath, { force: true });
      if (identityArchive && existsSync(identityArchive)) {
        renameSync(identityArchive, identityPath);
      }
      if (existsSync(archive) && !existsSync(locations.metadata_path)) {
        renameSync(archive, locations.metadata_path);
      }
      throw error;
    }
    return {
      name: locations.slug,
      recovered: true,
      archive,
      identity_archive: identityArchive,
    };
  }
}
