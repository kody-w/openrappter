import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";


export function betaSourceFingerprint(
  repoRoot = path.resolve(import.meta.dirname, "..", ".."),
) {
  const git = (args) => execFileSync(
    "git",
    ["-C", repoRoot, ...args],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  let head = null;
  let runtimeKind = "tree";
  let files;
  try {
    head = git(["rev-parse", "HEAD"]);
    files = execFileSync(
      "git",
      [
        "-C",
        repoRoot,
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        "beta",
      ],
      { encoding: "buffer", windowsHide: true },
    )
      .toString("utf8")
      .split("\0")
      .filter((file) => (
        file
        && file !== "beta/node_modules"
        && !file.startsWith("beta/node_modules/")
        && file !== "beta/release"
        && !file.startsWith("beta/release/")
        && existsSync(path.join(repoRoot, file))
      ))
      .sort();
    runtimeKind = "git";
  } catch {
    const betaRoot = existsSync(path.join(repoRoot, "beta"))
      ? path.join(repoRoot, "beta")
      : repoRoot;
    const collect = (directory) => readdirSync(directory, {
      withFileTypes: true,
    }).flatMap((entry) => {
      if (["node_modules", "release"].includes(entry.name)) return [];
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? collect(absolute) : [absolute];
    });
    files = collect(betaRoot)
      .map((file) => path.relative(repoRoot, file))
      .sort();
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(path.join(repoRoot, file)));
    hash.update("\0");
  }
  return {
    git_head: head,
    runtime_kind: runtimeKind,
    source_hash: hash.digest("hex"),
    source_files: files.length,
  };
}

export function runtimeDirectoryFingerprint(root) {
  const resolvedRoot = path.resolve(root);
  const allowedExtensions = new Set([
    ".css",
    ".html",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".txt",
  ]);
  const allowedNames = new Set(["VERSION"]);
  const excludedDirectories = new Set([
    "__pycache__",
    ".brainstem_data",
    "logs",
    "recordings",
  ]);
  const collect = (directory) => readdirSync(directory, {
    withFileTypes: true,
  }).flatMap((entry) => {
    if (entry.name.startsWith(".")) return [];
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return excludedDirectories.has(entry.name) ? [] : collect(absolute);
    }
    return allowedNames.has(entry.name)
      || allowedExtensions.has(path.extname(entry.name).toLowerCase())
      ? [absolute]
      : [];
  });
  const files = collect(resolvedRoot).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const relative = path.relative(resolvedRoot, file);
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return {
    root: resolvedRoot,
    runtime_kind: "directory",
    source_hash: hash.digest("hex"),
    source_files: files.length,
  };
}
