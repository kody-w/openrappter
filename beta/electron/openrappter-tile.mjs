import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const OPENRAPPTER_TILE_SCHEMA = "openrappter-local-tile/1.0";
export const OPENRAPPTER_TILE_EXTENSION = ".openrappter.tile";
export const MAX_OPENRAPPTER_TILE_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_OPENRAPPTER_TILE_BYTES = 32 * 1024 * 1024;
export const MAX_OPENRAPPTER_TILE_FILES = 2_000;

const AGENT_FILE = /\.(?:py|card|tile)$/i;
const DATA_FILE = /\.jsonl?$/i;
const OPENRAPPTER_RAPPID = /^rappid:@openrappter\/[a-z][a-z0-9-]{0,99}:[0-9a-f]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Windows does not expose POSIX modes.
  }
}

function atomicWritePrivate(file, bytes) {
  privateDirectory(path.dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, bytes, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }

  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows does not expose POSIX modes.
  }
  return file;
}

function safeManagedRoot(value, label) {
  const resolved = path.resolve(String(value || ""));
  const parsed = path.parse(resolved);
  const components = resolved.slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean);
  let cursor = parsed.root;
  let index = 0;
  if (components.length) {
    const platformRoot = path.join(cursor, components[0]);
    if (existsSync(platformRoot)) {
      cursor = realpathSync(platformRoot);
      if (!lstatSync(cursor).isDirectory()) {
        throw new Error(`${label} contains a non-directory path component: ${cursor}.`);
      }
      index = 1;
    }
  }
  for (; index < components.length; index += 1) {
    const component = components[index];
    cursor = path.join(cursor, component);
    if (!existsSync(cursor)) break;
    const stats = lstatSync(cursor);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} contains a symlinked path component: ${cursor}.`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${label} contains a non-directory path component: ${cursor}.`);
    }
  }
  for (index += 1; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
  }
  return cursor;
}

function pathContains(parent, child) {
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

function portablePath(value) {
  const candidate = String(value || "");
  const parts = candidate.split("/");
  if (
    !candidate
    || candidate.includes("\\")
    || candidate.includes("\0")
    || path.posix.isAbsolute(candidate)
    || parts.some((part) => (
      !part || part === "." || part === ".." || part.startsWith(".")
    ))
  ) {
    throw new Error(`OpenRappter tile path is not a safe relative path: ${candidate}`);
  }
  if (
    candidate === "brainstem/soul.md"
    || /^brainstem\/agents\/[^/][^]*\.(?:py|card|tile)$/i.test(candidate)
    || /^brainstem\/data\/[^/][^]*\.jsonl?$/i.test(candidate)
    || candidate === "openrappter/settings.json"
    || candidate === "openrappter/neighborhood.json"
    || /^openrappter\/routing\/[^/][^]*\.jsonl?$/i.test(candidate)
    || /^openrappter\/tiles\/[^/][^]*\.json$/i.test(candidate)
  ) {
    return candidate;
  }
  throw new Error(`OpenRappter tile path is outside the state allowlist: ${candidate}`);
}

function strictBase64(value, label) {
  const source = String(value || "");
  if (
    source.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source)
  ) {
    throw new Error(`${label} is not canonical base64.`);
  }
  const bytes = Buffer.from(source, "base64");
  if (bytes.toString("base64") !== source) {
    throw new Error(`${label} is not canonical base64.`);
  }
  return bytes;
}

function contentHash(files) {
  return sha256(Buffer.from(JSON.stringify(files.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes,
    sha256: entry.sha256,
  }))), "utf8"));
}

function mintOpenRappterRappid() {
  const bytes = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
  const digest = createHash("sha256")
    .update("rapp/1:rappid\n", "utf8")
    .update(bytes)
    .digest("hex");
  return `rappid:@openrappter/local:${digest}`;
}

