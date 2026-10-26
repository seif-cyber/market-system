// UI + real service end-to-end: the built React app runs in Chromium, its window.api is bridged to the real service (in-memory DB).
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addProduct, openDb } from "@market/db";
import { createService } from "../src/service";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] ?? ".";
const pub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

const db = openDb(":memory:");
addProduct(db, { name: "شاي العروسة", price: 550, stock: 50, barcodes: ["6221"] });
let printed = "";
const svc = createService({ db, fingerprint: "TESTDEVICE", publicKeyPem: pub, print: async (h) => { printed = h; } });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
for (const m of Object.keys(svc)) await page.exposeFunction(`__${m}`, (...a: unknown[]) => (svc as any)[m](...a));
await page.addInitScript((methods: string[]) => {
  (window as any).api = Object.fromEntries(methods.map((m) => [m, (...a: unknown[]) => (window as any)[`__${m}`](...a)]));
}, Object.keys(svc));
page.on("pageerror", (e: Error) => { throw e; });

// Chromium blocks ES modules over file://, so serve the build locally (Electron's loadFile is fine).
const root = fileURLToPath(new URL("../../ui/dist/", import.meta.url));
const server = createServer((req, res) => {
  const f = root + (req.url === "/" ? "index.html" : req.url!.split("?")[0]);
  try { res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : "text/html"); res.end(readFileSync(f)); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
await page.goto(`http://localhost:${(server.address() as any).port}/`);
await page.fill("input:not([type=password])", "المالك");
await page.fill("input[type=password]", "1234");
await page.click("button.primary");
await page.fill("input[type=password]", "1234");
await page.click("button.primary");

// settings: brand + logo
await page.click("nav >> text=الإعدادات");
await page.fill("label:has-text('اسم المحل') input", "سوبر ماركت النور");
await page.click("button.primary >> text=حفظ");
await page.waitForSelector("text=اتحفظ");
await page.screenshot({ path: `${out}/settings.png` });

// sell by barcode
await page.click("nav >> text=البيع");
await page.fill(".scan", "6221"); await page.press(".scan", "Enter");
await page.fill(".scan", "6221"); await page.press(".scan", "Enter");
await page.waitForSelector("td:has-text('شاي العروسة')");
await page.screenshot({ path: `${out}/pos.png` });
await page.click("button.primary >> text=نقدي");
await page.waitForSelector("text=تمت الفاتورة رقم 1");
await new Promise((r) => setTimeout(r, 200));
if (!printed.includes("سوبر ماركت النور") || !printed.includes("11.00")) throw new Error("receipt wrong: " + printed.slice(0, 300));
console.log("E2E OK: login, brand setting, barcode sale, receipt printed");
await browser.close();
server.close();
