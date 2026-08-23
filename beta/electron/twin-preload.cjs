const { contextBridge, ipcRenderer } = require("electron");


const twinArgument = process.argv.find((value) => (
  value.startsWith("--rapp-twin-id=")
));
const twinId = decodeURIComponent(twinArgument?.slice("--rapp-twin-id=".length) || "");

contextBridge.exposeInMainWorld("rappTwinLedger", {
  recordCompletedTurn: (turn) => (
    ipcRenderer.invoke("beta:record-twin-turn", twinId, turn)
  ),
  refreshAmbient: () => ipcRenderer.invoke("beta:refresh-ambient"),
});
