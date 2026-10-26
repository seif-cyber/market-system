import ExcelJS from "exceljs";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addProduct, openDb } from "@market/db";
import { createService } from "./service";
import { seedDemo } from "./demo";

const pub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
const DAY = 86_400_000;
let t = new Date(2026, 5, 15, 12, 0, 0).getTime();

function setup() {
  t = new Date(2026, 5, 15, 12, 0, 0).getTime();
  const db = openDb(":memory:");
  const exported: { kind: string; title: string; html: string; xlsx: () => Promise<Buffer> }[] = [];
  const svc = createService({
    db, fingerprint: "FP", publicKeyPem: pub, print: async () => {}, now: () => t,
    exportFile: async (a) => { exported.push({ kind: a.kind, title: a.title, html: a.html, xlsx: a.buildXlsx }); return `/tmp/${a.title}.${a.kind}`; },
  });
  addProduct(db, { name: "شاي", price: 5000, cost: 4000, stock: 10, barcodes: ["1"] });
  addProduct(db, { name: "لبن", price: 3000, cost: 2000, stock: 10, barcodes: ["2"] });
  return { db, svc, exported };
}

async function asOwner(s: ReturnType<typeof setup>) {
  await s.svc.setupOwner("المالك", "1234");
  const owner = (await s.svc.bootstrap()).users[0];
  await s.svc.login(owner.id, "1234");
  await s.svc.openShift(0);
  return owner;
}

describe("suppliers and purchases through the service", () => {
  it("manager records purchases paid from the safe, the bank or the drawer; cashier is locked out", async () => {
    const s = setup(); const owner = await asOwner(s);
    await s.svc.treasuryDeposit("cash", 1_000_000, "رأس مال"); await s.svc.treasuryDeposit("bank", 1_000_000, "رأس مال");
    const sup = await s.svc.saveParty({ name: "شركة الأمل", isCustomer: false, isSupplier: true, phone: "010" });
    const base = { supplierId: sup, invoiceDate: t, items: [{ productId: 1, qty: 10, unitCost: 4500 }] };   // 45000
    const a = await s.svc.createPurchase({ ...base, supplierRef: "A1", paid: { amount: 45000, source: "cash" } });
    const b = await s.svc.createPurchase({ ...base, supplierRef: "B2", dueDate: t + 10 * DAY, paid: { amount: 15000, source: "bank" } });
    const c = await s.svc.createPurchase({ ...base, supplierRef: "C3", paid: { amount: 5000, source: "drawer" } });
    expect([a.remaining, b.remaining, c.remaining]).toEqual([0, 30000, 40000]);
    const snap = await s.svc.treasury();
    expect(snap).toMatchObject({ cash: 1_000_000 - 45000 - 5000, bank: 1_000_000 - 15000, payables: 70000, check: { ok: true } });
    expect((await s.svc.shiftReport())!.summary).toMatchObject({ payouts: 5000, expectedCash: -5000 });
    expect((await s.svc.listParties({ type: "supplier" }))[0]).toMatchObject({ payable: 70000, net: -70000 });
    expect(await s.svc.paySupplier(sup, 40000, "bank")).toBe(30000);
    expect((await s.svc.purchaseDetails(b.id))!.invoice).toMatchObject({ remaining: 0, status: "paid" });      // oldest first: B is cleared,
    expect((await s.svc.purchaseDetails(c.id))!.invoice).toMatchObject({ remaining: 30000, status: "partial" }); // then the rest goes to C
    await s.svc.voidPurchase(a.id);
    expect((await s.svc.treasury()).cash).toBe(1_000_000 - 5000);                                       // the cash paid for A came back
    expect((await s.svc.supplierDues())[0].balance).toBe(30000);
    await s.svc.logout();
    await s.svc.addUser("كاشير", "cashier", "1111").catch(() => {});                                      // not logged in: refused
    const o = (await s.svc.bootstrap()).users[0]; await s.svc.login(o.id, "1234"); await s.svc.addUser("كاشير", "cashier", "1111"); await s.svc.logout();
    const cashier = (await s.svc.bootstrap()).users.find((u) => u.role === "cashier")!;
    await s.svc.login(cashier.id, "1111");
    for (const call of [() => s.svc.listParties(), () => s.svc.createPurchase({ ...base, paid: undefined }), () => s.svc.supplierDues(), () => s.svc.runReport("sales_daily", { range: "today" }), () => s.svc.listPromotions()])
      await expect(call()).rejects.toThrow(/صلاحية/);
    expect(owner.id).toBeGreaterThan(0);
  });
});

