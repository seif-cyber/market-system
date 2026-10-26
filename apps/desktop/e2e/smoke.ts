// UI + real service end-to-end: the built React app runs in Chromium, its window.api is bridged to the real service (demo DB in memory).
import { createRequire } from "node:module";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { API_METHODS } from "@market/core";
import { openDb } from "@market/db";
import { createService } from "../src/service";
import { seedDemo } from "../src/demo";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] ?? ".";
const pub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

const db = openDb(":memory:");
seedDemo(db);
let printed = "";
const opened: string[] = [];
const svc = createService({ db, fingerprint: "TESTDEVICE", publicKeyPem: pub, print: async (h) => { printed = h; }, openUrl: async (u) => { opened.push(u); } });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 820 } });
for (const m of API_METHODS) await page.exposeFunction(`__${m}`, (...a: unknown[]) => (svc as any)[m](...a));
await page.addInitScript((methods: string[]) => {
  (window as any).api = Object.fromEntries(methods.map((m) => [m, (...a: unknown[]) => (window as any)[`__${m}`](...a)]));
}, [...API_METHODS]);
const errors: string[] = [];
page.on("dialog", (d: any) => d.accept());
page.on("pageerror", (e: Error) => errors.push(e.message));
page.on("console", (m: any) => m.type() === "error" && errors.push(m.text()));

// Chromium blocks ES modules over file://, so serve the build locally (Electron's loadFile is fine).
const root = fileURLToPath(new URL("../../ui/dist/", import.meta.url));
const server = createServer((req, res) => {
  const f = root + (req.url === "/" ? "index.html" : req.url!.split("?")[0]);
  try { res.setHeader("content-type", f.endsWith(".js") ? "text/javascript" : f.endsWith(".css") ? "text/css" : f.endsWith(".svg") ? "image/svg+xml" : "text/html"); res.end(readFileSync(f)); }
  catch { res.statusCode = 404; res.end(); }
}).listen(0);
await page.goto(`http://localhost:${(server.address() as any).port}/`);

const shot = (n: string) => page.screenshot({ path: `${out}/${n}.png` });
const tab = (t: string) => page.click(`nav >> text=${t}`);

await shot("login");
await page.selectOption("select", { label: "المدير" });
await page.fill("input[type=password]", "1234");
await page.click("form button.primary");
await page.waitForSelector("nav");

// dashboard
await tab("لوحة التحكم");
await page.click(".tabs >> text=30 يوم");
await page.waitForSelector(".kpis");
await page.waitForSelector("text=سجل الفواتير سليم");
await shot("dashboard");

// POS: barcode sale, then scale barcode, then discount needs no approval for owner
await tab("البيع");
await page.fill(".scan", "6221001"); await page.press(".scan", "Enter");
await page.fill(".scan", "6221001"); await page.press(".scan", "Enter");
await page.fill(".scan", "1280000" + "0"); // junk -> not found
await page.press(".scan", "Enter");
await page.fill(".scan", "2000123015005"); await page.press(".scan", "Enter"); // unknown PLU
await page.fill(".scan", "2012800015005"); await page.press(".scan", "Enter"); // PLU 12800? -> not found; real PLU below
await page.fill(".scan", "2000128015005"); await page.press(".scan", "Enter"); // PLU 00128 = minced meat, 1.5 kg
await page.waitForSelector("td:has-text('لحمة مفرومة كجم')");
await shot("pos");
await page.click("button.primary >> text=نقدي");
await page.waitForSelector("text=تمت الفاتورة رقم");
await new Promise((r) => setTimeout(r, 300));
if (!printed.includes("سوبر ماركت النور")) throw new Error("receipt wrong");
const qtyLine = /1\.5 ×/.test(printed) || printed.includes("1.5");
if (!qtyLine) throw new Error("scale weight not on receipt");

// credit sale
await page.fill(".scan", "6221003"); await page.press(".scan", "Enter");
await page.click("button >> text=آجل");
await page.click(".pick button >> nth=0");
await page.click("button >> text=تأكيد البيع الآجل");
await page.waitForSelector("text=تمت الفاتورة رقم");

