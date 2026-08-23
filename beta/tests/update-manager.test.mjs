import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  checkForUpdates,
  compareBetaVersions,
  githubRawUrl,
  inferManagedBetaHome,
  parseGitHubRepository,
  readUpdateConfiguration,
  releaseTagFor,
  resolveManagedInstall,
  validateUpdateRef,
} from "../electron/update-manager.mjs";

const CURRENT_COMMIT = "1".repeat(40);
const LATEST_COMMIT = "2".repeat(40);
const RELEASE_COMMIT = "3".repeat(40);

test("GitHub repository URLs support HTTPS and SSH remotes", () => {
  assert.deepEqual(
    parseGitHubRepository(
      "https://github.com/microsoft/aibast-agents-library.git",
    ),
    {
      owner: "microsoft",
      repo: "aibast-agents-library",
      slug: "microsoft/aibast-agents-library",
    },
  );
  assert.equal(
    parseGitHubRepository("git@github.com:microsoft/aibast-agents-library.git")
      .slug,
    "microsoft/aibast-agents-library",
  );
  assert.equal(parseGitHubRepository("https://example.com/owner/repo.git"), null);
  assert.equal(
    githubRawUrl(
      "https://github.com/microsoft/aibast-agents-library.git",
      LATEST_COMMIT,
      "install.ps1",
    ),
    `https://raw.githubusercontent.com/microsoft/aibast-agents-library/${LATEST_COMMIT}/install.ps1`,
  );
});

test("update branch validation rejects unsafe refs", () => {
  assert.equal(validateUpdateRef("main"), "main");
  assert.equal(validateUpdateRef("preview/beta"), "preview/beta");
  for (const ref of ["", "-main", "../main", "main..next", "main lock"]) {
    assert.throws(() => validateUpdateRef(ref));
  }
});

