/**
 * Browsing and editing the files an agent is made of.
 *
 * This backs `agents.files.list` / `agents.files.read` / `agents.files.write`.
 * Every one of those paths comes from a browser, and the directory they point
 * at is the one `AgentRegistry` hot-loads `*.py` and `*_agent.js` from — so a
 * write here is not "saving a document", it is handing the organism code it
 * will execute. The guards below are written for that reading of the feature.
 *
 * What they enforce, and why each one exists:
 *
 *  1. **Resolve, then contain.** A prefix check on the raw string is
 *     bypassable (`../` segments, absolute paths, a symlink that leaves the
 *     tree). Every path is resolved to a real path first — including the
 *     deepest existing ancestor when the leaf does not exist — and only then
 *     checked for containment with `path.relative`, never `startsWith`.
 *  2. **Reserved directories stay reserved.** `disabled_agents/` and
 *     `experimental_agents/` are the documented way to switch an agent off
 *     (KERNEL §2.3, `RESERVED_AGENT_DIRS`). A write API that can reach into
 *     them turns "I disabled that" into a lie, so they are refused as an
 *     agentId, skipped when listing, and rejected on read and write.
 *  3. **Write edits, it does not plant.** The target must already exist as a
 *     regular file. Creating a new file in the loaded agents tree is what
 *     `/agents/import` is for: that path verifies the agent by loading it and
 *     rolls back when it fails. Nothing here can verify a write, so it may
 *     only change bytes in a file the tree already loads.
 *  4. **Symlinks are never followed on write** and never escape on read.
 */

import fs from 'fs/promises';
import path from 'path';
import { isReservedAgentPath, RESERVED_AGENT_DIRS } from './reserved-paths.js';

/** One browsable file, as the dashboard's file tab renders it. */
export interface AgentFileEntry {
  name: string;
  /** Always relative to the agent workspace, POSIX separators. */
  path: string;
  size: number;
  modified: string;
}

/** Refuse to stream something enormous into a browser text area. */
export const MAX_AGENT_FILE_BYTES = 1024 * 1024;

/** A listing is a browser sidebar, not a filesystem crawl. */
const MAX_LISTED_FILES = 500;

/** Directories that are never part of an agent's editable surface. */
const SKIPPED_DIRS = new Set<string>([...RESERVED_AGENT_DIRS, 'node_modules', '__pycache__']);

/** True when `target` is `root` or sits underneath it. */
function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The real path of `target`, resolving as much of it as exists.
 *
 * `fs.realpath` throws on a path whose leaf is missing, which is exactly the
 * case a naive guard skips — and skipping it is how `a-symlink/../../etc` gets
 * through. So the deepest existing ancestor is resolved and the missing tail is
 * re-appended, giving a path that is honest about every symlink on the way.
 */
async function realpathAsFarAsPossible(target: string): Promise<string> {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return missing.length ? path.join(real, ...missing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything real.
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  if (value.includes('\0')) throw new Error(`${field} contains an invalid character`);
  return value;
}

/**
 * The directory an agent's files live in.
 *
 * `<root>/<agentId>` when the agent has a folder of its own (a swarm or stack
 * keeps several files together); otherwise the user agents directory itself,
 * which is where a single-file agent sits. Both are inside `root`, and that is
 * what everything downstream is contained to.
 */
export async function resolveAgentWorkspace(root: string, agentId: unknown): Promise<string> {
  const id = requireString(agentId, 'agentId');

  if (/[\\/]/.test(id)) throw new Error(`Invalid agentId: ${id}`);
  if (id === '.' || id === '..') throw new Error(`Invalid agentId: ${id}`);
  // An agentId naming a reserved directory would make the whole disabled tree
  // browsable and writable — the one thing reserving it was supposed to stop.
  if (isReservedAgentPath(id)) {
    throw new Error(`${id} is a reserved agent directory, not an agent`);
  }

  const realRoot = await realpathAsFarAsPossible(root);
  const candidate = path.join(realRoot, id);
  const realCandidate = await realpathAsFarAsPossible(candidate);

  if (isInside(realRoot, realCandidate)) {
    try {
      const stat = await fs.stat(realCandidate);
      if (stat.isDirectory()) return realCandidate;
    } catch {
      // No folder of its own — fall through to the flat layout.
    }
  }

  return realRoot;
}

/**
 * Turn a client-supplied relative path into an absolute one inside `workspace`,
 * or throw. This is the single choke point every read and write goes through.
 */
async function resolveInsideWorkspace(workspace: string, relPath: unknown): Promise<string> {
  const raw = requireString(relPath, 'path');

  if (path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) {
    throw new Error(`Path must be relative to the agent directory: ${raw}`);
  }

  const segments = raw.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) throw new Error('path is required');
  if (segments.includes('..')) {
    throw new Error(`Path escapes the agent directory: ${raw}`);
  }
  if (isReservedAgentPath(raw)) {
    throw new Error(`${raw} is inside a reserved agent directory`);
  }

  const target = path.resolve(workspace, segments.join(path.sep));
  const realTarget = await realpathAsFarAsPossible(target);
  const realWorkspace = await realpathAsFarAsPossible(workspace);

  // The check that matters: after every symlink and `..` has been resolved,
  // is this still inside the directory the caller was granted?
  if (!isInside(realWorkspace, realTarget) || realTarget === realWorkspace) {
    throw new Error(`Path escapes the agent directory: ${raw}`);
  }

  return realTarget;
}