function normalizeEntry(value, seen) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Every OpenRappter tile file must be an object.");
  }
  const entryPath = portablePath(value.path);
  if (seen.has(entryPath)) {
    throw new Error(`OpenRappter tile contains duplicate path ${entryPath}.`);
  }
  seen.add(entryPath);
  const bytes = strictBase64(value.content_base64, entryPath);
  if (bytes.length > MAX_OPENRAPPTER_TILE_FILE_BYTES) {
    throw new Error(`${entryPath} exceeds the per-file byte limit.`);
  }
  if (!Number.isSafeInteger(value.bytes) || value.bytes !== bytes.length) {
    throw new Error(`${entryPath} byte count does not match its content.`);
  }
  const digest = sha256(bytes);
  if (value.sha256 !== digest) {
    throw new Error(`${entryPath} sha256 does not match its content.`);
  }
  return {
    path: entryPath,
    bytes: bytes.length,
    sha256: digest,
    content_base64: bytes.toString("base64"),
  };
}

export function verifyOpenRappterTile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("An OpenRappter tile must be an object.");
  }
  if (value.schema !== OPENRAPPTER_TILE_SCHEMA) {
    throw new Error(`OpenRappter tile must use ${OPENRAPPTER_TILE_SCHEMA}.`);
  }
  if (value.kind !== "openrappter.local" || value.local !== true) {
    throw new Error("This artifact is not a local OpenRappter tile.");
  }
  if (!Number.isFinite(Date.parse(String(value.created_at || "")))) {
    throw new Error("OpenRappter tile created_at must be fixed UTC.");
  }
  if (!Array.isArray(value.files) || value.files.length > MAX_OPENRAPPTER_TILE_FILES) {
    throw new Error(`OpenRappter tiles are limited to ${MAX_OPENRAPPTER_TILE_FILES} files.`);
  }
  const seen = new Set();
  const files = value.files.map((entry) => normalizeEntry(entry, seen));
  const totalBytes = files.reduce((total, entry) => total + entry.bytes, 0);
  if (totalBytes > MAX_OPENRAPPTER_TILE_BYTES) {
    throw new Error(`OpenRappter tile exceeds the ${MAX_OPENRAPPTER_TILE_BYTES} byte limit.`);
  }
  if (files.some((entry, index) => index > 0 && files[index - 1].path >= entry.path)) {
    throw new Error("OpenRappter tile files must be sorted by unique path.");
  }
  const digest = contentHash(files);
  if (value.content_hash !== digest) {
    throw new Error("OpenRappter tile content_hash does not describe its files.");
  }
  if (!OPENRAPPTER_RAPPID.test(String(value.rappid || ""))) {
    throw new Error("OpenRappter tile carries an invalid RAPPID.");
  }
  if (
    value.summary?.files !== files.length
    || value.summary?.bytes !== totalBytes
  ) {
    throw new Error("OpenRappter tile summary does not describe its files.");
  }
  return value;
}

function collectDirectory(root, virtualRoot, accepts, entries) {
  if (!existsSync(root)) return;
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`OpenRappter tile managed root is not a real directory: ${root}.`);
  }
  const visit = (directory, relative = "") => {
    for (const item of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (item.name.startsWith(".") || item.name === "__pycache__") continue;
      const diskPath = path.join(directory, item.name);
      const child = relative ? `${relative}/${item.name}` : item.name;
      const stats = lstatSync(diskPath);
      if (stats.isSymbolicLink()) {
        throw new Error(`OpenRappter tile managed path is a symlink: ${diskPath}.`);
      }
      if (stats.isDirectory()) {
        visit(diskPath, child);
      } else if (stats.isFile() && accepts(child)) {
        entries.push({ diskPath, tilePath: `${virtualRoot}/${child}` });
      }
    }
  };
  visit(root);
}

function managedCandidates({ betaHome, brainstemDir }) {
  const candidates = [];
  const addFile = (diskPath, tilePath) => {
    if (!existsSync(diskPath)) return;
    const stats = lstatSync(diskPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`OpenRappter tile managed file is not a regular file: ${diskPath}.`);
    }
    candidates.push({ diskPath, tilePath });
  };

  addFile(path.join(brainstemDir, "soul.md"), "brainstem/soul.md");
  collectDirectory(
    path.join(brainstemDir, "agents"),
    "brainstem/agents",
    (relative) => AGENT_FILE.test(relative),
    candidates,
  );
  collectDirectory(
    path.join(brainstemDir, ".brainstem_data"),
    "brainstem/data",
    (relative) => DATA_FILE.test(relative),
    candidates,
  );
  addFile(path.join(betaHome, "settings.json"), "openrappter/settings.json");
  addFile(
    path.join(betaHome, "neighborhood.json"),
    "openrappter/neighborhood.json",
  );
  collectDirectory(
    path.join(betaHome, "routing"),
    "openrappter/routing",
    (relative) => DATA_FILE.test(relative),
    candidates,
  );
  collectDirectory(
    path.join(betaHome, "tiles"),
    "openrappter/tiles",
    (relative) => relative.endsWith(".json"),
    candidates,
  );
  return candidates.sort((left, right) => (
    left.tilePath.localeCompare(right.tilePath)
  ));
}