// hold + resume
await page.fill(".scan", "6221004"); await page.press(".scan", "Enter");
await page.click("aside button >> text=تعليق");
await page.waitForSelector("text=اتعلّقت الفاتورة");
await page.click("aside button >> text=المعلّقة");
await page.click("button >> text=استرجاع");
await page.waitForSelector("td:has-text('أرز مصري')");
await page.click("button >> text=إلغاء الفاتورة");

// offers are previewed in the cart: buy 2 get 1 free on Pepsi (demo promo), computed by the server
await page.fill(".scan", "6221011"); await page.press(".scan", "Enter");
await page.fill(".scan", "6221011"); await page.press(".scan", "Enter");
await page.fill(".scan", "6221011"); await page.press(".scan", "Enter");
await page.waitForSelector("text=خصم عروض");
await shot("pos-offers");
await page.click("button >> text=إلغاء الفاتورة");

// other pages
await tab("المخزون"); await page.waitForSelector("td >> text=شاي العروسة"); await shot("inventory");
await page.click(".tabs >> text=الصلاحية"); await page.waitForSelector("td:has-text('منتهي')"); await shot("expiry");
await tab("العملاء والموردين"); await page.waitForSelector("tr.click"); await shot("parties");
await page.click(".tabs >> text=الموردين"); await page.waitForSelector("td:has-text('مصنع الأمل للألبان')");
await page.click("tr.click >> nth=0"); await page.waitForSelector("text=كشف المورد"); await shot("supplier-statement");
await page.click(".tabs >> text=فواتير الشراء"); await page.waitForSelector("span.st"); await shot("supplier-invoices");
await page.keyboard.press("Escape");
await page.click(".tabs >> text=العملاء"); await page.click("tr.click >> nth=0"); await page.waitForSelector("text=كشف العميل"); await shot("statement");
await page.keyboard.press("Escape");

// purchases: a new invoice, part-paid from the bank
await tab("المشتريات"); await page.waitForSelector("text=علينا للموردين"); await shot("purchases");
await page.click("button >> text=+ فاتورة شراء جديدة");
await page.selectOption(".modal select >> nth=0", { index: 1 });
await page.fill("input[placeholder*='امسح الباركود']", "6221001");
await page.click(".pick button >> nth=0");
await page.fill(".modal table input[type=number] >> nth=0", "50");
await page.fill(".modal table input[type=number] >> nth=1", "9");
await page.fill("label:has-text('المدفوع دلوقتي') input", "100");
await page.selectOption("label:has-text('من فين') select", "bank");
await shot("purchase-form");
await page.click("button >> text=حفظ الفاتورة وإضافة للمخزون");
await page.waitForSelector("text=اتسجّلت فاتورة الشراء");
await tab("الخزنة"); await page.waitForSelector("text=الخزنة مطابقة لسجلات");
await tab("المخزون"); await page.click(".tabs >> text=الأقسام"); await page.waitForSelector("td:has-text('مشروبات')"); await shot("categories");
await page.click(".tabs >> text=الأصناف"); await page.waitForSelector("select >> nth=0 >> option:has-text('مشروبات')", { state: "attached" });
await page.selectOption("select >> nth=0", await page.$eval("select >> nth=0 >> option:has-text('مشروبات')", (o: any) => o.value));
await page.waitForSelector("td:has-text('بيبسي')");
// import a CSV and undo it
await page.click(".tabs >> text=استيراد من Excel");
await page.setInputFiles("input[type=file]", { name: "new.csv", mimeType: "text/csv", buffer: Buffer.from("الباركود,الاسم,السعر,الكمية,القسم\n7771,صنف مستورد,12,5,منظفات\n6221001,شاي العروسة 40 جم,13,10,مشروبات\n") });
await page.waitForSelector("button >> text=تراجع عن الاستيراد ده");
await shot("import");
await page.click("button >> text=تراجع عن الاستيراد ده");
await page.waitForSelector("text=تم التراجع");
await shot("import-undone");
await tab("العروض"); await page.waitForSelector("td:has-text('اشترِ 2 بيبسي')"); await shot("offers");
await tab("التقارير"); await page.waitForSelector("text=حدد التقرير للعرض أو الطباعة");
await page.click(".rep-item >> text=المبيعات حسب الصنف"); await page.waitForSelector("tr.sum"); await shot("reports");
await page.click(".rep-item >> text=حركة الخزنة"); await page.waitForSelector("td:has-text('بيع')");
await page.click("button >> text=Excel");
await tab("المخزون");
await tab("المصاريف"); await page.waitForSelector("td:has-text('إيجار')"); await shot("expenses");
await tab("الخزنة");
await page.waitForSelector("text=الإجمالي المتاح"); await page.waitForSelector("text=الخزنة مطابقة لسجلات"); await shot("treasury");
await page.click("button >> text=+ إيداع");
await page.fill(".modal input[type=number]", "1000");
await page.click(".modal button.primary");
await page.waitForSelector("text=اتسجّل الإيداع");
await page.waitForSelector("text=الخزنة مطابقة لسجلات");
await tab("الإعدادات");
await page.waitForSelector("text=متابعة المبيعات من الموبايل"); await shot("settings");

