import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const unix = readFileSync(path.join(root, "install.sh"), "utf8");
const windows = readFileSync(path.join(root, "install.cmd"), "utf8");
const installerPage = readFileSync(path.join(root, "index.html"), "utf8");
const frontierUnix = readFileSync(path.join(root, "frontier.sh"), "utf8");
const frontierWindows = readFileSync(path.join(root, "frontier.ps1"), "utf8");
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
const brainSurgeon = readFileSync(
  path.join(root, "electron", "brain-surgeon.mjs"),
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

test("beta installers use this distribution as the canonical source", () => {
  for (const installer of [unix, windows]) {
    assert.match(installer, /kody-w\/openrappter/);
    assert.doesNotMatch(installer, /kody-w\/rapp-installer/);
  }
});

test("Frontier is the primary customer-facing launcher identity", () => {
  assert.equal(packageJson.name, "@aibast/rapp-brainstem-frontier");
  assert.equal(packageJson.version, "0.1.0-beta.7");
  assert.equal(readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim(), packageJson.version);
  for (const installer of [unix, windows]) {
    assert.match(installer, /brainstem-frontier/);
    assert.match(installer, /Frontier and standard Brainstem share/);
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

test("released beta installs can pin the launcher and runtime to one commit", () => {
  for (const installer of [unix, windows]) {
    assert.match(installer, /BRAINSTEM_BETA_COMMIT/);
    assert.match(installer, /40-character commit SHA/);
    assert.match(installer, /reset --hard FETCH_HEAD/);
  }
  assert.match(unix, /--version "\$REPO_COMMIT"/);
  assert.match(unix, /GIT_CONFIG_KEY_/);
  assert.match(windows, /--version "%REPO_COMMIT%"/);
  assert.match(windows, /GIT_CONFIG_KEY_0/);
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
});

test("dedicated beta page scripts parse", () => {
  const scripts = [...installerPage.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 2);
  for (const [, source] of scripts) {
    assert.doesNotThrow(() => new Function(source));
  }
});

test("beta launcher reuses the global Brainstem without duplicate toolbar IPC", () => {
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
  assert.match(uiDriverAgent, /actual visible RAPP Brainstem Frontier frontend/);
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

test("beta embeds the full GitHub Copilot Brain Surgeon loop", () => {
  assert.match(ui, /id="surgeon-tab"/);
  assert.match(ui, /Brain Surgeon · agent mode/);
  assert.match(ui, /files, shell, tests, Brainstem/);
  assert.match(renderer, /brainstemBeta\.surgeonSend/);
  assert.match(renderer, /clearSurgeonUi/);
  assert.match(renderer, /rapp-beta-delete-agent/);
  assert.match(renderer, /rapp-beta-export-agent/);
  assert.match(preload, /beta:surgeon-send/);
  assert.match(preload, /beta:delete-agent/);
  assert.match(preload, /beta:export-agent/);
  assert.match(main, /new BrainSurgeon/);
  assert.match(main, /BETA_FRAME_BRIDGE_SOURCE/);
  assert.match(main, /beta-app-btn/);
  assert.match(main, /rapp-beta:check-updates/);
  assert.match(main, /brainLogo\.title = "Toggle live agents"/);
  assert.match(main, /button\.title = "RAPP Brainstem Frontier menu"/);
  assert.match(main, /panel\.querySelector\("h3"\)/);
  assert.match(main, /app\.getPath\("downloads"\)/);
  assert.match(main, /Download agent\.py/);
  assert.match(main, /Delete agent/);
  assert.match(main, /beta-agent-icon-button/);
  assert.match(main, /humanizeAgentName/);
  assert.doesNotMatch(ui, /beta-menu-toggle/);
  assert.match(brainSurgeon, /real GitHub Copilot coding-agent loop/);
  assert.match(brainSurgeon, /onPermissionRequest: approveAll/);
  assert.match(brainSurgeon, /delegate_to_brainstem/);
  assert.match(brainSurgeon, /ephemeral_agent/);
  assert.match(brainSurgeon, /ensure_copilot_studio_deploy_agents/);
  assert.match(brainSurgeon, /start_copilot_studio_login/);
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
  assert.match(unix, /brainstem-surgeon/);
  assert.match(unix, /brainstem-walkthrough/);
  assert.match(windows, /brainstem-surgeon\.cmd/);
  assert.match(windows, /brainstem-walkthrough\.cmd/);
  assert.match(
    main,
    /function emitState\(\)[\s\S]*?\r?\n}\r?\n\r?\nfunction emitSurgeonEvent/,
  );
});

test("blue Brainstem icon toggles the live agents Explorer", () => {
  assert.doesNotMatch(ui, /id="explorer-tab"/);
  assert.match(ui, /id="agent-tree"/);
  assert.match(ui, /live Brainstem workspace/);
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
  assert.doesNotMatch(renderer, /openBrowser|openVscode|restart/);
});