describe("promotions", () => {
  it("are applied by the server at checkout, cannot be faked, and show on the receipt", async () => {
    const s = setup(); await asOwner(s);
    const cat = await s.svc.addCategory("ألبان");
    await s.svc.saveProduct({ id: 2, name: "لبن", barcode: "2", price: 3000, cost: 2000, minStock: 0, byWeight: false, categoryId: cat });
    await s.svc.savePromotion({ name: "اشترِ 2 وخد 1", type: "bxgy", target: "product", targetId: 2, value: 0, buyQty: 2, getQty: 1, startsAt: t - DAY, endsAt: t + DAY });
    await s.svc.savePromotion({ name: "خصم الألبان 10٪", type: "percent", target: "category", targetId: cat, value: 10, buyQty: 0, getQty: 0, startsAt: t - DAY, endsAt: t + DAY });
    await s.svc.savePromotion({ name: "منتهي", type: "percent", target: "product", targetId: 1, value: 50, buyQty: 0, getQty: 0, startsAt: t - 5 * DAY, endsAt: t - DAY });
    expect((await s.svc.listPromotions()).map((p) => p.state).sort()).toEqual(["ended", "running", "running"]);
    const preview = await s.svc.previewCart([{ productId: 1, qty: 2 }, { productId: 2, qty: 3 }]);
    expect(preview.lines.map((l) => l.discount)).toEqual([0, 3000]);                   // buy 2 get 1 beats 10%
    // a tampered client sending its own discounts/promo fields gets nothing extra, and manual discounts still need a manager
    const r = await s.svc.checkout({ lines: [{ productId: 1, qty: 2, promoDiscount: 999999, promoId: 1 } as any, { productId: 2, qty: 3 }], payMethod: "cash" });
    expect(r.total).toBe(10000 + 9000 - 3000);
    expect(r.receiptHtml).toContain("(عرض)");
    const item = s.db.prepare("SELECT promo_discount pd, promo_id pid FROM sale_items WHERE product_id=2").get() as any;
    expect(item.pd).toBe(3000);
    const rep = await s.svc.runReport("promotions_applied", { range: "all" });
    expect(rep.rows).toEqual([{ name: "اشترِ 2 وخد 1", qty: 3, discount: 3000 }]);
    await s.svc.setPromotionActive(1, false);
    expect((await s.svc.previewCart([{ productId: 2, qty: 3 }])).lines[0].discount).toBe(900);   // falls back to the 10% promo
  });
});

describe("import undo through the service", () => {
  it("imports a CSV and puts everything back on undo", async () => {
    const s = setup(); await asOwner(s);
    const r = await s.svc.importCsv("barcode,name,price,stock,category\n1,شاي جديد,70,5,مشروبات\n9,صنف,10,3,بقالة\n", "منتجات.csv");
    expect(r).toMatchObject({ created: 1, updated: 1 });
    expect((await s.svc.listImports())[0]).toMatchObject({ label: "منتجات.csv", undoable: true });
    expect(await s.svc.undoImport(r.batchId!)).toEqual({ removed: 1, restored: 1, skipped: 0 });
    expect((await s.svc.listProducts("", "all")).map((p) => [p.name, p.price, p.stock])).toEqual([["شاي", 5000, 10], ["لبن", 3000, 10]]);
    const p = await s.svc.importParties("الاسم,النوع,التليفون,حد الآجل\nأبو سامي,مورد,010,0\nالحاج علي,عميل,011,500\n", "عملاء.csv");
    expect(p).toMatchObject({ created: 2, errors: [] });
    expect((await s.svc.listParties({ type: "supplier" })).map((x) => x.name)).toEqual(["أبو سامي"]);
    expect(await s.svc.undoImport(p.batchId!)).toEqual({ removed: 2, restored: 0, skipped: 0 });
    expect(await s.svc.listParties()).toHaveLength(0);
  });
});

