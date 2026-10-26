import { app, BrowserWindow, ipcMain, Menu } from "electron";
import { join } from "node:path";
import { openDb } from "@market/db";
import { createService } from "./service";
import { deviceFingerprint } from "./machine";

declare const __LICENSE_PUBLIC_KEY__: string; // injected by build.mjs

const dev = !app.isPackaged;
let win: BrowserWindow | null = null;

async function printHtml(html: string) {
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  await new Promise<void>((resolve, reject) =>
    w.webContents.print({ silent: true, printBackground: true, margins: { marginType: "none" } }, (ok, why) => {
      w.close();
      ok ? resolve() : reject(new Error(why || "فشلت الطباعة"));
    }),
  );
}

function start() {
  const migrations = dev ? join(__dirname, "../../../packages/db/migrations") : join(process.resourcesPath, "migrations");
  const db = openDb(join(app.getPath("userData"), "market.db"), migrations);
  const svc = createService({ db, fingerprint: deviceFingerprint(), publicKeyPem: __LICENSE_PUBLIC_KEY__, print: printHtml });

  for (const name of Object.keys(svc) as (keyof typeof svc)[]) {
    ipcMain.handle(`api:${name}`, async (_e, ...args) => {
      try { return await (svc[name] as (...a: unknown[]) => unknown)(...args); }
      catch (e) { throw new Error((e as Error).message); }
    });
  }

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1280, height: 800, autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: dev },
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadFile(join(__dirname, "../ui/index.html"));
  if (!dev) win.webContents.on("devtools-opened", () => win?.webContents.closeDevTools());
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(start);
app.on("window-all-closed", () => app.quit());