async function walk(dir: string, prefix: string, out: AgentFileEntry[]): Promise<void> {
  if (out.length >= MAX_LISTED_FILES) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= MAX_LISTED_FILES) return;
    // A symlink is not listed at all. Following one is how a listing starts
    // describing files outside the tree it claims to describe.
    if (entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      await walk(path.join(dir, entry.name), rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(path.join(dir, entry.name));
      out.push({
        name: entry.name,
        path: rel,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    } catch {
      // Vanished between readdir and stat; nothing to report.
    }
  }
}

/** Files belonging to `agentId`. Empty when the agent has none — not an error. */
export async function listAgentFiles(root: string, agentId: unknown): Promise<AgentFileEntry[]> {
  const workspace = await resolveAgentWorkspace(root, agentId);
  const out: AgentFileEntry[] = [];
  await walk(workspace, '', out);
  return out;
}

/** The text of one file inside the agent's directory. */
export async function readAgentFile(
  root: string,
  agentId: unknown,
  relPath: unknown,
): Promise<string> {
  const workspace = await resolveAgentWorkspace(root, agentId);
  const target = await resolveInsideWorkspace(workspace, relPath);

  const stat = await fs.stat(target).catch(() => null);
  if (!stat) throw new Error(`No such agent file: ${String(relPath)}`);
  if (!stat.isFile()) throw new Error(`Not a file: ${String(relPath)}`);
  if (stat.size > MAX_AGENT_FILE_BYTES) {
    throw new Error(`File is too large to edit (${stat.size} bytes)`);
  }

  return fs.readFile(target, 'utf-8');
}

/**
 * Replace the contents of an existing agent file.
 *
 * Deliberately cannot create files: see the header. The caller is expected to
 * have gated this on a credential (`requiresAuth`), because the bytes written
 * here are executed by the next registry sweep.
 */
export async function writeAgentFile(
  root: string,
  agentId: unknown,
  relPath: unknown,
  content: unknown,
): Promise<{ written: true; path: string; bytes: number }> {
  if (typeof content !== 'string') throw new Error('content must be a string');
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes > MAX_AGENT_FILE_BYTES) {
    throw new Error(`Refusing to write ${bytes} bytes; limit is ${MAX_AGENT_FILE_BYTES}`);
  }

  const workspace = await resolveAgentWorkspace(root, agentId);
  const target = await resolveInsideWorkspace(workspace, relPath);

  // lstat, not stat: writing through a symlink would put these bytes wherever
  // the link points, which containment has no say over once the write starts.
  const link = await fs.lstat(target).catch(() => null);
  if (!link) {
    throw new Error(
      `No such agent file: ${String(relPath)}. Use /agents/import to install a new agent —`
      + ' it verifies the file by loading it and rolls back when it fails.',
    );
  }
  if (link.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${String(relPath)}`);
  if (!link.isFile()) throw new Error(`Not a file: ${String(relPath)}`);

  await fs.writeFile(target, content, 'utf-8');
  return { written: true, path: path.relative(workspace, target).split(path.sep).join('/'), bytes };
}
