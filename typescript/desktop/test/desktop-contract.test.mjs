import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
// The readiness handshake was lifted out of main.ts so it could be driven by a
// test — main.ts imports electron and cannot be loaded here. These text
// assertions follow it to the module that now owns it.
const gatewayReady = readFileSync(
  new URL('../src/gateway-ready.ts', import.meta.url),
  'utf8',
);
const runtimeEntry = readFileSync(
  new URL('../../src/index.ts', import.meta.url),
  'utf8',
);
const preload = readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8');
const narration = readFileSync(new URL('../src/narration.ts', import.meta.url), 'utf8');
const vibevoice = readFileSync(new URL('../src/vibevoice.ts', import.meta.url), 'utf8');
const desktopPackage = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const macEntitlements = readFileSync(
  new URL('../build/entitlements.mac.plist', import.meta.url),
  'utf8',
);
const runtimeInstaller = readFileSync(
  new URL('../scripts/install-runtime.mjs', import.meta.url),
  'utf8',
);
const { SECURE_RENDERER_PREFERENCES } = await import(
  '../dist/window-security.js'
);

test('desktop renderer is isolated and sandboxed', () => {
  assert.deepEqual(SECURE_RENDERER_PREFERENCES, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
  });
  assert.match(main, /SECURE_RENDERER_PREFERENCES/);
});

