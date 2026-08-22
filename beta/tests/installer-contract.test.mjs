import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Read with line endings normalised. A Windows checkout gets CRLF on these files
// — correctly, since a .cmd wants CRLF — so split("\n") leaves a trailing \r on
// every line and any assertion anchored with $ fails for a reason that has
// nothing to do with what it is testing. These tests are about content, so the
// content is what they read. Normalising here rather than per pattern means a
// later assertion cannot reintroduce the bug by forgetting.
const read = (name) => readFileSync(path.join(root, name), "utf8").replace(/\r\n/g, "\n");

const unix = read("install.sh");
const windows = read("install.cmd");
const installerPage = read("index.html");
const frontierUnix = read("frontier.sh");
const frontierWindows = read("frontier.ps1");
const packageJson = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
const main = readFileSync(
  path.join(root, "electron", "main.mjs"),
  "utf8",
).replaceAll("\r\n", "\n");
const activityView = readFileSync(
  path.join(root, "electron", "activity-view.mjs"),
  "utf8",
);
const rappterSurgeon = readFileSync(
  path.join(root, "electron", "rappter-surgeon.mjs"),
  "utf8",
);
const routeManager = readFileSync(
  path.join(root, "electron", "route-manager.mjs"),
  "utf8",
);
const uiDriverServer = readFileSync(
  path.join(root, "electron", "ui-driver-server.mjs"),
  "utf8",
);
const preload = readFileSync(
  path.join(root, "electron", "preload.cjs"),
  "utf8",
).replaceAll("\r\n", "\n");
const ui = readFileSync(
  path.join(root, "ui", "index.html"),
  "utf8",
).replaceAll("\r\n", "\n");
const renderer = readFileSync(
  path.join(root, "ui", "renderer.js"),
  "utf8",
).replaceAll("\r\n", "\n");
const uiDriverAgent = readFileSync(
  path.join(root, "scripts", "brainstem_ui_driver_agent.py"),
  "utf8",
);
const surgeonChat = readFileSync(
  path.join(root, "scripts", "surgeon-chat.mjs"),
  "utf8",
);
const driveViaChat = readFileSync(
  path.join(root, "scripts", "drive-via-chat.mjs"),
  "utf8",
);
const walkthrough = readFileSync(
  path.join(root, "scripts", "walkthrough-via-chat.mjs"),
  "utf8",
);
const walkthroughGate = readFileSync(
  path.join(root, "scripts", "walkthrough-gate.mjs"),
  "utf8",
);
const walkthroughCertify = readFileSync(
  path.join(root, "scripts", "walkthrough-certify.mjs"),
  "utf8",
);
const brainstemUi = readFileSync(
  process.env.BRAINSTEM_BETA_RUNTIME_DIR
    ? path.join(process.env.BRAINSTEM_BETA_RUNTIME_DIR, "index.html")
    : path.join(root, "..", "rapp_brainstem", "index.html"),
  "utf8",
);

test("desktop installers use OpenRappter as the canonical application source", () => {
  for (const installer of [unix, windows]) {
    assert.match(installer, /kody-w\/openrappter/);
    assert.doesNotMatch(installer, /kody-w\/rapp-installer/);
  }
});

// CORRECTED 2026-08-21. This asserted the identity of the distribution the
// Frontier was imported FROM. Shipping this app under @aibast/… with a bundle
// identifier of com.microsoft.aibast.… claimed a namespace this distribution
// does not own — on macOS the appId IS the bundle identifier a signed app is
// registered under, so it is not cosmetic. The identity now matches the
// repository that publishes it.
test("OpenRappter is the primary customer-facing application identity", () => {
  assert.equal(packageJson.name, "@openrappter/desktop");
  assert.equal(packageJson.license, "Apache-2.0");
  assert.equal(
    packageJson.build.appId,
    "io.github.kody-w.openrappter",
    "the bundle identifier must belong to whoever ships the app",
  );
  assert.doesNotMatch(
    JSON.stringify(packageJson),
    /com\.microsoft|@aibast\//,
    "no upstream namespace may remain in the shipped identity",
  );
  assert.deepEqual(
    packageJson.build.publish,
    [{ provider: "github", owner: "kody-w", repo: "openrappter" }],
    "electron-builder needs somewhere to publish, or a release can only be made by hand",
  );
  assert.equal(packageJson.version, "0.1.0-beta.9");
  assert.equal(readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim(), packageJson.version);
  for (const installer of [unix, windows]) {
    assert.match(installer, /openrappter-app/);
    assert.match(installer, /Brainstem runtime data/);
  }
});

