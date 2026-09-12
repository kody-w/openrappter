import { contextBridge, ipcRenderer } from "electron";
import { createBridge } from "./bridge.js";

contextBridge.exposeInMainWorld("rappWork", createBridge(ipcRenderer));