test('signed macOS builds retain microphone and Apple Events capabilities', () => {
  assert.equal(
    desktopPackage.build.mac.entitlements,
    'build/entitlements.mac.plist',
  );
  assert.equal(
    desktopPackage.build.mac.entitlementsInherit,
    'build/entitlements.mac.inherit.plist',
  );
  assert.match(macEntitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(macEntitlements, /com\.apple\.security\.automation\.apple-events/);
});

test('desktop exposes one narrow context bridge', () => {
  assert.match(preload, /contextBridge\.exposeInMainWorld/);
  assert.match(preload, /ipcRenderer\.invoke\('openrappter:show-and-tell'/);
  assert.doesNotMatch(preload, /require\s*\(/);
  assert.match(preload, /openrappter:narration/);
  assert.match(preload, /openrappter:voice/);
});

test('local tell and voice models bootstrap privately', () => {
  assert.match(narration, /Xenova\/whisper-small/);
  assert.match(narration, /local_files_only/);
  assert.match(vibevoice, /microsoft\/VibeVoice-Realtime-0\.5B/);
  assert.match(vibevoice, /94da20d98b2fa7688e9cbfaf7692ddb4954f7600/);
  assert.match(vibevoice, /127\.0\.0\.1/);
  assert.match(vibevoice, /--no-access-log/);
  assert.match(vibevoice, /activeChildren/);
  assert.match(vibevoice, /lifecycleGeneration/);
  assert.match(vibevoice, /this\.assertGeneration\(generation\);[\s\S]*const device/);
  assert.match(vibevoice, /const lateServer = this\.server/);
  assert.match(vibevoice, /process\.kill\(-child\.pid/);
  assert.match(vibevoice, /taskkill\.exe/);
  assert.match(vibevoice, /'\/T'/);
  assert.match(main, /Download local Whisper/);
  assert.match(main, /Enable local VibeVoice/);
  assert.match(
    main,
    /if \(!vibeVoice\(\)\.isInstalled\(\)\)[\s\S]*approve its model download/,
  );
});

test('desktop publishes one authenticated endpoint for tray and Swift Bar', () => {
  assert.match(main, /openrappter-desktop-endpoint\/1\.0/);
  assert.match(main, /new Tray/);
  assert.match(main, /Launch OpenRappter Bar/);
  assert.match(main, /app\.setLoginItemSettings/);
  assert.match(main, /async function waitForRenderer/);
  assert.match(main, /render-process-gone/);
  assert.match(main, /webContents\.on\('did-finish-load'/);
  assert.match(main, /await focusWindow\('chat'\)/);
  assert.match(main, /\.catch\(showTrayError\)/);
});

test('desktop accepts gateway readiness only from its owned child IPC channel', () => {
  assert.match(main, /stdio: \['ignore', 'ignore', 'ignore', 'ipc'\]/);
  assert.match(gatewayReady, /openrappter-gateway-ready\/1\.0/);
  assert.doesNotMatch(main, /desktop_probe_/);
  assert.match(runtimeEntry, /process\.send\?\.\(\{/);
  assert.match(runtimeEntry, /openrappter-gateway-ready\/1\.0/);
});

test('chat-controlled agent injection is capability-scanned and approved', () => {
  assert.match(main, /scanAgentCapabilities/);
  assert.match(main, /Detected hints/);
  assert.match(main, /compileAgentForImport/);
  assert.match(main, /\/agents\/import/);
  assert.match(main, /Install a hot-loaded agent/);
});

test('sensitive recorder actions use native confirmation', () => {
  for (const purpose of ['start', 'capture', 'approve', 'delete']) {
    assert.match(main, new RegExp(`${purpose}:\\s*\\{`));
  }
  assert.match(main, /dialog\.showMessageBox/);
  assert.match(main, /delete input\.consent_token/);
});

test('desktop reuses the packaged OpenRappter gateway and core', () => {
  assert.match(main, /runtime[\s\S]*node_modules[\s\S]*openrappter/);
  assert.match(main, /ShowAndTellAgent\.js/);
  assert.match(main, /--daemon/);
  assert.match(gatewayReady, /openrappter-gateway-ready\/1\.0/);
  assert.match(main, /window\.loadFile\(uiIndex\)/);
  assert.match(preload, /gatewayUrl:/);
  assert.match(main, /onBeforeSendHeaders/);
  assert.match(main, /Origin:\s*gatewayOrigin/);
  assert.match(main, /required\.every\(\(key\) => result\[key\] === true\)/);
  assert.match(main, /SMOKE_ERROR instance lock unavailable/);
  assert.match(main, /async function finishDesktopSmoke/);
  assert.match(main, /child\.kill\('SIGKILL'\)/);
  assert.match(main, /await Promise\.allSettled[\s\S]*hardProcess\.reallyExit\(exitCode\)/);
  assert.match(
    main,
    /OPENRAPPTER_DESKTOP_SMOKE === '1'[\s\S]*OPENRAPPTER_SMOKE_ERROR/,
  );
  assert.match(runtimeInstaller, /pack-locked\.mjs/);
  assert.match(runtimeInstaller, /'--strip-components=1'/);
  assert.match(runtimeInstaller, /'ci'/);
  assert.match(runtimeInstaller, /Desktop runtime dependency drifted/);
  assert.match(main, /OPENRAPPTER_DESKTOP_SMOKE/);
  assert.match(main, /openrappterFrontierSemantic\.open\('show-and-tell'\)/);
  assert.match(main, /frontier-feature-content/);
  assert.match(main, /frontierPrimary/);
  assert.match(main, /frontierChat/);
  assert.match(main, /contentDocument\?\.getElementById\('model-select'\)/);
  assert.match(main, /contentDocument\?\.getElementById\('starter-prompts'\)/);
  assert.match(main, /document\.title === 'OpenRappter'/);
  assert.match(main, /getElementById\('brainstem'\)/);
  assert.match(main, /getElementById\('surgeon'\)/);
  assert.doesNotMatch(main, /openrappterGrailSemantic/);
});

// OPENRAPPTER_DESKTOP_SMOKE is a process-wide launch flag, and the release
// workflow sets it on the packaged, signed binary -- so whatever it switches
// off is switched off in the shipped app, not just in a dev build.
//
// main.ts raises consent dialogs from four functions. Three of them used to be
// skipped outright when that variable was set. Two of those three were never
// needed: the embedded smoke script only ever asks narration and voice for
// their status, never for a download or an enable, so the bypasses bought
// nothing and waived consent for a multi-gigabyte model download and a local
// Python environment install.
//
// The remaining one is real -- the smoke run does install two agents. It is
// left as a single-factor bypass on purpose. The obvious tightening, copying
// the per-request `__smoke` flag that handleShowAndTell uses, does not work
// here: DesktopControlAgent.perform copies args through a fixed eight-key
// allowlist (view, ref, value, direction, amount, milliseconds, filename,
// source), so an extra key is dropped before it ever reaches the queue. Adding
// the flag without widening that allowlist would fail only in the release
// smoke run, which is the worst place to find out.

// A Windows checkout can carry CRLF, and these assertions slice on line
// shapes, so normalise first. Without this the slice lookup fails outright on
// Windows rather than quietly returning the wrong text.
const mainSource = main.replace(/\r\n/g, '\n');

function functionBody(source, name) {
  const start = source.indexOf(`\nasync function ${name}(`);
  assert.notEqual(start, -1, `main.ts no longer declares ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `could not find the end of ${name}`);
  return source.slice(start, end + 2);
}

const CONSENT_DIALOG_FUNCTIONS = [
  'handleNarration',
  'handleVoice',
  'nativeConsent',
  'installAgentFromCommand',
];

test('only the agent install consent dialog answers to the smoke flag', () => {
  const gated = [];
  for (const name of CONSENT_DIALOG_FUNCTIONS) {
    const body = functionBody(mainSource, name);
    // Anti-vacuity: if a rename or refactor empties one of these slices the
    // loop would silently pass, so require the dialog to still be in there.
    assert.match(
      body,
      /dialog\.showMessageBox/,
      `${name} no longer raises a consent dialog`,
    );
    if (body.includes('OPENRAPPTER_DESKTOP_SMOKE')) gated.push(name);
  }
  assert.deepEqual(gated, ['installAgentFromCommand']);
});

test('the smoke run never asks narration or voice to do the gated work', () => {
  const smokeScript = mainSource.slice(
    mainSource.indexOf("document.documentElement.dataset.openrappterShell"),
  );
  assert.ok(smokeScript.length > 1000, 'could not locate the smoke script');
  assert.match(smokeScript, /\.narration\(\{/);
  assert.match(smokeScript, /\.voice\(\{/);
  assert.doesNotMatch(smokeScript, /action: 'download'/);
  assert.doesNotMatch(smokeScript, /action: 'enable'/);
});

test('the Show-and-Tell consent bypass needs a second per-request factor', () => {
  const body = functionBody(mainSource, 'handleShowAndTell');
  assert.match(
    body,
    /OPENRAPPTER_DESKTOP_SMOKE === '1'[\s\S]{0,60}input\.__smoke === true/,
  );
  assert.match(body, /!smokeBypass && !\(await nativeConsent\(purpose\)\)/);
});
