import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { API_METHODS } from "@market/core";
import { getSetting, listUsers, openDb, type Db } from "@market/db";
import { createService, type Service } from "./service";
import { createCloud, type CloudConfig } from "./cloud";
import { deviceFingerprint } from "./machine";
import { seedDemo } from "./demo";

declare const __LICENSE_PUBLIC_KEY__: string; // injected by build.mjs
declare const __CLOUD_CONFIG__: string; // JSON {apiKey, projectId} or ""

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
  const dataDir = app.getPath("userData");
  const dbPath = join(dataDir, "market.db");
  const demoPath = join(dataDir, "demo.db");
  const fingerprint = deviceFingerprint();
  const cloudConfig: CloudConfig | null = __CLOUD_CONFIG__ ? JSON.parse(__CLOUD_CONFIG__) : null;

  const db: Db = openDb(dbPath, migrations);
  let demoDb: Db | null = null;
  let demoSvc: Service | null = null;

  const common = { fingerprint, publicKeyPem: __LICENSE_PUBLIC_KEY__, print: printHtml };
  const cloud = createCloud({ db, config: cloudConfig?.apiKey && cloudConfig.projectId ? cloudConfig : null, deviceCode: fingerprint, alertDays: () => Number(getSetting(db, "expiry_alert_days")) || 30 });

  const real: Service = createService({
    ...common, db, cloud, isDemo: () => false,
    backupDir: join(dataDir, "backups"),
    pickFolder: async () => (await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"], title: "اختار مكان النسخة الاحتياطية" })).filePaths[0] ?? null,
    pickFile: async () => (await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "نسخة احتياطية", extensions: ["db"] }], title: "اختار ملف النسخة الاحتياطية" })).filePaths[0] ?? null,
    restoreFrom: async (file) => {
      db.close();
      for (const ext of ["-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
      copyFileSync(file, dbPath);
      app.relaunch();
      app.exit(0);
    },
    openUrl: async (url) => { if (new URL(url).host === "wa.me") await shell.openExternal(url); },
    enterDemo: async () => {
      if (demoDb) { demoDb.close(); demoDb = null; }
      if (existsSync(demoPath)) {
        const probe = openDb(demoPath, migrations);
        const stale = Date.now() - Number(getSetting(probe, "demo_seeded_at") ?? 0) > 12 * 3_600_000;
        probe.close();
        if (stale) for (const ext of ["", "-wal", "-shm"]) rmSync(demoPath + ext, { force: true });
      }
      demoDb = openDb(demoPath, migrations);
      if (!listUsers(demoDb).length) seedDemo(demoDb);
      demoSvc = createService({ ...common, db: demoDb, isDemo: () => true, openUrl: async (u) => { if (new URL(u).host === "wa.me") await shell.openExternal(u); } });
      await demoSvc.login(listUsers(demoDb)[0].id, "1234");
      active = demoSvc;
    },
    exitDemo: async () => {
      await demoSvc?.logout();
      demoDb?.close(); demoDb = null; demoSvc = null;
      active = real;
    },
  });
  let active: Service = real;

  for (const name of API_METHODS)
    ipcMain.handle(`api:${name}`, async (_e, ...args) => {
      try { return await (active[name] as (...a: unknown[]) => unknown)(...args); }
      catch (e) { throw new Error((e as Error).message); }
    });

  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1366, height: 820, minWidth: 1000, minHeight: 640, autoHideMenuBar: true, show: false,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: dev },
  });
  win.once("ready-to-show", () => { win?.maximize(); win?.show(); });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.loadFile(join(__dirname, "../ui/index.html"));
  if (!dev) win.webContents.on("devtools-opened", () => win?.webContents.closeDevTools());

  setTimeout(() => real.autoBackup().catch(() => {}), 8_000);
  const stopCloud = cloud.start();
  app.on("before-quit", stopCloud);
}

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(start);
app.on("window-all-closed", () => app.quit());