function readManagedFiles(store) {
  const candidates = managedCandidates(store);
  const entries = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    const stats = statSync(candidate.diskPath);
    if (stats.size > MAX_OPENRAPPTER_TILE_FILE_BYTES) {
      throw new Error(`${candidate.tilePath} exceeds the per-file byte limit.`);
    }
    const bytes = readFileSync(candidate.diskPath);
    totalBytes += bytes.length;
    if (entries.length >= MAX_OPENRAPPTER_TILE_FILES) {
      throw new Error(`OpenRappter tiles are limited to ${MAX_OPENRAPPTER_TILE_FILES} files.`);
    }
    if (totalBytes > MAX_OPENRAPPTER_TILE_BYTES) {
      throw new Error(`OpenRappter tile exceeds the ${MAX_OPENRAPPTER_TILE_BYTES} byte limit.`);
    }
    entries.push({
      path: portablePath(candidate.tilePath),
      bytes: bytes.length,
      sha256: sha256(bytes),
      content_base64: bytes.toString("base64"),
    });
  }
  return entries;
}

function destinationInfoFor({ betaHome, brainstemDir }, virtual) {
  const entryPath = portablePath(virtual);
  const mappings = [
    ["brainstem/soul.md", path.join(brainstemDir, "soul.md"), true],
    ["brainstem/agents/", path.join(brainstemDir, "agents"), false],
    ["brainstem/data/", path.join(brainstemDir, ".brainstem_data"), false],
    ["openrappter/neighborhood.json", path.join(betaHome, "neighborhood.json"), true],
    ["openrappter/settings.json", path.join(betaHome, "settings.json"), true],
    ["openrappter/routing/", path.join(betaHome, "routing"), false],
    ["openrappter/tiles/", path.join(betaHome, "tiles"), false],
  ];
  for (const [prefix, root, exact] of mappings) {
    if (exact && entryPath === prefix) {
      return { destination: root, root: path.dirname(root) };
    }
    if (!exact && entryPath.startsWith(prefix)) {
      const relative = entryPath.slice(prefix.length).split("/");
      const destination = path.resolve(root, ...relative);
      const boundary = `${path.resolve(root)}${path.sep}`;
      if (!destination.startsWith(boundary)) {
        throw new Error(`${entryPath} escapes its managed state directory.`);
      }
      return { destination, root };
    }

  }
  throw new Error(`${entryPath} is outside the OpenRappter state allowlist.`);
}

function destinationFor(store, virtual) {
  return destinationInfoFor(store, virtual).destination;
}

