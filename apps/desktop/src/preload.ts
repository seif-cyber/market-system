import { contextBridge, ipcRenderer } from "electron";
import { API_METHODS } from "../../../packages/core/src/apiMethods";

contextBridge.exposeInMainWorld(
  "api",
  Object.fromEntries(API_METHODS.map((m) => [m, (...a: unknown[]) => ipcRenderer.invoke(`api:${m}`, ...a)])),
);
