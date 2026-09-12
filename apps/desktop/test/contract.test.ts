import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { APP_URL, IPC, isAppDocument, parameterSchemas, parseRequest, supportedPlatform, trustedSender, windowOptions } from "../src/contract.js";
import { createBridge } from "../src/bridge.js";

describe("desktop boundary contracts", () => {
  it("exposes exactly three named functions and no raw Electron capabilities", async () => {
    const emitter = new EventEmitter();
    const invoke = vi.fn(async (name: string) => name === IPC.state ? { state: "online", detail: "Injected." } : {});
    const bridge = createBridge({ invoke, on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter) });
    expect(Object.keys(bridge).sort()).toEqual(["hostState", "onEvent", "request"]);
    expect(Object.isFrozen(bridge)).toBe(true);
    await bridge.request({ method: "work.snapshot", params: {} });
    expect(invoke).toHaveBeenCalledWith(IPC.request, { method: "work.snapshot", params: {} });
    expect(await bridge.hostState()).toEqual({ state: "online", detail: "Injected." });
  });
  it("drops malformed events and removes only its listener", () => {
    const emitter = new EventEmitter();
    const bridge = createBridge({ invoke: async () => ({}), on: emitter.on.bind(emitter), removeListener: emitter.removeListener.bind(emitter) });
    const callback = vi.fn();
    const remove = bridge.onEvent(callback);
    const unrelated = vi.fn(); emitter.on(IPC.event, unrelated);
    emitter.emit(IPC.event, {}, { type: "host", state: "online", detail: "Connected.", token: "never forwarded" });
    expect(callback).not.toHaveBeenCalled();
    emitter.emit(IPC.event, {}, { type: "host", state: "offline", detail: "Closed." });
    expect(callback).toHaveBeenCalledWith({ type: "host", state: "offline", detail: "Closed." });
    remove(); expect(emitter.listenerCount(IPC.event)).toBe(1);
  });
  it("uses a closed method allowlist with strict nested parameter schemas", () => {
    expect(Object.keys(parameterSchemas)).toHaveLength(20);
    for (const method of ["shell.execute", "chat.send", "sessions.list", "__proto__", "constructor"]) {
      expect(() => parseRequest({ method, params: {} })).toThrow();
    }
    expect(() => parseRequest({ method: "work.snapshot", params: { workspaceId: "other" } })).toThrow();
    expect(() => parseRequest({ method: "events.read", params: { scope: { area: "work", injected: true } } })).toThrow();
    expect(() => parseRequest({ method: "work.snapshot", params: {}, endpoint: "https://other.invalid" })).toThrow();
    expect(() => parseRequest({ method: "settings.update", params: { appearance: { theme: "arbitrary" } } })).toThrow();
  });
  it("only accepts IPC from the owned main frame at the application document", () => {
    const contents = { mainFrame: { url: APP_URL } };
    expect(trustedSender({ sender: contents, senderFrame: contents.mainFrame }, contents)).toBe(true);
    expect(trustedSender({ sender: {}, senderFrame: contents.mainFrame }, contents)).toBe(false);
    expect(trustedSender({ sender: contents, senderFrame: { url: APP_URL } }, contents)).toBe(false);
    contents.mainFrame.url = "https://example.invalid";
    expect(trustedSender({ sender: contents, senderFrame: contents.mainFrame }, contents)).toBe(false);
  });
  it("disallows network, file, credential-bearing, and alternate document navigation", () => {
    expect(isAppDocument(`${APP_URL}#agents`)).toBe(true);
    for (const url of ["https://app/index.html", "file:///index.html", "rapp-work://attacker/index.html", "rapp-work://app/other.html", "rapp-work://user@app/index.html", "not a url"]) {
      expect(isAppDocument(url)).toBe(false);
    }
  });
  it("locks down window preferences and builds only macOS arm64", () => {
    expect(windowOptions("/preload.cjs").webPreferences).toEqual({
      preload: "/preload.cjs", nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false,
    });
    expect(() => supportedPlatform("darwin", "arm64")).not.toThrow();
    expect(() => supportedPlatform("darwin", "x64")).toThrow("Apple silicon");
    expect(() => supportedPlatform("linux", "arm64")).toThrow("macOS");
  });
  it("packages one clean shell and only the UI/host application resources", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(manifest.build.productName).toBe("RAPP Work");
    expect(manifest.build.appId).toBe("com.rapp.work");
    expect(manifest.build.mac.target).toEqual([{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }]);
    expect(manifest.build.extraResources.map((item: { to: string }) => item.to)).toEqual(["host/host.cjs", "ui"]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["ws", "zod"]);
  });
});