function assertSafeManagedDestination(root, destination) {
  const resolvedRoot = path.resolve(root);
  const resolvedDestination = path.resolve(destination);
  const relative = path.relative(resolvedRoot, resolvedDestination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${destination} escapes its managed state root.`);
  }
  const candidates = [resolvedRoot];
  let current = resolvedRoot;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    candidates.push(current);
  }
  for (const [index, candidate] of candidates.entries()) {
    if (!existsSync(candidate)) continue;
    const stats = lstatSync(candidate);
    if (stats.isSymbolicLink()) {
      throw new Error(`OpenRappter tile refuses symlink managed path ${candidate}.`);
    }
    const final = index === candidates.length - 1;
    if (!final && !stats.isDirectory()) {
      throw new Error(`OpenRappter tile managed ancestor is not a directory: ${candidate}.`);
    }
    if (final && candidate === resolvedDestination && !stats.isFile()) {
      throw new Error(`OpenRappter tile destination is not a regular file: ${candidate}.`);
    }
  }
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export class OpenRappterTileStore {
  constructor({
    betaHome,
    brainstemDir,
    now = () => new Date(),
  } = {}) {
    if (!betaHome || !brainstemDir) {
      throw new Error("OpenRappter tile storage requires betaHome and brainstemDir.");
    }
    this.betaHome = safeManagedRoot(betaHome, "OpenRappter tile betaHome");
    this.brainstemDir = safeManagedRoot(
      brainstemDir,
      "OpenRappter tile brainstemDir",
    );
    if (
      pathContains(this.betaHome, this.brainstemDir)
      || pathContains(this.brainstemDir, this.betaHome)
    ) {
      throw new Error("OpenRappter tile managed roots must not overlap.");
    }
    this.now = now;
    this.backupDirectory = path.join(this.betaHome, "backups");
    this.identityPath = path.join(
      this.betaHome,
      "identity",
      "openrappter.json",
    );
  }

  identity() {
    if (existsSync(this.identityPath)) {
      let value;
      try {
        value = JSON.parse(readFileSync(this.identityPath, "utf8"));
      } catch (error) {
        throw new Error(`OpenRappter identity is unreadable: ${error.message}`);
      }
      if (
        value?.schema !== "openrappter-identity/1.0"
        || !OPENRAPPTER_RAPPID.test(String(value.rappid || ""))
      ) {
        throw new Error("OpenRappter identity file is invalid.");
      }
      return value;
    }
    const value = {
      schema: "openrappter-identity/1.0",
      rappid: mintOpenRappterRappid(),
      minted_at: this.now().toISOString(),
    };
    atomicWritePrivate(
      this.identityPath,
      `${JSON.stringify(value, null, 2)}\n`,
    );
    return value;
  }

  createTile() {
    const files = readManagedFiles(this);
    const digest = contentHash(files);
    const identity = this.identity();
    return {
      schema: OPENRAPPTER_TILE_SCHEMA,
      kind: "openrappter.local",
      local: true,
      created_at: this.now().toISOString(),
      rappid: identity.rappid,
      content_hash: digest,
      summary: {
        files: files.length,
        bytes: files.reduce((total, entry) => total + entry.bytes, 0),
      },
      files,
    };
  }

  describe() {
    const tile = this.createTile();
    return {
      schema: tile.schema,
      rappid: tile.rappid,
      content_hash: tile.content_hash,
      files: tile.summary.files,
      bytes: tile.summary.bytes,
      backups: this.listBackups().length,
    };
  }

  exportTile(file) {
    const target = path.resolve(String(file || ""));
    if (!target.endsWith(OPENRAPPTER_TILE_EXTENSION)) {
      throw new Error(`OpenRappter tile exports must end in ${OPENRAPPTER_TILE_EXTENSION}.`);
    }
    const tile = this.createTile();
    atomicWritePrivate(target, `${JSON.stringify(tile, null, 2)}\n`);
    return { file: target, tile };
  }

  readTile(file) {
    const target = path.resolve(String(file || ""));
    const stats = statSync(target);
    if (stats.size > MAX_OPENRAPPTER_TILE_BYTES * 2) {
      throw new Error("OpenRappter tile file is too large.");
    }
    let value;
    try {
      value = JSON.parse(readFileSync(target, "utf8"));
    } catch (error) {
      throw new Error(`OpenRappter tile is not readable JSON: ${error.message}`);
    }
    verifyOpenRappterTile(value);
    return value;
  }

  nextBackupPath() {
    privateDirectory(this.backupDirectory);
    const base = `OpenRappter-${stamp(this.now())}`;
    let index = 0;
    let candidate = path.join(
      this.backupDirectory,
      `${base}-${String(index).padStart(3, "0")}${OPENRAPPTER_TILE_EXTENSION}`,
    );
    while (existsSync(candidate)) {
      index += 1;
      candidate = path.join(
        this.backupDirectory,
        `${base}-${String(index).padStart(3, "0")}${OPENRAPPTER_TILE_EXTENSION}`,
      );
    }
    return candidate;
  }

  backup() {
    return this.exportTile(this.nextBackupPath()).file;
  }

  listBackups() {
    if (!existsSync(this.backupDirectory)) return [];
    return readdirSync(this.backupDirectory)
      .filter((name) => name.endsWith(OPENRAPPTER_TILE_EXTENSION))
      .sort()
      .reverse()
      .map((name) => path.join(this.backupDirectory, name));
  }

  applyTile(tile) {
    verifyOpenRappterTile(tile);
    for (const entry of tile.files) {
      const destination = destinationFor(this, entry.path);
      const bytes = strictBase64(entry.content_base64, entry.path);
      atomicWritePrivate(destination, bytes);
    }
  }

  importTile(file, { adoptIdentity = false } = {}) {
    const tile = this.readTile(file);
    let adoptedIdentity = false;
    if (existsSync(this.identityPath)) {
      const localIdentity = this.identity();
      if (tile.rappid !== localIdentity.rappid) {
        throw new Error(
          "OpenRappter tile belongs to another RAPPID; hatch a twin for that identity instead of overwriting this one.",
        );
      }
    } else if (!adoptIdentity) {
      throw new Error(
        "OpenRappter identity is missing; use the explicit adopt operation to recover this verified tile.",
      );
    } else {
      atomicWritePrivate(
        this.identityPath,
        `${JSON.stringify({
          schema: "openrappter-identity/1.0",
          rappid: tile.rappid,
          minted_at: tile.created_at,
          origin: "adopted-from-verified-tile",
        }, null, 2)}\n`,
      );
      adoptedIdentity = true;
    }
    try {
      return this.importVerifiedTile(tile);
    } catch (error) {
      if (adoptedIdentity) rmSync(this.identityPath, { force: true });
      throw error;
    }
  }

  importVerifiedTile(tile) {
    const backup = this.backup();
    const incoming = new Map(tile.files.map((entry) => {
      const info = destinationInfoFor(this, entry.path);
      assertSafeManagedDestination(info.root, info.destination);
      return [entry.path, info.destination];
    }));
    const current = managedCandidates(this);
    const destinations = new Set([
      ...incoming.values(),
      ...current.map((entry) => entry.diskPath),
    ]);
    const snapshots = new Map([...destinations].map((destination) => {
      if (!existsSync(destination)) return [destination, null];
      const stats = lstatSync(destination);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new Error(`OpenRappter tile snapshot is not a regular file: ${destination}.`);
      }
      return [destination, {
        bytes: readFileSync(destination),
        mode: stats.mode & 0o777,
      }];
    }));
    try {
      this.applyTile(tile);
      for (const entry of current) {
        if (!incoming.has(entry.tilePath)) rmSync(entry.diskPath, { force: true });
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const [destination, snapshot] of snapshots) {
        try {
          if (snapshot === null) rmSync(destination, { force: true });
          else {
            atomicWritePrivate(destination, snapshot.bytes);
            try {
              chmodSync(destination, snapshot.mode);
            } catch {
              // Windows does not expose POSIX modes.
            }
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${destination}: ${rollbackError.message}`);
        }
      }
      if (rollbackErrors.length) {
        throw new Error(
          `OpenRappter tile import failed: ${error.message}; rollback failed: ${rollbackErrors.join("; ")}`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      // Re-read the managed set so a successful import is proven exact before
      // it is reported as restored.
      const restored = this.createTile();
      if (restored.content_hash !== tile.content_hash) {
        throw new Error("restored OpenRappter tile does not match the imported content hash");
      }
    } catch (error) {
      const rollbackErrors = [];
      for (const [destination, snapshot] of snapshots) {
        try {
          if (snapshot === null) rmSync(destination, { force: true });
          else {
            atomicWritePrivate(destination, snapshot.bytes);
            try {
              chmodSync(destination, snapshot.mode);
            } catch {
              // Windows does not expose POSIX modes.
            }
          }
        } catch (rollbackError) {
          rollbackErrors.push(`${destination}: ${rollbackError.message}`);
        }
      }
      if (rollbackErrors.length) {
        throw new Error(
          `OpenRappter tile verification failed: ${error.message}; rollback failed: ${rollbackErrors.join("; ")}`,
          { cause: error },
        );
      }
      try {
        this.applyTile(this.readTile(backup));
      } catch {
        // The byte snapshots above are the transaction rollback. The backup is
        // retained for human recovery even if reapplying it is unnecessary.
      }
      throw error;
    }
    return {
      backup,
      imported: tile.files.length,
      rappid: tile.rappid,
      restartRequired: true,
    };
  }
}