// support: two engineers
await page.click("header >> text=الدعم");
await page.waitForSelector("text=م. محمد شعيب"); await page.waitForSelector("text=م. سيف الدين");
await shot("support");
await page.click("text=م. محمد شعيب");
await new Promise((r) => setTimeout(r, 200));
if (!opened[0]?.startsWith("https://wa.me/201159858866")) throw new Error("support link wrong: " + opened[0]);

// shift close
await tab("البيع");
await page.click("aside button >> text=إقفال الوردية");
await page.fill(".modal input[type=number]", "5000");
await page.click(".modal button.primary");
await page.waitForSelector("text=تم تسليم الوردية");
await shot("shift-closed");
await page.click(".modal button.primary >> text=تمام");

// owner sees the shifts history
await tab("الورديات"); await page.waitForSelector("td >> text=أحمد"); await shot("shifts-owner");

// cashier: no analytics, handover flow
await page.click("header >> text=خروج");
await page.selectOption("select", { label: "منى" });
await page.fill("input[type=password]", "2222");
await page.click("form button.primary");
await page.waitForSelector("nav");
for (const hidden of ["لوحة التحكم", "الورديات", "المصاريف", "الإعدادات"]) if (await page.locator(`nav >> text=${hidden}`).count()) throw new Error("cashier sees " + hidden);
await page.waitForSelector("text=سلّم الدرج");
await shot("handover-open");
await page.click("text=المبلغ اللي في الدرج مختلف؟");
await page.fill("label:has-text('المبلغ اللي في الدرج') input", "1");
await page.fill("label:has-text('السبب') input", "ناقص");
await page.fill(".approval input[type=password]", "1234");
await shot("handover-change");
await page.click("button.primary >> text=استلمت الدرج وفتح الوردية");
await page.waitForSelector(".scan");
await page.fill(".scan", "6221001"); await page.press(".scan", "Enter");
await page.click("button.primary >> text=نقدي");
await page.waitForSelector("text=تمت الفاتورة رقم");
await tab("المخزون");
await page.waitForSelector("td >> text=شاي العروسة");
if (await page.locator("th >> text=سعر الشراء").count()) throw new Error("cashier sees purchase price");
await tab("البيع");
await page.click("aside button >> text=إقفال الوردية");
await page.waitForSelector("text=استلمت الدرج بـ");
await page.waitForSelector("text=المفروض يكون في الدرج");
await shot("handover-close");
await page.fill(".modal input[type=number]", "1");
await page.click(".modal button.primary");
await page.waitForSelector("text=تم تسليم الوردية");
await page.waitForSelector("text=عجز");
await shot("handover-done");

if (errors.length) throw new Error("browser errors:\n" + errors.join("\n"));
console.log("E2E OK");
await browser.close();
server.close();