describe("reports on the demo shop", () => {
  const demo = () => {
    const db = openDb(":memory:"); const now = new Date(2026, 5, 15, 18, 0, 0).getTime(); seedDemo(db, now);
    const exported: any[] = [];
    const svc = createService({ db, fingerprint: "FP", publicKeyPem: pub, print: async () => {}, now: () => now, exportFile: async (a) => { exported.push(a); return "ok"; } });
    return { db, svc, exported, now };
  };
  it("totals reconcile with the sales table, the treasury and each other; filters narrow results", async () => {
    const { db, svc } = demo();
    const owner = (await svc.bootstrap()).users.find((u) => u.role === "owner")!;
    await svc.login(owner.id, "1234");
    const sum = (db.prepare("SELECT SUM(total) v, COUNT(*) n FROM sales").get()) as { v: number; n: number };
    const daily = await svc.runReport("sales_daily", { range: "all" });
    const returns = (db.prepare("SELECT COALESCE(SUM(total),0) v FROM returns").get() as { v: number }).v;
    expect(daily.totals).toMatchObject({ invoices: sum.n, total: sum.v, returns, net: sum.v - returns });
    expect((await svc.runReport("payment_types", { range: "all" })).totals).toMatchObject({ invoices: sum.n, total: sum.v });
    expect((await svc.runReport("sales_by_customer", { range: "all" })).totals).toMatchObject({ invoices: sum.n, total: sum.v });
    const cashiers = await svc.runReport("sales_by_cashier", { range: "all" });
    expect(cashiers.totals).toMatchObject({ invoices: sum.n, total: sum.v });
    const mona = (await svc.bootstrap()).users.find((u) => u.name === "منى")!;
    const monaOnly = await svc.runReport("sales_by_cashier", { range: "all", userId: mona.id });
    expect(monaOnly.rows).toHaveLength(1);
    expect(monaOnly.rows[0].total).toBe(cashiers.rows.find((r) => r.name === "منى")!.total);
    // line-level revenue per product, per category and the margin report all describe the same sales
    const byProduct = await svc.runReport("sales_by_product", { range: "all" });
    const byCat = await svc.runReport("sales_by_category", { range: "all" });
    expect(byCat.totals!.revenue).toBe(byProduct.totals!.revenue);
    expect(byProduct.totals!.profit).toBe((await svc.runReport("profit_margin", { range: "all" })).totals!.profit);
    expect((await svc.runReport("sales_by_product", { range: "today", categoryId: (await svc.listCategories())[0].id })).rows.length).toBeLessThanOrEqual(byProduct.rows.length);
    // inventory and money reports
    const val = await svc.runReport("stock_valuation", { range: "all" });
    expect(val.totals!.value).toBe((db.prepare("SELECT CAST(ROUND(SUM(MAX(stock,0)*cost)) AS INTEGER) v FROM products WHERE active=1").get() as any).v);
    const snap = await svc.treasury();
    const tm = await svc.runReport("treasury_movements", { range: "all" });
    expect((tm.totals!.in as number) - (tm.totals!.out as number)).toBe(snap.total);
    expect((await svc.runReport("customer_debts", {})).totals!.balance).toBe(snap.receivables);
    expect((await svc.runReport("supplier_dues", {})).totals!.balance).toBe(snap.payables);
    expect((await svc.runReport("purchase_invoices", { range: "all" })).totals!.remaining).toBe(snap.payables);
    const ex = await svc.runReport("expenses", { range: "all" });
    expect(ex.totals!.amount).toBe((db.prepare("SELECT SUM(amount) v FROM expenses WHERE voided=0").get() as any).v);
    expect((await svc.reportList()).length).toBeGreaterThanOrEqual(20);
    await expect(svc.runReport("nope", {})).rejects.toThrow(/غير موجود/);
    expect(snap.check.ok).toBe(true);
  });

  it("every report runs on real data without errors", async () => {
    const { svc } = demo();
    await svc.login((await svc.bootstrap()).users.find((u) => u.role === "owner")!.id, "1234");
    for (const r of await svc.reportList()) {
      const res = await svc.runReport(r.id, { range: "30d" });
      expect(res.columns.length, r.id).toBeGreaterThan(0);
      for (const row of res.rows.slice(0, 5)) for (const c of res.columns) expect(row, `${r.id}.${c.key}`).toHaveProperty(c.key);
    }
  });

  it("exports Excel (numbers stay numbers, RTL, totals) and printable A4 HTML", async () => {
    const { svc, exported } = demo();
    await svc.login((await svc.bootstrap()).users.find((u) => u.role === "owner")!.id, "1234");
    const filters = { range: "7d" as const };
    const report = await svc.runReport("sales_by_product", filters);
    expect(await svc.exportReport("sales_by_product", filters, "xlsx")).toBe("ok");
    await svc.exportReport("sales_by_product", filters, "pdf");
    expect(exported[1].html).toContain("dir=\"rtl\"");
    expect(exported[1].html).toContain(report.rows[0].name as string);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await exported[0].buildXlsx());
    const ws = wb.worksheets[0];
    expect(ws.views[0]).toMatchObject({ rightToLeft: true });
    const header = ws.getRow(3).values as unknown[];
    expect(header.slice(1)).toEqual(report.columns.map((c) => c.label));
    const first = ws.getRow(4);
    expect(first.getCell(1).value).toBe(report.rows[0].name);
    expect(first.getCell(4).value).toBe((report.rows[0].revenue as number) / 100);   // piastres -> pounds, numeric
    expect(typeof first.getCell(4).value).toBe("number");
    const last = ws.getRow(3 + report.rows.length + 1);
    expect(last.getCell(1).value).toBe("الإجمالي");
    expect(last.getCell(4).value).toBeCloseTo((report.totals!.revenue as number) / 100, 2);
  });
});
