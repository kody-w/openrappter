import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { createOpenRappterBrandingSource } from "../electron/injection-sources.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8")
  .replaceAll("\r\n", "\n");

const packageJson = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("build/manifest.webmanifest"));
const main = read("electron/main.mjs");
const injectionSources = read("electron/injection-sources.mjs");
const ui = read("ui/index.html");
const renderer = read("ui/renderer.js");
const installerPage = read("index.html");
const showMode = read("show-mode.html");
const unixInstaller = read("install.sh");
const windowsInstaller = read("install.cmd");
const windowsShortcuts = read("scripts/create-windows-shortcuts.js");
const icon = read("build/icon.svg");
const thirdPartyNotices = read("THIRD-PARTY-NOTICES.md");

test("the packaged desktop product is OpenRappter, not a Brainstem host", () => {
  assert.equal(packageJson.name, "@openrappter/desktop");
  assert.equal(packageJson.build.productName, "OpenRappter");
  assert.equal(packageJson.build.appId, "io.github.kody-w.openrappter");
  assert.match(packageJson.description, /^OpenRappter desktop application\b/);
  assert.match(main, /app\.setName\(neighborhood\.app_name\)/);
  assert.match(main, /title: openRappterWindowTitle/);
  assert.match(ui, /<title>OpenRappter<\/title>/);
  assert.equal(manifest.name, "OpenRappter");
  assert.equal(manifest.short_name, "OpenRappter");
});

