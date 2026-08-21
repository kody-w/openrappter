import { execFile, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const UPDATE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function asErrorMessage(error) {
  return String(error?.message || error);
}

export function compareBetaVersions(left, right) {
  const parse = (value) => {
    // Split on the FIRST hyphen only. JS split's limit argument DISCARDS the
    // remainder, so split("-", 2) would truncate "0.1.0-beta.7-hotfix.1" to
    // prerelease "beta.7" and defeat the downgrade guard.
    const text = String(value || "").trim();
    const hyphenAt = text.indexOf("-");
    const core = hyphenAt === -1 ? text : text.slice(0, hyphenAt);
    const prerelease = hyphenAt === -1 ? null : text.slice(hyphenAt + 1);
    if (prerelease === "") return null;
    const parts = core.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
      return null;
    }
    return { numbers: parts.map((part) => Number.parseInt(part, 10)), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a.numbers[i] !== b.numbers[i]) return Math.sign(a.numbers[i] - b.numbers[i]);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const aParts = a.prerelease.split(".");
  const bParts = b.prerelease.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const [x, y] = [aParts[i], bParts[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [xn, yn] = [Number.parseInt(x, 10), Number.parseInt(y, 10)];
    const bothNumeric = String(xn) === x && String(yn) === y;
    const order = bothNumeric ? Math.sign(xn - yn) : (x < y ? -1 : x > y ? 1 : 0);
    if (order !== 0) return order;
  }
  return 0;
}

export function validateUpdateRef(value) {
  const ref = String(value || "").trim();
  const invalid = !UPDATE_REF_PATTERN.test(ref)
    || ref.includes("..")
    || ref.includes("//")
    || ref.endsWith("/")
    || ref.endsWith(".")
    || ref.endsWith(".lock");
  if (invalid) {
    throw new Error(`Invalid beta update branch: ${ref || "(empty)"}`);
  }
  return ref;
}

export function parseGitHubRepository(remoteUrl) {
  const value = String(remoteUrl || "").trim();
  const scpMatch = value.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (scpMatch) {
    const repo = scpMatch[2].replace(/\.git$/i, "");
    return {
      owner: scpMatch[1],
      repo,
      slug: `${scpMatch[1]}/${repo}`,
    };
  }

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    const parts = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.git$/i, "")
      .split("/");
    if (parts.length !== 2 || parts.some((part) => !part)) return null;
    return { owner: parts[0], repo: parts[1], slug: parts.join("/") };
  } catch {
    return null;
  }
}

export function githubRawUrl(remoteUrl, commit, filePath) {
  const repository = parseGitHubRepository(remoteUrl);
  if (!repository || !COMMIT_PATTERN.test(commit)) {
    throw new Error("A GitHub repository and full commit SHA are required.");
  }
  const encodedPath = filePath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${commit}/${encodedPath}`;
}

export function inferManagedBetaHome(packageDir, env = process.env) {
  const resolvedPackageDir = path.resolve(packageDir);
  const explicitHome = env.BRAINSTEM_BETA_HOME
    ? path.resolve(env.BRAINSTEM_BETA_HOME)
    : null;
  if (explicitHome) {
    const expectedPackageDir = path.join(explicitHome, "src", "beta");
    return path.resolve(expectedPackageDir) === resolvedPackageDir
      ? explicitHome
      : null;
  }

  const repoRoot = path.dirname(resolvedPackageDir);
  if (
    path.basename(resolvedPackageDir) !== "beta"
    || path.basename(repoRoot) !== "src"
  ) {
    return null;
  }
  return path.dirname(repoRoot);
}

export function readUpdateConfiguration(packageDir, env = process.env) {
  const betaHome = inferManagedBetaHome(packageDir, env);
  if (!betaHome) return {};
  const configPath = path.join(betaHome, "update-config.json");
  if (!existsSync(configPath)) return {};
  let value;
  try {
    value = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid beta update configuration at ${configPath}: ${asErrorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid beta update configuration at ${configPath}.`);
  }
  return value;
}

export function resolveGitExecutable(env = process.env, platform = process.platform) {
  const candidates = [env.BRAINSTEM_BETA_GIT_EXE];
  if (platform === "win32") {
    for (const base of [
      env.ProgramFiles,
      env["ProgramFiles(x86)"],
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"),
    ]) {
      if (base) candidates.push(path.join(base, "Git", "cmd", "git.exe"));
    }
  }

  for (const candidate of candidates) {
    if (candidate && path.isAbsolute(candidate) && existsSync(candidate)) {
      return candidate;
    }
  }
  return "git";
}