test("update checks fetch the configured GitHub branch", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-beta-update-"));
  const packageDir = path.join(root, "beta");
  mkdirSync(packageDir);
  writeFileSync(path.join(packageDir, "VERSION"), "0.1.0-beta.1\n");
  const calls = [];
  const runGit = async (cwd, args) => {
    calls.push({ cwd, args });
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return `${root}\n`;
    if (command === "remote get-url origin") {
      return "https://github.com/microsoft/aibast-agents-library.git\n";
    }
    if (command === "rev-parse HEAD") return `${CURRENT_COMMIT}\n`;
    if (command === "status --porcelain --untracked-files=no") return "";
    if (command.startsWith("fetch ")) return "";
    if (command === "rev-parse FETCH_HEAD") return `${LATEST_COMMIT}\n`;
    if (command === `show ${LATEST_COMMIT}:beta/VERSION`) {
      return "0.1.0-beta.2\n";
    }
    if (command === "cat-file -t FETCH_HEAD") return "tag\n";
    if (command === "rev-parse FETCH_HEAD^{commit}") return `${RELEASE_COMMIT}\n`;
    if (command === `show ${RELEASE_COMMIT}:beta/VERSION`) {
      return "0.1.0-beta.2\n";
    }
    throw new Error(`Unexpected git call: ${command}`);
  };

  try {
    const update = await checkForUpdates({
      packageDir,
      env: { BRAINSTEM_BETA_UPDATE_REF: "preview/beta" },
      runGit,
    });
    assert.equal(update.available, true);
    assert.equal(update.currentVersion, "0.1.0-beta.1");
    assert.equal(update.latestVersion, "0.1.0-beta.2");
    assert.equal(update.published, true);
    assert.equal(update.releasePublished, true);
    assert.equal(update.releaseTag, "brainstem-beta-v0.1.0-beta.2");
    // The branch head is only the channel pointer; the install target is the
    // annotated release tag's commit.
    assert.equal(update.channelCommit, LATEST_COMMIT);
    assert.equal(update.latestCommit, RELEASE_COMMIT);
    assert.equal(update.repository, "microsoft/aibast-agents-library");
    assert.ok(calls.some(({ args }) => (
      args.join(" ")
      === "fetch --quiet --filter=blob:none --depth 1 origin refs/heads/preview/beta"
    )));
    assert.ok(calls.some(({ args }) => (
      args.join(" ")
      === "fetch --quiet --filter=blob:none --depth 1 origin refs/tags/brainstem-beta-v0.1.0-beta.2"
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a branch without a beta manifest is not an update failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-beta-update-"));
  const packageDir = path.join(root, "beta");
  mkdirSync(packageDir);
  writeFileSync(path.join(packageDir, "VERSION"), "0.1.0-beta.1\n");
  const runGit = async (_cwd, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return `${root}\n`;
    if (command === "remote get-url origin") {
      return "https://github.com/microsoft/aibast-agents-library.git\n";
    }
    if (command === "rev-parse HEAD") return `${CURRENT_COMMIT}\n`;
    if (command === "status --porcelain --untracked-files=no") return "";
    if (command.startsWith("fetch ")) return "";
    if (command === "rev-parse FETCH_HEAD") return `${LATEST_COMMIT}\n`;
    if (command === `show ${LATEST_COMMIT}:beta/VERSION`) {
      throw new Error(
        "fatal: path 'beta/VERSION' exists on disk, but not in "
        + `'${LATEST_COMMIT}'`,
      );
    }
    throw new Error(`Unexpected git call: ${command}`);
  };

  try {
    const update = await checkForUpdates({ packageDir, runGit });
    assert.equal(update.available, false);
    assert.equal(update.published, false);
    assert.equal(update.latestVersion, null);
    assert.equal(update.latestCommit, LATEST_COMMIT);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function channelGit({
  latestVersion,
  releaseCommit = LATEST_COMMIT,
  tagKind = "tag",
  tagVersion = latestVersion,
  tagFetchError = null,
}) {
  const tagRef = `refs/tags/brainstem-beta-v${latestVersion}`;
  return async (_cwd, args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return "__ROOT__";
    if (command === "remote get-url origin") {
      return "https://github.com/microsoft/aibast-agents-library.git\n";
    }
    if (command === "rev-parse HEAD") return `${CURRENT_COMMIT}\n`;
    if (command === "status --porcelain --untracked-files=no") return "";
    if (command.startsWith("fetch ") && command.endsWith(tagRef)) {
      if (tagFetchError) throw new Error(tagFetchError);
      return "";
    }
    if (command.startsWith("fetch ")) return "";
    if (command === "rev-parse FETCH_HEAD") return `${LATEST_COMMIT}\n`;
    if (command === `show ${LATEST_COMMIT}:beta/VERSION`) {
      return `${latestVersion}\n`;
    }
    if (command === "cat-file -t FETCH_HEAD") return `${tagKind}\n`;
    if (command === "rev-parse FETCH_HEAD^{commit}") return `${releaseCommit}\n`;
    if (command === `show ${releaseCommit}:beta/VERSION`) {
      return `${tagVersion}\n`;
    }
    throw new Error(`Unexpected git call: ${command}`);
  };
}

async function channelCheck({ installedVersion, latestVersion, ...release }) {
  const root = mkdtempSync(path.join(tmpdir(), "rapp-beta-update-"));
  const packageDir = path.join(root, "beta");
  mkdirSync(packageDir);
  writeFileSync(path.join(packageDir, "VERSION"), `${installedVersion}\n`);
  const base = channelGit({ latestVersion, ...release });
  const runGit = async (cwd, args) => {
    const result = await base(cwd, args);
    return result === "__ROOT__" ? `${root}\n` : result;
  };
  try {
    return await checkForUpdates({ packageDir, runGit });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a channel serving an older version is never offered as an update", async () => {
  const update = await channelCheck({
    installedVersion: "0.1.0-beta.6",
    latestVersion: "0.1.0-beta.4",
  });
  assert.equal(update.available, false);
  assert.equal(update.channelBehind, true);
  assert.equal(update.published, true);
  assert.equal(update.latestVersion, "0.1.0-beta.4");
});

// Decision (2026-08-20): updates are tag-anchored. The branch head is only the
// channel pointer; the commit that gets installed is the one the annotated
// release tag brainstem-beta-v<version> points at (RELEASING.md §2). A staging
// commit merged after the tag shares the version but was never released.
test("a same-version channel refresh is NOT an update when the installed build is the released commit", async () => {
  const refresh = await channelCheck({
    installedVersion: "0.1.0-beta.6",
    latestVersion: "0.1.0-beta.6",
    releaseCommit: CURRENT_COMMIT,
  });
  assert.equal(refresh.available, false);
  assert.equal(refresh.channelBehind, false);
  assert.equal(refresh.releasePublished, true);
  assert.equal(refresh.sameVersion, true);
  assert.equal(refresh.channelCommit, LATEST_COMMIT);
  assert.equal(refresh.latestCommit, CURRENT_COMMIT);
});

test("a same-version build that is off the released commit is re-aligned to it", async () => {
  const realign = await channelCheck({
    installedVersion: "0.1.0-beta.6",
    latestVersion: "0.1.0-beta.6",
    releaseCommit: RELEASE_COMMIT,
  });
  assert.equal(realign.available, true);
  assert.equal(realign.sameVersion, true);
  assert.equal(realign.latestCommit, RELEASE_COMMIT);
});

test("a newer channel installs only through its annotated release tag's commit", async () => {
  const newer = await channelCheck({
    installedVersion: "0.1.0-beta.6",
    latestVersion: "0.1.0-beta.7",
    releaseCommit: RELEASE_COMMIT,
  });
  assert.equal(newer.available, true);
  assert.equal(newer.channelBehind, false);
  assert.equal(newer.releaseTag, "brainstem-beta-v0.1.0-beta.7");
  assert.equal(newer.releaseAnnotated, true);
  assert.notEqual(newer.latestCommit, LATEST_COMMIT);
  assert.equal(newer.latestCommit, RELEASE_COMMIT);
});

test("a newer channel version without a published release tag is not an update", async () => {
  const staged = await channelCheck({
    installedVersion: "0.1.0-beta.6",
    latestVersion: "0.1.0-beta.7",
    tagFetchError: "fatal: couldn't find remote ref refs/tags/brainstem-beta-v0.1.0-beta.7",
  });
  assert.equal(staged.available, false);
  assert.equal(staged.published, true);
  assert.equal(staged.releasePublished, false);
  assert.equal(staged.releaseCommit, null);
  assert.match(staged.releaseProblem, /not published yet/);
  // Nothing is offered, so the install target stays the channel head for display only.
  assert.equal(staged.latestCommit, LATEST_COMMIT);
});

test("a lightweight release tag is refused", async () => {
  const lightweight = await channelCheck({
    installedVersion: "0.1.0-beta.6",
    latestVersion: "0.1.0-beta.7",
    releaseCommit: RELEASE_COMMIT,
    tagKind: "commit",
  });
  assert.equal(lightweight.available, false);
  assert.equal(lightweight.releaseAnnotated, false);
  assert.match(lightweight.releaseProblem, /not an annotated tag/);
});

test("a release tag whose beta/VERSION disagrees with the channel is refused", async () => {
  const mismatch = await channelCheck({
    installedVersion: "0.1.0-beta.6",
    latestVersion: "0.1.0-beta.7",
    releaseCommit: RELEASE_COMMIT,
    tagVersion: "0.1.0-beta.6",
  });
  assert.equal(mismatch.available, false);
  assert.equal(mismatch.releasePublished, false);
  assert.match(mismatch.releaseProblem, /points at beta\/VERSION 0\.1\.0-beta\.6, not 0\.1\.0-beta\.7/);
});

test("a network failure while fetching the release tag is an error, never 'up to date'", async () => {
  await assert.rejects(
    channelCheck({
      installedVersion: "0.1.0-beta.6",
      latestVersion: "0.1.0-beta.7",
      tagFetchError: "fatal: unable to access 'https://github.com/': Could not resolve host: github.com",
    }),
    /Could not resolve host/,
  );
});

test("release tags are component-qualified (RELEASING.md §2)", () => {
  assert.equal(releaseTagFor("0.1.0-beta.7"), "brainstem-beta-v0.1.0-beta.7");
  assert.equal(releaseTagFor(" 0.1.0 \n"), "brainstem-beta-v0.1.0");
});

test("beta version ordering is prerelease-aware", () => {
  assert.equal(compareBetaVersions("0.1.0-beta.6", "0.1.0-beta.4"), 1);
  assert.equal(compareBetaVersions("0.1.0-beta.4", "0.1.0-beta.6"), -1);
  assert.equal(compareBetaVersions("0.1.0-beta.10", "0.1.0-beta.9"), 1);
  assert.equal(compareBetaVersions("0.1.0", "0.1.0-beta.7"), 1);
  assert.equal(compareBetaVersions("0.1.0-beta.7", "0.1.0"), -1);
  assert.equal(compareBetaVersions("0.1.1-beta.1", "0.1.0"), 1);
  assert.equal(compareBetaVersions("0.1.0-beta.6", "0.1.0-beta.6"), 0);
  assert.equal(compareBetaVersions("0.1.0-alpha.2", "0.1.0-beta.1"), -1);
  assert.equal(compareBetaVersions("garbage", "0.1.0"), null);
});

test("hyphenated prereleases keep their full tail in ordering", () => {
  // split("-", 2) used to truncate everything after the second hyphen, so a
  // hotfix build compared EQUAL to its base and the downgrade guard misjudged.
  assert.equal(
    compareBetaVersions("0.1.0-beta.7-hotfix.1", "0.1.0-beta.7"),
    1,
  );
  assert.equal(
    compareBetaVersions("0.1.0-beta.7", "0.1.0-beta.7-hotfix.1"),
    -1,
  );
  assert.equal(
    compareBetaVersions("0.1.0-beta.7-rc.2", "0.1.0-beta.7-rc.1"),
    1,
  );
  assert.equal(
    compareBetaVersions("0.1.0-beta.7-rc.1", "0.1.0-beta.7-rc.2"),
    -1,
  );
  assert.equal(
    compareBetaVersions("0.1.0-beta.7-hotfix.1", "0.1.0-beta.7-hotfix.1"),
    0,
  );
  assert.equal(compareBetaVersions("0.1.0-beta.8", "0.1.0-beta.7-hotfix.1"), 1);
  // Trailing junk in a core part is unparseable, not silently equal.
  assert.equal(compareBetaVersions("0.1.0junk", "0.1.0"), null);
  assert.equal(compareBetaVersions("0.1.0-", "0.1.0"), null);
});

test("a channel behind an installed hotfix build is never offered as an update", async () => {
  const update = await channelCheck({
    installedVersion: "0.1.0-beta.8-hotfix.1",
    latestVersion: "0.1.0-beta.8",
  });
  assert.equal(update.available, false);
  assert.equal(update.channelBehind, true);
  assert.equal(update.published, true);
});

test("managed installs resolve the portable Node and Electron runtimes", () => {
  const betaHome = mkdtempSync(path.join(tmpdir(), "rapp-beta-managed-"));
  const repoRoot = path.join(betaHome, "src");
  const packageDir = path.join(repoRoot, "beta");
  const node = path.join(
    betaHome,
    "node-v24.19.0-darwin-arm64",
    "bin",
    "node",
  );
  const electron = path.join(
    packageDir,
    "node_modules",
    "electron",
    "dist",
    "Electron.app",
    "Contents",
    "MacOS",
    "Electron",
  );
  mkdirSync(path.dirname(node), { recursive: true });
  mkdirSync(path.dirname(electron), { recursive: true });
  writeFileSync(node, "");
  writeFileSync(electron, "");
  writeFileSync(
    path.join(betaHome, "update-config.json"),
    `${JSON.stringify({
      repositoryUrl: "https://github.com/microsoft/aibast-agents-library.git",
      updateRef: "preview/beta",
    })}\n`,
  );

  try {
    assert.equal(inferManagedBetaHome(packageDir, {}), betaHome);
    assert.equal(
      readUpdateConfiguration(packageDir, {}).updateRef,
      "preview/beta",
    );
    assert.deepEqual(
      resolveManagedInstall({
        packageDir,
        repoRoot,
        env: {},
        platform: "darwin",
        arch: "arm64",
      }),
      { betaHome, electron, node },
    );
  } finally {
    rmSync(betaHome, { recursive: true, force: true });
  }
});