test("the desktop icon is the OpenRappter dinosaur on every visible shell", () => {
  assert.match(icon, /id="dino"/);
  assert.match(icon, /#58f5d2/i);
  assert.doesNotMatch(icon, /M184 0c-30\.9 0-56\.5 22\.7-61\.1 52\.3/);
  assert.match(ui, /<link rel="icon" href="\.\.\/build\/icon\.svg">/);
});

test("every installed launcher and shortcut is named OpenRappter", () => {
  assert.match(unixInstaller, /Applications\/OpenRappter\.app/);
  assert.match(unixInstaller, /CFBundleName<\/key><string>OpenRappter/);
  assert.match(unixInstaller, /CFBundleIdentifier<\/key><string>io\.github\.kody-w\.openrappter/);
  assert.match(unixInstaller, /openrappter\.desktop/);
  assert.match(unixInstaller, /Name=OpenRappter/);
  assert.match(unixInstaller, /openrappter-app/);
  assert.match(windowsShortcuts, /var name = "OpenRappter\.lnk"/);
  assert.match(windowsShortcuts, /shortcut\.TargetPath = launcher/);
  assert.match(windowsInstaller, /openrappter-app\.cmd/);
  assert.match(windowsInstaller, /OpenRappter is installed/);

  for (const legacy of [
    "RAPP Brainstem Frontier.app",
    "RAPP Brainstem Beta.app",
    "RAPP Brainstem Frontier.lnk",
    "RAPP Brainstem Beta.lnk",
  ]) {
    assert.ok(
      unixInstaller.includes(legacy) || windowsShortcuts.includes(legacy),
      `the installer must remove the legacy ${legacy} identity`,
    );
  }
});

test("OpenRappter is the isolated fully built-out twin beside bare Brainstem", () => {
  assert.match(
    unixInstaller,
    /OPENRAPPTER_HOME="\$\{OPENRAPPTER_HOME:-\$HOME\/\.openrappter\}"/,
  );
  assert.match(
    unixInstaller,
    /BRAINSTEM_HOME="\$\{OPENRAPPTER_BRAINSTEM_HOME:-\$OPENRAPPTER_HOME\/brainstem\}"/,
  );
  assert.match(unixInstaller, /BETA_HOME="\$\{BRAINSTEM_BETA_HOME:-\$OPENRAPPTER_HOME\/desktop\}"/);
  assert.match(unixInstaller, /export BRAINSTEM_BETA_OWN_PORT="1"/);
  assert.match(windowsInstaller, /set "OPENRAPPTER_HOME=%USERPROFILE%\\\.openrappter"/);
  assert.match(windowsInstaller, /set "BRAINSTEM_HOME=%OPENRAPPTER_HOME%\\brainstem"/);
  assert.match(windowsInstaller, /set "BETA_HOME=%OPENRAPPTER_HOME%\\desktop"/);
  assert.match(windowsInstaller, /set "BRAINSTEM_BETA_OWN_PORT=1"/);
  assert.match(main, /path\.join\(openRappterHome, "desktop"\)/);
  assert.match(installerPage, /fully built-out twin/);
});

test("the Electron shell presents the full OpenRappter application", () => {
  assert.match(ui, /<h1>Starting OpenRappter<\/h1>/);
  assert.match(ui, /title="OpenRappter chat"/);
  assert.match(ui, /aria-label="Live OpenRappter agents Explorer"/);
  assert.match(ui, /live OpenRappter workspace/);
  assert.match(ui, /Agent · files, shell, tests, OpenRappter/);
  assert.match(ui, /Rappter Surgeon · agent mode/);
  assert.match(ui, />Enter OpenRappter<\/button>/);
  assert.match(renderer, /GitHub Copilot in OpenRappter/);
  assert.match(renderer, /same OpenRappter workspace/);
  assert.match(renderer, /test OpenRappter/);
  assert.match(renderer, /Inspect OpenRappter and tell me what it can do/);
  assert.doesNotMatch(ui, /Brain Surgeon/);
  assert.doesNotMatch(renderer, /Brain Surgeon/);
  assert.match(main, /new RappterSurgeon/);
  assert.match(main, /from "\.\/rappter-surgeon\.mjs"/);
});

test("the unchanged Brainstem component is visibly hosted as OpenRappter", () => {
  assert.match(injectionSources, /createOpenRappterBrandingSource/);
  assert.match(injectionSources, /document\.title = "OpenRappter"/);
  assert.match(injectionSources, /replaceAll\("RAPP Brainstem", "OpenRappter"\)/);
  assert.match(injectionSources, /Message OpenRappter/);
  assert.match(injectionSources, /data-openrappter-branded/);
  assert.match(injectionSources, /MutationObserver/);
  assert.match(main, /createOpenRappterBrandingSource/);
  assert.match(main, /brandingSource: openRappterBrandingSource/);
});

test("dynamic branding is idempotent under its own mutation observer", () => {
  let title = "RAPP Brainstem";
  let titleWrites = 0;
  let text = "RAPP Brainstem";
  let textWrites = 0;
  let placeholder = "Message RAPP Brainstem...";
  let placeholderWrites = 0;
  let observerCallback;
  const textNode = {
    nodeType: 3,
    parentElement: { tagName: "DIV" },
    get nodeValue() { return text; },
    set nodeValue(value) {
      textWrites += 1;
      text = value;
    },
  };
  const composer = {
    get placeholder() { return placeholder; },
    set placeholder(value) {
      placeholderWrites += 1;
      placeholder = value;
    },
  };
  const body = { nodeType: 1 };
  const document = {
    body,
    documentElement: { setAttribute() {} },
    get title() { return title; },
    set title(value) {
      titleWrites += 1;
      title = value;
    },
    createTreeWalker(root) {
      let emitted = false;
      return {
        currentNode: null,
        nextNode() {
          if (root !== body || emitted) return false;
          emitted = true;
          this.currentNode = textNode;
          return true;
        },
      };
    },
    getElementById(id) {
      return id === "input" ? composer : null;
    },
    querySelector() {
      return null;
    },
  };
  class MutationObserver {
    constructor(callback) {
      observerCallback = callback;
    }
    observe() {}
  }
  vm.runInNewContext(createOpenRappterBrandingSource(), {
    document,
    MutationObserver,
  });
  assert.equal(title, "OpenRappter");
  assert.equal(text, "OpenRappter");
  assert.equal(placeholder, "Message OpenRappter...");
  assert.deepEqual(
    [titleWrites, textWrites, placeholderWrites],
    [1, 1, 1],
  );

  observerCallback([
    { type: "characterData", target: textNode, addedNodes: [] },
    { type: "attributes", target: composer, addedNodes: [] },
  ]);
  assert.deepEqual(
    [titleWrites, textWrites, placeholderWrites],
    [1, 1, 1],
    "already branded nodes must not schedule another observer cycle",
  );
});

test("the public beta and Show Mode pages sell OpenRappter", () => {
  assert.match(installerPage, /<title>OpenRappter Desktop Installer<\/title>/);
  assert.match(installerPage, /Install the OpenRappter desktop application/);
  assert.match(showMode, /Show Mode · OpenRappter/);
  assert.match(showMode, />OpenRappter<\/span>/);
});

test("the OpenRappter desktop distribution is Apache-2.0", () => {
  const license = read("LICENSE");
  assert.equal(packageJson.license, "Apache-2.0");
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(thirdPartyNotices, /OpenRappter is distributed under the Apache License 2\.0/);
  assert.ok(packageJson.build.files.includes("LICENSE"));
  assert.ok(packageJson.build.files.includes("THIRD-PARTY-NOTICES.md"));
});

test("legacy Brainstem Frontier branding is absent from customer-facing surfaces", () => {
  const customerFacing = new Map([
    ["package.json", JSON.stringify(packageJson)],
    ["build/manifest.webmanifest", JSON.stringify(manifest)],
    ["electron/main.mjs", main],
    ["ui/index.html", ui],
    ["ui/renderer.js", renderer],
    ["index.html", installerPage],
    ["show-mode.html", showMode],
  ]);
  for (const [file, source] of customerFacing) {
    assert.doesNotMatch(
      source,
      /RAPP Brainstem Frontier/,
      `${file} still exposes the imported product identity`,
    );
  }
});