function nodePlatform(platform, arch) {
  const os = platform === "win32" ? "win" : platform;
  return `${os}-${arch}`;
}

export function resolvePortableNode({
  betaHome,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const explicitNode = env.BRAINSTEM_BETA_NODE_EXE;
  if (explicitNode && existsSync(explicitNode)) return explicitNode;

  const executable = platform === "win32"
    ? "node.exe"
    : path.join("bin", "node");
  const suffix = `-${nodePlatform(platform, arch)}`;
  const directories = readdirSync(betaHome, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("node-v") && name.endsWith(suffix))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  for (const directory of directories) {
    const candidate = path.join(betaHome, directory, executable);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Portable Node.js is missing from ${betaHome}. Re-run the Frontier installer.`);
}

function electronExecutable(repoRoot, platform) {
  if (platform === "win32") {
    return path.join(
      repoRoot,
      "beta",
      "node_modules",
      "electron",
      "dist",
      "electron.exe",
    );
  }
  if (platform === "darwin") {
    return path.join(
      repoRoot,
      "beta",
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    );
  }
  return path.join(
    repoRoot,
    "beta",
    "node_modules",
    "electron",
    "dist",
    "electron",
  );
}

export function resolveManagedInstall({
  packageDir,
  repoRoot,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const betaHome = inferManagedBetaHome(packageDir, env);
  if (!betaHome || path.resolve(repoRoot) !== path.join(betaHome, "src")) {
    throw new Error(
      "This checkout is not managed by the RAPP Brainstem Frontier installer. "
      + "Update it with Git or re-run the Frontier installer.",
    );
  }

  const node = resolvePortableNode({ betaHome, env, platform, arch });
  const electron = electronExecutable(repoRoot, platform);
  if (!existsSync(electron)) {
    throw new Error(`Electron is missing at ${electron}. Re-run the Frontier installer.`);
  }
  return { betaHome, electron, node };
}

export async function runGitCommand(
  cwd,
  args,
  {
    env = process.env,
    gitExecutable = resolveGitExecutable(env),
    maxBuffer = 5 * 1024 * 1024,
  } = {},
) {
  const { stdout } = await execFileAsync(
    gitExecutable,
    ["-C", cwd, ...args],
    {
      encoding: "utf8",
      env,
      maxBuffer,
      windowsHide: true,
    },
  );
  return stdout;
}

export async function checkForUpdates({
  packageDir,
  env = process.env,
  runGit = runGitCommand,
} = {}) {
  const gitExecutable = resolveGitExecutable(env);
  const gitOptions = { env, gitExecutable };
  const repoRoot = (
    await runGit(packageDir, ["rev-parse", "--show-toplevel"], gitOptions)
  ).trim();
  const expectedPackageDir = path.join(repoRoot, "beta");
  if (path.resolve(packageDir) !== path.resolve(expectedPackageDir)) {
    throw new Error("The running beta application is not inside its Git checkout.");
  }

  const originUrl = (
    await runGit(repoRoot, ["remote", "get-url", "origin"], gitOptions)
  ).trim();
  const updateConfig = readUpdateConfiguration(packageDir, env);
  const remoteUrl = String(
    env.BRAINSTEM_BETA_REPO_URL
    || updateConfig.repositoryUrl
    || originUrl,
  ).trim();
  const repository = parseGitHubRepository(remoteUrl);
  if (!repository) {
    throw new Error(`The beta update source is not a GitHub repository: ${remoteUrl}`);
  }

  const updateRef = validateUpdateRef(
    env.BRAINSTEM_BETA_UPDATE_REF || updateConfig.updateRef || "main",
  );
  const currentCommit = (
    await runGit(repoRoot, ["rev-parse", "HEAD"], gitOptions)
  ).trim().toLowerCase();
  if (!COMMIT_PATTERN.test(currentCommit)) {
    throw new Error("The installed beta commit could not be determined.");
  }

  const dirty = Boolean((
    await runGit(
      repoRoot,
      ["status", "--porcelain", "--untracked-files=no"],
      gitOptions,
    )
  ).trim());

  await runGit(
    repoRoot,
    [
      "fetch",
      "--quiet",
      "--filter=blob:none",
      "--depth",
      "1",
      remoteUrl === originUrl ? "origin" : remoteUrl,
      `refs/heads/${updateRef}`,
    ],
    gitOptions,
  );
  const latestCommit = (
    await runGit(repoRoot, ["rev-parse", "FETCH_HEAD"], gitOptions)
  ).trim().toLowerCase();
  if (!COMMIT_PATTERN.test(latestCommit)) {
    throw new Error("GitHub returned an invalid beta update commit.");
  }

  const currentVersion = readFileSync(
    path.join(packageDir, "VERSION"),
    "utf8",
  ).trim();
  let latestVersion = null;
  try {
    latestVersion = (
      await runGit(
        repoRoot,
        ["show", `${latestCommit}:beta/VERSION`],
        gitOptions,
      )
    ).trim();
  } catch (error) {
    const message = asErrorMessage(error);
    if (
      !/beta\/VERSION/i.test(message)
      || !/does not exist|exists on disk, but not in|path .* not in/i.test(message)
    ) {
      throw error;
    }
  }

  // The branch tells us WHICH version the channel is on. The immutable release
  // tag (RELEASING.md §2: annotated `brainstem-beta-v<version>`) tells us
  // WHICH COMMIT of that version was actually published. Only the tag's commit
  // is ever installed: a staging commit merged after the tag carries the same
  // beta/VERSION but never went through the release gate, and an installed
  // build sitting on the tag commit is up to date no matter how far the branch
  // has moved since.
  const release = latestVersion
    ? await resolveReleaseTag({
        latestVersion,
        remote: remoteUrl === originUrl ? "origin" : remoteUrl,
        repoRoot,
        runGit,
        gitOptions,
      })
    : {
        tag: null,
        commit: null,
        annotated: false,
        version: null,
        published: false,
        problem: null,
      };

  // A channel that serves an OLDER version than the installed build is never
  // an update — offering it would be a silent downgrade (a stale staging main
  // can lag the installed release). An unparseable version falls back to
  // commit inequality.
  const versionOrder = compareBetaVersions(latestVersion, currentVersion);
  const channelBehind = versionOrder !== null && versionOrder < 0;
  const sameVersion = versionOrder === 0;
  return {
    available: release.published
      && currentCommit !== release.commit
      && !channelBehind,
    channelBehind,
    channelCommit: latestCommit,
    currentCommit,
    currentVersion,
    dirty,
    gitExecutable,
    // The commit an update installs: the release tag's, never the branch head.
    latestCommit: release.published ? release.commit : latestCommit,
    latestVersion,
    packageDir: path.resolve(packageDir),
    releaseAnnotated: release.annotated,
    releaseCommit: release.commit,
    releaseProblem: release.problem,
    releasePublished: release.published,
    releaseTag: release.tag,
    remoteUrl,
    repoRoot,
    repository: repository.slug,
    published: Boolean(latestVersion),
    sameVersion,
    updateRef,
  };
}

export function releaseTagFor(version) {
  return `brainstem-beta-v${String(version || "").trim()}`;
}

const MISSING_REMOTE_REF_PATTERN =
  /couldn't find remote ref|remote ref .* not found|remote branch .* not found|fatal: invalid refspec/i;

// Resolve the published commit for a channel version through its annotated
// release tag. Fails CLOSED: no tag, a lightweight tag, or a tag whose
// beta/VERSION disagrees with the channel all mean "not published" with a
// reason the UI can show; only network/git failures are thrown.
async function resolveReleaseTag({
  latestVersion,
  remote,
  repoRoot,
  runGit,
  gitOptions,
}) {
  const tag = releaseTagFor(latestVersion);
  const release = {
    tag,
    commit: null,
    annotated: false,
    version: null,
    published: false,
    problem: null,
  };
  try {
    await runGit(
      repoRoot,
      [
        "fetch",
        "--quiet",
        "--filter=blob:none",
        "--depth",
        "1",
        remote,
        `refs/tags/${tag}`,
      ],
      gitOptions,
    );
  } catch (error) {
    const message = asErrorMessage(error);
    if (!MISSING_REMOTE_REF_PATTERN.test(message)) throw error;
    release.problem = `The release tag ${tag} is not published yet.`;
    return release;
  }
  const kind = (
    await runGit(repoRoot, ["cat-file", "-t", "FETCH_HEAD"], gitOptions)
  ).trim();
  release.annotated = kind === "tag";
  const commit = (
    await runGit(repoRoot, ["rev-parse", "FETCH_HEAD^{commit}"], gitOptions)
  ).trim().toLowerCase();
  if (!COMMIT_PATTERN.test(commit)) {
    release.problem = `The release tag ${tag} does not resolve to a commit.`;
    return release;
  }
  release.commit = commit;
  if (!release.annotated) {
    release.problem = `The release tag ${tag} is not an annotated tag (RELEASING.md requires git tag -a).`;
    return release;
  }
  let taggedVersion = null;
  try {
    taggedVersion = (
      await runGit(repoRoot, ["show", `${commit}:beta/VERSION`], gitOptions)
    ).trim();
  } catch (error) {
    const message = asErrorMessage(error);
    if (
      !/beta\/VERSION/i.test(message)
      || !/does not exist|exists on disk, but not in|path .* not in/i.test(message)
    ) {
      throw error;
    }
  }
  release.version = taggedVersion;
  if (taggedVersion !== latestVersion) {
    release.problem = `The release tag ${tag} points at beta/VERSION ${
      taggedVersion || "(missing)"
    }, not ${latestVersion}.`;
    return release;
  }
  release.published = true;
  return release;
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function assertCleanCheckout(
  cwd,
  {
    expectedHead = null,
    label,
    runGit,
    gitOptions,
  },
) {
  const repoRoot = (
    await runGit(cwd, ["rev-parse", "--show-toplevel"], gitOptions)
  ).trim();
  const head = (
    await runGit(repoRoot, ["rev-parse", "HEAD"], gitOptions)
  ).trim().toLowerCase();
  if (!COMMIT_PATTERN.test(head)) {
    throw new Error(`${label} Git commit could not be determined.`);
  }
  if (expectedHead && head !== expectedHead) {
    throw new Error(
      `${label} changed from ${expectedHead.slice(0, 8)} to ${head.slice(0, 8)} `
      + "after the update check. Check again before updating.",
    );
  }
  const dirty = Boolean((
    await runGit(
      repoRoot,
      ["status", "--porcelain", "--untracked-files=no"],
      gitOptions,
    )
  ).trim());
  if (dirty) {
    throw new Error(
      `${label} has tracked local changes. Preserve or discard them before updating.`,
    );
  }
  return { head, repoRoot };
}

export async function prepareUpdate({
  update,
  brainstemHome,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  runGit = runGitCommand,
  spawnProcess = spawn,
} = {}) {
  if (!update?.available) {
    throw new Error("No beta update is available.");
  }
  if (update.dirty) {
    throw new Error(
      "The beta launcher source has local changes. Preserve or discard them before updating.",
    );
  }
  if (!COMMIT_PATTERN.test(update.latestCommit)) {
    throw new Error("The beta update commit is invalid.");
  }

  const managed = resolveManagedInstall({
    packageDir: update.packageDir,
    repoRoot: update.repoRoot,
    env,
    platform,
    arch,
  });
  const gitOptions = {
    env,
    gitExecutable: update.gitExecutable || resolveGitExecutable(env, platform),
    maxBuffer: 10 * 1024 * 1024,
  };
  const betaCheckout = await assertCleanCheckout(update.repoRoot, {
    expectedHead: update.currentCommit,
    label: "The beta launcher source",
    runGit,
    gitOptions,
  });
  const brainstemCheckout = await assertCleanCheckout(
    path.join(brainstemHome, "src", "rapp_brainstem"),
    {
      label: "The shared Brainstem source",
      runGit,
      gitOptions,
    },
  );
  const installerRelative = platform === "win32"
    ? "beta/install.cmd"
    : "beta/install.sh";
  const installerSource = await runGit(
    update.repoRoot,
    ["show", `${update.latestCommit}:${installerRelative}`],
    gitOptions,
  );
  if (!installerSource.trim()) {
    throw new Error(`The update is missing ${installerRelative}.`);
  }
  // Stage the rollback BEFORE anything moves: the installed commit's own
  // installer, pinned to the installed commit. If the update fails half way
  // (checkout moved, dependencies half-installed), the runner re-installs the
  // previous version with it instead of leaving a launcher that cannot open.
  let rollbackInstallerSource = "";
  try {
    rollbackInstallerSource = await runGit(
      update.repoRoot,
      ["show", `${update.currentCommit}:${installerRelative}`],
      gitOptions,
    );
  } catch (error) {
    throw new Error(
      `Cannot stage a rollback installer from the installed commit ${
        update.currentCommit.slice(0, 8)
      }: ${asErrorMessage(error)}`,
    );
  }
  if (!rollbackInstallerSource.trim()) {
    throw new Error(`The installed commit is missing ${installerRelative}; refusing to update without a rollback.`);
  }

  const cacheDir = path.join(managed.betaHome, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const updateId = `${update.latestCommit}-${Date.now()}`;
  const extension = platform === "win32" ? "cmd" : "sh";
  const installerPath = path.join(cacheDir, `update-installer-${updateId}.${extension}`);
  const rollbackInstallerPath = path.join(cacheDir, `rollback-installer-${updateId}.${extension}`);
  const runnerPath = path.join(cacheDir, `update-runner-${updateId}.mjs`);
  const redactionPath = path.join(cacheDir, "log-redaction.mjs");
  const requestPath = path.join(cacheDir, `update-request-${updateId}.json`);
  const resultPath = path.join(managed.betaHome, "update-result.json");
  const logPath = path.join(managed.betaHome, "update.log");

  writeFileSync(installerPath, installerSource, { mode: 0o700 });
  writeFileSync(rollbackInstallerPath, rollbackInstallerSource, { mode: 0o700 });
  writeFileSync(
    runnerPath,
    readFileSync(path.join(update.packageDir, "electron", "update-runner.mjs")),
    { mode: 0o700 },
  );
  writeFileSync(
    redactionPath,
    readFileSync(path.join(update.packageDir, "electron", "log-redaction.mjs")),
    { mode: 0o600 },
  );
  rmSync(resultPath, { force: true });

  const request = {
    betaHome: managed.betaHome,
    brainstemHome,
    brainstemExpectedHead: brainstemCheckout.head,
    brainstemRepoRoot: brainstemCheckout.repoRoot,
    betaExpectedHead: betaCheckout.head,
    betaRepoRoot: betaCheckout.repoRoot,
    commit: update.latestCommit,
    currentVersion: update.currentVersion,
    electronPath: managed.electron,
    installerPath,
    gitExecutable: gitOptions.gitExecutable,
    latestVersion: update.latestVersion,
    logPath,
    packageDir: update.packageDir,
    parentPid: process.pid,
    platform,
    remoteUrl: update.remoteUrl,
    redactionPath,
    requestPath,
    resultPath,
    rollbackCommit: update.currentCommit,
    rollbackInstallerPath,
    runnerPath,
    updateRef: update.updateRef,
  };
  if (platform === "win32") {
    request.bootstrapUrl = githubRawUrl(
      update.remoteUrl,
      update.latestCommit,
      "install.ps1",
    );
    request.rollbackBootstrapUrl = githubRawUrl(
      update.remoteUrl,
      update.currentCommit,
      "install.ps1",
    );
  }
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    mode: 0o600,
  });

  const updaterEnv = {
    ...env,
    BRAINSTEM_BETA_HOME: managed.betaHome,
    BRAINSTEM_BETA_NODE_EXE: managed.node,
    BRAINSTEM_BETA_REPO_URL: update.remoteUrl,
    BRAINSTEM_BETA_UPDATE_REF: update.updateRef,
  };
  if (path.isAbsolute(gitOptions.gitExecutable)) {
    updaterEnv.BRAINSTEM_BETA_GIT_EXE = gitOptions.gitExecutable;
    updaterEnv.PATH = [
      path.dirname(gitOptions.gitExecutable),
      updaterEnv.PATH || "",
    ].filter(Boolean).join(path.delimiter);
  }

  try {
    const child = spawnProcess(managed.node, [runnerPath, requestPath], {
      detached: true,
      env: updaterEnv,
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForSpawn(child);
    child.unref();
  } catch (error) {
    for (const temporaryPath of [
      installerPath,
      rollbackInstallerPath,
      redactionPath,
      runnerPath,
      requestPath,
    ]) {
      rmSync(temporaryPath, { force: true });
    }
    throw new Error(`Could not start the Frontier updater: ${asErrorMessage(error)}`);
  }

  return {
    commit: update.latestCommit,
    latestVersion: update.latestVersion,
    logPath,
    resultPath,
  };
}

export function consumeUpdateResult({
  packageDir,
  env = process.env,
} = {}) {
  const betaHome = inferManagedBetaHome(packageDir, env);
  if (!betaHome) return null;
  const resultPath = path.join(betaHome, "update-result.json");
  if (!existsSync(resultPath)) return null;

  try {
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } finally {
    rmSync(resultPath, { force: true });
  }
}
