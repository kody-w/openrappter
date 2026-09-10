import { app, BrowserWindow, ipcMain, session, safeStorage } from "electron";
import { runNativeTeamsProof } from "../../../scripts/teams-native-proof.mjs";

void runNativeTeamsProof({ app, BrowserWindow, ipcMain, session, safeStorage }).catch((error) => {
  console.error(String(error.message || error).slice(0, 600));
  app.exit(1);
});
