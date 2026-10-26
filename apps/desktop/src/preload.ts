import { contextBridge, ipcRenderer } from "electron";

const methods = [
  "bootstrap", "setupOwner", "login", "logout", "saveSettings", "activate", "scan", "search",
  "checkout", "importCsv", "todaySummary", "addUser", "print",
] as const;

contextBridge.exposeInMainWorld(
  "api",
  Object.fromEntries(methods.map((m) => [m, (...a: unknown[]) => ipcRenderer.invoke(`api:${m}`, ...a)])),
);
