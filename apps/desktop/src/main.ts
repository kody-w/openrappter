import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, Tray, utilityProcess } from "electron";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_URL, IPC, isAppDocument, parseRequest, supportedPlatform, trustedSender, windowOptions, type BridgeEvent, type HostState } from "./contract.js";
import { contentSecurityPolicy, serveAsset } from "./assets.js";
import { HostProcess, type OwnedChild } from "./host-process.js";
import { HostRpc } from "./rpc.js";

app.setName("RAPP Work");
if (!app.isPackaged && process.env.RAPP_WORK_USER_DATA) {
  app.setPath("userData", resolve(process.env.RAPP_WORK_USER_DATA));
}
protocol.registerSchemesAsPrivileged([{ scheme: "rapp-work", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const here = dirname(fileURLToPath(import.meta.url));
const resources = app.isPackaged ? process.resourcesPath : join(here, "resources");
const uiDirectory = join(resources, "ui");
const hostEntry = app.isPackaged ? join(resources, "host", "host.cjs") : join(resources, "host.cjs");
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let host: HostProcess | undefined;
let quitting = false;
let shutdownComplete = false;
let connectionState: HostState = { state: "starting", detail: "Starting RAPP Work." };
function send(event: BridgeEvent) {
  if (window && !window.isDestroyed()) window.webContents.send(IPC.event, event);
}
function connectionChanged(state: HostState) {
  connectionState = state; send({ type: "host", ...state });
  tray?.setToolTip(`RAPP Work — ${state.state === "online" ? "Local host connected" : "Local host not connected"}`);
}
const rpc = new HostRpc(send, connectionChanged);
function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
}
async function connect() {
  if (!host || quitting) throw new Error("The desktop host is not available.");
  const lease = await host.start();
  await rpc.connect(lease);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => { /* The tray owns the single window until explicit quit. */ });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    rpc.close();
    void (host?.stop() ?? Promise.resolve()).finally(() => {
      tray?.destroy(); tray = null; shutdownComplete = true; app.quit();
    });
  });
  void app.whenReady().then(async () => {
    supportedPlatform(process.platform, process.arch);
    const html = await readFile(join(uiDirectory, "index.html"), "utf8");
    const csp = contentSecurityPolicy(html);
    protocol.handle("rapp-work", (request) => {
      if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return serveAsset(request.url, uiDirectory, csp);
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on("will-download", (event) => event.preventDefault());
    host = new HostProcess({
      spawn: () => {
        const child = utilityProcess.fork(hostEntry, [], {
          serviceName: "RAPP Work Host", stdio: "pipe",
          env: {
            HOME: app.getPath("home"), PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            NODE_ENV: "production",
          },
        });
        child.stdout?.resume(); child.stderr?.resume();
        return child;
      },
      probe: async (lease) => {
        const response = await fetch(`http://127.0.0.1:${lease.port}/healthz`, {
          headers: { Authorization: `Bearer ${lease.token}` }, signal: AbortSignal.timeout(4000), redirect: "error",
        });
        const health = await response.json() as { product?: string; protocolVersion?: number; alive?: boolean };
        return response.ok && health.product === "RAPP Work" && health.protocolVersion === 1 && health.alive === true;
      },
      forceKill: (child: OwnedChild) => {
        if (child.pid) {
          try { process.kill(child.pid, "SIGKILL"); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        } else child.kill();
      },
      stateChanged: (state) => {
        if (state.state === "offline") rpc.close();
        connectionChanged(state);
      },
    }, join(app.getPath("userData"), "workspaces"));
    window = new BrowserWindow(windowOptions(join(here, "preload.cjs")));
    window.setTitle("RAPP Work");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => { if (!isAppDocument(url)) event.preventDefault(); });
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("render-process-gone", () => connectionChanged({ state: "offline", detail: "The workspace renderer closed. Reopen RAPP Work." }));
    window.on("page-title-updated", (event) => { event.preventDefault(); window?.setTitle("RAPP Work"); });
    window.on("close", (event) => { if (!quitting) { event.preventDefault(); window?.hide(); } });
    window.on("closed", () => { window = null; });
    window.once("ready-to-show", showWindow);
    const trusted = (event: Electron.IpcMainInvokeEvent) => {
      if (!window || !trustedSender(event, window.webContents)) throw new Error("Untrusted workspace frame.");
    };
    ipcMain.handle(IPC.request, async (event, raw: unknown) => {
      trusted(event);
      let request;
      try { request = parseRequest(raw); } catch { throw new Error("Invalid workspace request."); }
      await connect();
      return rpc.request(request);
    });
    ipcMain.handle(IPC.state, (event) => { trusted(event); return connectionState; });
    const trayIcon = nativeImage.createFromPath(join(here, "..", "assets", "tray.png"));
    trayIcon.setTemplateImage(true);
    tray = new Tray(trayIcon);
    tray.setToolTip("RAPP Work");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open RAPP Work", click: showWindow },
      { type: "separator" },
      { label: "Quit RAPP Work", click: () => app.quit() },
    ]));
    tray.on("click", showWindow);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "RAPP Work", submenu: [{ role: "about", label: "About RAPP Work" }, { type: "separator" }, { role: "hide", label: "Hide RAPP Work" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit", label: "Quit RAPP Work" }] },
      { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
      { label: "View", submenu: [{ role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] },
      { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { label: "Open RAPP Work", click: showWindow }] },
    ]));
    await window.loadURL(APP_URL);
    void connect().catch(() => connectionChanged({ state: "offline", detail: "The owned host could not start. Refresh to retry." }));
  }).catch(() => {
    dialog.showErrorBox("RAPP Work could not start", "The application requires macOS on Apple silicon and its built UI and host resources.");
    app.quit();
  });
}