test("beta test gate uses Node discovery on every shell", () => {
  assert.equal(packageJson.scripts.test, "node --test");
});

test("beta installers exclude the solution library", () => {
  assert.match(unix, /fetch --progress --filter=blob:none --depth 1 origin "\$REPO_REF"/);
  assert.match(unix, /sparse-checkout set beta tools\/rapp1/);
  assert.match(windows, /fetch --progress --filter=blob:none --depth 1 origin "%REPO_REF%"/);
  assert.match(windows, /sparse-checkout set beta tools\/rapp1/);
  assert.match(unix, /BRAINSTEM_BETA_RUNTIME_DIR=/);
  assert.match(windows, /BRAINSTEM_BETA_RUNTIME_DIR=/);
  assert.match(unix, /cd "\$BETA_SOURCE\/beta"/);
  assert.match(windows, /pushd "%BETA_SOURCE%\\beta"/);
  assert.match(unix, /node_modules\/electron\/install\.js/);
  assert.match(windows, /node_modules\\electron\\install\.js/);
  assert.doesNotMatch(unix, /npm" ci --prefix/);
  assert.doesNotMatch(windows, /npm\.cmd" ci --prefix/);
  assert.match(unix, /--no-launch/);
  assert.match(windows, /--no-launch/);
});

test("installed estate tools preserve child paths and default only missing values", () => {
  for (const variable of [
    "OPENRAPPTER_HOME",
    "BRAINSTEM_HOME",
    "BRAINSTEM_BETA_SOURCE_DIR",
    "BRAINSTEM_BETA_PYTHON",
    "RAPPTER_PACK_CONFIG",
  ]) {
    assert.match(
      unix,
      new RegExp(`\\\\\\$\\{${variable}:=`),
      `${variable} must use a shell default, not overwrite a child estate`,
    );
    assert.match(
      windows,
      new RegExp(`if not defined ${variable} set`),
      `${variable} must use a cmd default, not overwrite a child estate`,
    );
  }
  const hatchBlock = unix.slice(
    unix.indexOf('local hatch_launcher='),
    unix.indexOf('if [[ "$platform" == darwin-*'),
  );
  assert.doesNotMatch(
    hatchBlock,
    /^export (?:OPENRAPPTER_HOME|BRAINSTEM_HOME)=/m,
  );
  assert.doesNotMatch(unix, /\$BRAINSTEM_(?:RUNTIME_DIR|PYTHON)/);
  assert.doesNotMatch(windows, /%(?:BRAINSTEM_RUNTIME_DIR|PYTHON_EXE)%/);
  assert.match(
    unix,
    /BRAINSTEM_BETA_SOURCE_DIR:=\\\$\{BRAINSTEM_HOME\}\/src\/rapp_brainstem/,
  );
  assert.match(
    windows,
    /BRAINSTEM_BETA_SOURCE_DIR=%%BRAINSTEM_HOME%%\\src\\rapp_brainstem/,
  );
  assert.match(
    windows,
    /BRAINSTEM_BETA_PYTHON=%%BRAINSTEM_HOME%%\\venv\\Scripts\\python\.exe/,
  );
});

test("released beta installs can pin the launcher and runtime to one commit", () => {
  for (const installer of [unix, windows]) {
    assert.match(installer, /BRAINSTEM_BETA_COMMIT/);
    assert.match(installer, /40-character commit SHA/);
    assert.match(installer, /reset --hard FETCH_HEAD/);
    assert.match(installer, /BOOTSTRAP_SHA256/);
  }
  assert.match(unix, /RELEASE_TAG="brainstem-beta-v\$release_version"/);
  assert.match(windows, /set "FRONTIER_VERSION=0\.1\.0-beta\.9"/);
  assert.match(windows, /set "RELEASE_TAG=brainstem-beta-v%FRONTIER_VERSION%"/);
  assert.match(unix, /BRAINSTEM_REPO_REF="\$runtime_ref"/);
  assert.match(unix, /git -C "\$BRAINSTEM_HOME\/src" rev-parse HEAD/);
  assert.match(unix, /BRAINSTEM_BIN="\$OPENRAPPTER_HOME\/kernel-bin"/);
  assert.doesNotMatch(unix, /--version "\$REPO_COMMIT"/);
  assert.match(windows, /set "BRAINSTEM_BIN=%OPENRAPPTER_HOME%\\kernel-bin"/);
  assert.match(windows, /set "RUNTIME_COMMIT_FILE=%TEMP%\\rapp-runtime-commit-%RANDOM%-%RANDOM%\.txt"/);
  assert.match(windows, /"%GIT_EXE%" -C "%BRAINSTEM_HOME%\\src" rev-parse HEAD > "!RUNTIME_COMMIT_FILE!"/);
  assert.doesNotMatch(windows, /--version "%REPO_COMMIT%"/);
  assert.match(windows, /set "ACTUAL_COMMIT_FILE=%TEMP%\\rapp-beta-commit-%RANDOM%-%RANDOM%\.txt"/);
  assert.match(windows, /"%GIT_EXE%" -C "%BETA_SOURCE%" rev-parse HEAD > "!ACTUAL_COMMIT_FILE!"/);
  assert.match(windows, /set \/p "ACTUAL_COMMIT="<"!ACTUAL_COMMIT_FILE!"/);
  assert.match(windows, /del "!ACTUAL_COMMIT_FILE!" >nul 2>nul/);
  // %ACTUAL_COMMIT_FILE% expands at block parse time (before the set runs) and
  // breaks every pinned-commit install on Windows; the block must use !...!.
  assert.doesNotMatch(windows, /rev-parse HEAD > "%ACTUAL_COMMIT_FILE%"/);
  assert.doesNotMatch(windows, /for \/f "delims=" %%H in \('.*rev-parse HEAD.*\)/);
});

test("dedicated beta page resolves fork releases without changing main install", () => {
  assert.match(installerPage, /brainstem-beta-v/);
  assert.match(installerPage, /api\.github\.com\/repos/);
  assert.match(installerPage, /frontier\.sh/);
  assert.match(installerPage, /frontier\.ps1/);
  assert.match(installerPage, /The production installer is unchanged/);
  assert.match(installerPage, /--cp-bg/);
  assert.match(installerPage, /data-theme/);
  assert.match(installerPage, /white-space: pre;/);
  assert.match(installerPage, /frontier\.sh/);
  assert.match(installerPage, /frontier\.ps1/);
  assert.match(installerPage, /RAPP_FRONTIER_REPO/);
  assert.match(installerPage, /install, update or repair, and launch/);
  assert.doesNotMatch(installerPage, /\.join\("\\n"\)/);
});

test("stable Frontier bootstraps resolve and run the latest published release", () => {
  for (const bootstrap of [frontierUnix, frontierWindows]) {
    assert.match(bootstrap, /brainstem-beta-v/);
    assert.match(bootstrap, /api\.github\.com\/repos/);
    assert.match(bootstrap, /BRAINSTEM_BETA_COMMIT/);
    assert.match(bootstrap, /BRAINSTEM_BETA_RELEASE_TAG/);
    assert.match(bootstrap, /BRAINSTEM_BETA_RUNTIME_VERSION_URL/);
    assert.match(bootstrap, /RAPP_FRONTIER_RESOLVE_ONLY/);
  }
  assert.match(frontierUnix, /beta\/install\.sh/);
  assert.match(frontierWindows, /beta\/install\.cmd/);
  assert.doesNotMatch(frontierWindows, /BRAINSTEM_BETA_BOOTSTRAP_URL/);
});

test("dedicated beta page scripts parse", () => {
  const scripts = [...installerPage.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 2);
  for (const [, source] of scripts) {
    assert.doesNotThrow(() => new Function(source));
  }
});

test("OpenRappter hosts its isolated Brainstem without duplicate toolbar IPC", () => {
  assert.match(main, /resolveBrainstemConfig/);
  assert.match(main, /beta:get-state/);
  assert.doesNotMatch(main, /beta:open-browser|beta:open-vscode|beta:restart/);
  assert.doesNotMatch(preload, /openBrowser|openVscode|restart/);
});

test("desktop menu checks GitHub for source updates", () => {
  assert.match(main, /Check for Updates\.\.\./);
  assert.match(main, /Menu\.setApplicationMenu/);
  assert.match(main, /checkForUpdates/);
  assert.match(main, /prepareUpdate/);
  assert.match(
    readFileSync(path.join(root, "electron", "update-manager.mjs"), "utf8"),
    /refs\/heads\/\$\{updateRef\}/,
  );
  assert.match(
    readFileSync(path.join(root, "electron", "update-runner.mjs"), "utf8"),
    /BRAINSTEM_BETA_COMMIT/,
  );
});

test("chat can hot-load an animated driver for the real frontend", () => {
  assert.match(main, /startUiDriverServer/);
  assert.match(main, /Chat agents can visibly operate this Brainstem/);
  assert.match(uiDriverAgent, /class BrainstemUiDriver/);
  assert.match(uiDriverAgent, /actual visible OpenRappter frontend/);
  assert.match(uiDriverAgent, /animated AI cursor/);
  assert.match(uiDriverAgent, /start_recording/);
  assert.match(uiDriverAgent, /stop_recording/);
  assert.match(renderer, /brainstemBeta\.checkForUpdates/);
  assert.match(routeManager, /copyObject/); // objects are copied, never hardlinked, into compositions
  assert.match(routeManager, /AGENTS_PATH/);
  assert.match(routeManager, /ephemeralAgent/);
  assert.match(routeManager, /globalAgentEntries/);
  assert.match(uiDriverServer, /\/v1\/recording-upload/);
  assert.match(uiDriverServer, /createWriteStream/);
  assert.match(main, /createActivityViewInstallationSource/);
  assert.match(activityView, /__rappBetaRenderDriveStep/);
  assert.match(activityView, /__rappBetaRenderDriveMedia/);
  assert.match(main, /brainstem\.composer/);
  assert.match(main, /brainstem\.chat\.msg\[r-/);
  assert.match(renderer, /event\.summary/);
  assert.match(driveViaChat, /action: "surgeon_chat"/);
  assert.match(driveViaChat, /ephemeral_agent/);
  assert.doesNotMatch(driveViaChat, /\/agents\/import|agent_lease|user_guid/);
  assert.doesNotMatch(brainstemUi, /agent_lease|user_guid.*conversation_history/);
});

test("beta embeds the full GitHub Copilot Rappter Surgeon loop", () => {
  assert.match(ui, /id="surgeon-tab"/);
  assert.match(ui, /Rappter Surgeon · agent mode/);
  assert.match(ui, /files, shell, tests, OpenRappter/);
  assert.match(renderer, /brainstemBeta\.surgeonSend/);
  assert.match(renderer, /clearSurgeonUi/);
  assert.match(renderer, /rapp-beta-delete-agent/);
  assert.match(renderer, /rapp-beta-export-agent/);
  assert.match(preload, /beta:surgeon-send/);
  assert.match(preload, /beta:delete-agent/);
  assert.match(preload, /beta:export-agent/);
  assert.match(main, /new RappterSurgeon/);
  assert.match(main, /BETA_FRAME_BRIDGE_SOURCE/);
  assert.match(main, /beta-app-btn/);
  assert.match(main, /rapp-beta:check-updates/);
  assert.match(main, /brainLogo\.title = "Toggle live agents"/);
  assert.match(main, /button\.title = "OpenRappter menu"/);
  assert.match(main, /panel\.querySelector\("h3"\)/);
  assert.match(main, /app\.getPath\("downloads"\)/);
  assert.match(main, /Download agent\.py/);
  assert.match(main, /Delete agent/);
  assert.match(main, /beta-agent-icon-button/);
  assert.match(main, /humanizeAgentName/);
  assert.doesNotMatch(ui, /beta-menu-toggle/);
  assert.match(rappterSurgeon, /real GitHub Copilot coding-agent loop/);
  assert.match(rappterSurgeon, /onPermissionRequest: approveAll/);
  assert.match(rappterSurgeon, /delegate_to_brainstem/);
  assert.match(rappterSurgeon, /ephemeral_agent/);
  assert.match(rappterSurgeon, /ensure_copilot_studio_deploy_agents/);
  assert.match(rappterSurgeon, /start_copilot_studio_login/);
  assert.match(renderer, /Deploy loaded agents to Copilot Studio/);
  assert.match(ui, /deploy-copilot-studio/);
  assert.match(surgeonChat, /action: "surgeon_chat"/);
  assert.match(walkthrough, /action: "surgeon_chat"/);
  assert.match(walkthrough, /FIVE_MINUTE_WALKTHROUGH_COMPLETE/);
  assert.match(walkthrough, /LEARNED_AND_TAUGHT:RAPP_READY/);
  assert.match(walkthrough, /ephemeral_removed/);
  assert.match(walkthrough, /minimum_duration_ms=300000/);
  assert.match(walkthrough, /ffprobe/);
  assert.match(walkthrough, /walkthroughsDir/);
  assert.match(walkthrough, /index\.html/);
  assert.match(walkthrough, /BRAINSTEM_BETA_LAUNCHER/);
  assert.match(walkthrough, /launchBeta/);
  assert.match(walkthrough, /repeat-ephemeral/);
  assert.match(walkthrough, /SECOND_TURN_READY/);
  assert.match(walkthrough, /stack-churn/);
  assert.match(walkthrough, /STACK_CHURN_READY/);
  // The walkthrough teaches where a capability comes from and how a preference is
  // made — the public summon and the popped seal. A new learner should see the
  // model demonstrated, not read about it later. See docs/ONE-TIME-SEALS.md.
  assert.match(walkthrough, /public RAPP Store/);
  assert.match(walkthrough, /still sealed/);
  assert.match(walkthrough, /seal being popped/);
  assert.match(walkthrough, /exported \.egg/);
  assert.match(walkthrough, /control-handoff/);
  assert.match(walkthrough, /DIRECT_BRAINSTEM_READY_1/);
  assert.match(walkthrough, /evaluateControlHandoff/);
  assert.match(walkthroughGate, /PERFECT/);
  assert.match(walkthroughGate, /Grail kernel has no beta diff/);
  assert.match(walkthroughGate, /evidence matches current beta source/);
  assert.match(walkthroughCertify, /validation/);
  assert.match(walkthroughCertify, /--allow-uncertified/);
  assert.match(unix, /openrappter-surgeon/);
  assert.match(unix, /brainstem-walkthrough/);
  assert.match(windows, /openrappter-surgeon\.cmd/);
  assert.match(windows, /brainstem-walkthrough\.cmd/);
  assert.match(
    main,
    /function emitState\(\)[\s\S]*?\r?\n}\r?\n\r?\nfunction emitSurgeonEvent/,
  );
});

test("OpenRappter icon toggles the live agents Explorer", () => {
  assert.doesNotMatch(ui, /id="explorer-tab"/);
  assert.match(ui, /id="agent-tree"/);
  assert.match(ui, /live OpenRappter workspace/);
  assert.match(main, /rapp-beta:toggle-explorer/);
  assert.match(main, /betaExplorerToggle/);
  assert.match(renderer, /rapp-beta:toggle-explorer/);
  assert.match(renderer, /syncExplorerState/);
  assert.match(renderer, /brainstemBeta\.listAgentFiles/);
  assert.match(renderer, /brainstemBeta\.readAgentFile/);
  assert.match(preload, /beta:list-agent-files/);
  assert.match(preload, /beta:read-agent-file/);
  assert.match(main, /routeManager\.activeAgentFiles/);
  assert.match(main, /routeManager\.readActiveAgent/);
  assert.match(main, /routeManager\.stackTree/);
  assert.match(renderer, /stack RAPPIDs/);
  assert.doesNotMatch(main, /beta:save-recording/);
  assert.doesNotMatch(preload, /saveRecording/);
});

test("embedded VS Code link opens externally without replacing Brainstem", () => {
  assert.match(
    brainstemUi,
    /<a[^>]+id="vscode-link"[^>]+target="_blank"[^>]+rel="noopener noreferrer"/,
  );
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /shell\.openExternal/);
});

test("Electron renderer is isolated from Node", () => {
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /BRAINSTEM_BETA_HEADLESS/);
  assert.match(main, /BRAINSTEM_BETA_SMOKE_EXIT_MS/);
  assert.match(
    ui,
    /connect-src 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/,
  );
});

test("first-run guide explains the customer rapid-use-case loop", () => {
  assert.match(ui, /Chat is the control surface/);
  assert.match(ui, /GitHub Copilot teaches by doing/);
  assert.match(ui, /portable RAPP capability/);
  assert.match(ui, /When should I reach for it\?/);
  assert.match(ui, /Scout/);
  assert.match(ui, /Copilot Studio \/ Foundry/);
  assert.match(ui, /Do not call the prototype production-ready/);
});

test("desktop chrome omits the redundant wrapper toolbar", () => {
  assert.doesNotMatch(ui, /brainstem-status|copilot-status/);
  assert.doesNotMatch(ui, /id="guide"|id="browser"|id="vscode"|id="restart"/);
  assert.doesNotMatch(ui, /<body>\s*<header>/);
  assert.doesNotMatch(renderer, /brainstemStatus|copilotStatus|setPill/);
  assert.doesNotMatch(renderer, /brainstemBeta\.(?:openBrowser|openVscode|restart)\b/);
});

// npm runs a package's scripts with the shell's PATH, and `npm test` is
// `node --test` — so `node` resolves from PATH rather than from the npm that
// invoked it. install.sh has exported the portable runtime onto PATH since it was
// written; install.cmd did not, so a Windows machine with an older system Node
// installed with the portable runtime and then verified with the wrong one,
// failing eleven test files on a missing node:sqlite while the correct runtime sat
// unused beside it.
test("both installers put the portable runtime first on PATH", () => {
  assert.match(
    unix,
    /export PATH="\$node_dir\/bin:\$PATH"/,
    "install.sh must export the portable node onto PATH",
  );
  assert.match(
    windows,
    /set "PATH=%NODE_DIR%;%PATH%"/,
    "install.cmd must prepend the portable node to PATH, or npm test shells out "
      + "to whatever node the machine happens to have",
  );
  // And it must happen before the verification block that depends on it.
  const pathAt = windows.indexOf('set "PATH=%NODE_DIR%;%PATH%"');
  const testAt = windows.indexOf('npm.cmd" test');
  assert.ok(pathAt > 0 && testAt > 0 && pathAt < testAt, "PATH must be set before npm test runs");
});

// The kernel and the Frontier are separate artifacts and do not always live in the
// same repository. One URL used to serve both, so pointing REPO_URL at a
// distribution that ships only beta/ also redirected the kernel clone there, and
// the install failed fetching a kernel that was never in that repository.
test("the kernel source is separable from the Frontier source", () => {
  for (const [name, installer] of [["install.sh", unix], ["install.cmd", windows]]) {
    assert.match(
      installer,
      /KERNEL_REPO_URL/,
      `${name} must have a kernel source distinct from REPO_URL`,
    );
    assert.match(
      installer,
      /BRAINSTEM_BETA_KERNEL_REPO_URL/,
      `${name} must let the kernel source be overridden independently`,
    );
    assert.match(
      installer,
      /BRAINSTEM_BETA_KERNEL_REPO_REF/,
      `${name} must let the kernel ref be overridden independently`,
    );
  }
  assert.match(unix, /local runtime_repo="\$KERNEL_REPO_URL"/);
  assert.match(unix, /runtime_repo="\$REPO_URL"/);
  assert.match(windows, /set "BRAINSTEM_REPO_URL=%KERNEL_REPO_URL%"/);
  assert.match(windows, /set "BRAINSTEM_REPO_URL=%REPO_URL%"/);
  assert.doesNotMatch(unix, /GIT_CONFIG_KEY_/);
  assert.doesNotMatch(windows, /GIT_CONFIG_KEY_0/);
});

// The bootstrap is a separately pinned KERNEL installer. Pulling mutable main,
// or calling the Frontier repository's unrelated root installer, silently
// replaced the estate directory during the first public beta.8 proof.
test("the kernel bootstrap is immutable and distinct from the Frontier installer", () => {
  const unixLine = unix.split("\n").find((line) => line.includes("KERNEL_BOOTSTRAP_URL="));
  const windowsLine = windows.split("\n").find((line) => line.includes("set \"BOOTSTRAP_URL="));
  assert.ok(unixLine, "install.sh must define KERNEL_BOOTSTRAP_URL");
  assert.ok(windowsLine, "install.cmd must define BOOTSTRAP_URL");
  assert.match(unixLine, /[0-9a-f]{40}\/install\.sh/);
  assert.match(windowsLine, /[0-9a-f]{40}\/install\.ps1"?$/);
  assert.match(unix, /KERNEL_BOOTSTRAP_SHA256=.*[0-9a-f]{64}/);
  assert.match(windows, /set "BOOTSTRAP_SHA256=[0-9a-f]{64}"/);
  assert.match(unix, /URL and SHA-256 are both required/);
  assert.match(windows, /URL and SHA-256 are both required/);
  assert.doesNotMatch(unix, /bash "\$BETA_SOURCE\/install\.sh"/);
  assert.doesNotMatch(windowsLine, /%REPO_URL%/);
});

test("both transition helpers are byte-identical to their reviewed source", () => {
  const matches = [
    unix.match(/^TRANSITION_HELPER_BASE64="([A-Za-z0-9+/=]+)"$/m),
    windows.match(/^set "TRANSITION_HELPER_BASE64=([A-Za-z0-9+/=]+)"$/m),
  ];
  for (const match of matches) {
    assert.ok(match, "each installer must carry the offline transition helper");
    assert.equal(
      Buffer.from(match[1], "base64").toString("utf8"),
      read("scripts/stage-transition-rollback.mjs"),
    );
  }
  const mainBlock = unix.slice(unix.indexOf("main() {"));
  assert.ok(
    mainBlock.indexOf("stage_transition_rollback")
      < mainBlock.indexOf("sync_beta_source"),
    "the rollback shim must be staged before the launcher checkout can move",
  );
  assert.match(windows, /BRAINSTEM_BETA_TRANSITION_ROLLBACK/);
  assert.match(windows, /update-request-!TRANSITION_ID!\.json/);
  assert.match(windows, /rollback-installer-!TRANSITION_ID!\.cmd/);
});


// Added 2026-08-21 after a real install printed
//   install.sh: line 489: CYAN: unbound variable
// while a person was choosing how to install. The installer runs under
// `set -euo pipefail`, so a colour name that is referenced and never defined is
// not a cosmetic slip — it is an error message in the first five minutes of
// someone's first impression, and `bash -n` does not catch it because the
// syntax is fine.
test("the installer references no variable it never defines", () => {
  // The ROOT installer, not beta/install.sh. `read()` above resolves inside
  // beta/, and the first version of this test used it and therefore checked a
  // different file — passing happily while the bug it was written for sat
  // untouched. Verified by reintroducing the fault and watching this fail.
  const rootInstaller = new URL("../../install.sh", import.meta.url);
  if (!existsSync(rootInstaller)) return; // an installed sparse checkout has no root installer
  const source = readFileSync(rootInstaller, "utf8");

  const defined = new Set([...source.matchAll(/^([A-Z][A-Z_0-9]*)=/gm)].map((m) => m[1]));
  const used = new Set([...source.matchAll(/\$\{([A-Z][A-Z_0-9]{2,})\}/g)].map((m) => m[1]));
  // ${VAR:-default} and ${VAR-default} supply their own fallback, so they are
  // safe under set -u however the environment arrives.
  const guarded = new Set([...source.matchAll(/\$\{([A-Z][A-Z_0-9]{2,})[:-]/g)].map((m) => m[1]));
  // Names the shell or the environment provides.
  const ambient = new Set([
    "HOME", "PATH", "TMPDIR", "USER", "SHELL", "PWD", "LANG", "OSTYPE", "BASH_SOURCE",
    "PIPESTATUS", "RANDOM", "EUID", "IFS", "TERM", "SUDO_USER", "GITHUB_TOKEN", "CI",
  ]);

  const unbound = [...used].filter((name) => (
    !defined.has(name) && !guarded.has(name) && !ambient.has(name)
  )).sort();

  assert.deepEqual(
    unbound,
    [],
    "these are referenced with ${...} but never assigned, and the installer runs under "
      + "set -u, so each one aborts or prints an error the moment its line is reached. "
      + "Either define it, or give it a default with ${NAME:-}.",
  );
});
