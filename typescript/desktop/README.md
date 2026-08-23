# OpenRappter Desktop

Electron is the desktop host, not a fork of the runtime. It launches or reuses
the packaged OpenRappter gateway, loads the same web UI, and exposes one
context-isolated IPC bridge for Show-and-Tell.

The default renderer is **Rapter's Clever Girl Edition (Windows XPedition)**.
It packages the same UI and original landscape used by the hosted dashboard.
The previous sidebar shell remains available from
**Start → Legacy OpenRappter** for the migration release.

```bash
cd typescript/desktop
npm install
npm start
```

The main process owns native confirmation dialogs for recording, screenshot
capture, workflow approval, and deletion. The renderer never receives consent
tokens, filesystem paths, Node.js access, or raw Electron APIs.
