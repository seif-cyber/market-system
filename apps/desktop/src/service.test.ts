import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { API_METHODS, issueLicense } from "@market/core";
import { addProduct, openDb } from "@market/db";
import { createService } from "./service";

const keys = generateKeyPairSync("ed25519");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const priv = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const DAY = 86_400_000;

let t: number;
function setup(extra: Partial<Parameters<typeof createService>[0]> = {}) {
  t = new Date(2026, 5, 15, 12, 0, 0).getTime();
  const db = openDb(":memory:");
  const opened: string[] = [];
  const svc = createService({ db, fingerprint: "FP1", publicKeyPem: pub, print: async () => {}, now: () => t, openUrl: async (u) => { opened.push(u); }, ...extra });
  addProduct(db, { name: "شاي", price: 5000, cost: 4000, stock: 50, barcodes: ["111", "00123"] });
  return { db, svc, opened };
}
const sell = (svc: ReturnType<typeof setup>["svc"], more: object = {}) =>
  svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "cash", ...more } as any);

describe("service", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  async function ownerLogin() {
    await s.svc.setupOwner("المالك", "1234");
    const { users } = await s.svc.bootstrap();
    const u = await s.svc.login(users[0].id, "1234");
    await s.svc.openShift(10000);
    return u;
  }
  async function cashierLogin() {
    const owner = await ownerLogin();
    await s.svc.addUser("كاشير", "cashier", "1111");
    await s.svc.logout();
    const c = (await s.svc.bootstrap()).users.find((u) => u.role === "cashier")!;
    await s.svc.login(c.id, "1111");
    await s.svc.openShift(5000);
    return { owner, cashier: c };
  }

  it("exposes exactly the methods the renderer is allowed to call", () => {
    for (const m of API_METHODS) expect(typeof (s.svc as any)[m], m).toBe("function");
    expect((s.svc as any).autoBackup).toBeDefined();
    expect(API_METHODS).not.toContain("autoBackup");
  });

  it("requires login and an open shift", async () => {
    await expect(s.svc.scan("111")).rejects.toThrow(/سجّل/);
    await s.svc.setupOwner("م", "1234");
    await s.svc.login((await s.svc.bootstrap()).users[0].id, "1234");
    await expect(sell(s.svc)).rejects.toThrow(/وردية/);
  });

  it("locks after repeated wrong PINs", async () => {
    await s.svc.setupOwner("م", "1234");
    const id = (await s.svc.bootstrap()).users[0].id;
    for (let i = 0; i < 5; i++) await expect(s.svc.login(id, "0000")).rejects.toThrow(/غلط/);
    await expect(s.svc.login(id, "1234")).rejects.toThrow(/محاولات/);
    t += 61_000;
    await expect(s.svc.login(id, "1234")).resolves.toBeTruthy();
  });

  it("receipt carries the saved brand and logo", async () => {
    await ownerLogin();
    await s.svc.saveSettings({ brand_name: "سوبر ماركت النور", logo: "data:image/png;base64,AAAA" });
    const r = await sell(s.svc);
    expect(r.receiptHtml).toContain("سوبر ماركت النور");
    expect(r.receiptHtml).toContain("data:image/png;base64,AAAA");
  });

  it("cashier needs a manager PIN for discounts and returns", async () => {
    const { owner } = await cashierLogin();
    await expect(sell(s.svc, { invoiceDiscount: 100 })).rejects.toThrow(/اعتماد/);
    await expect(sell(s.svc, { invoiceDiscount: 100, approval: { userId: owner.id, pin: "9999" } })).rejects.toThrow(/غلط/);
    const ok = await sell(s.svc, { invoiceDiscount: 100, approval: { userId: owner.id, pin: "1234" } });
    expect(ok.total).toBe(4900);
    await expect(s.svc.saveSettings({ brand_name: "x" })).rejects.toThrow(/صلاحية/);
    await expect(s.svc.analytics("today")).rejects.toThrow(/صلاحية/);
    const sale = await s.svc.findSale(ok.no);
    await expect(s.svc.createReturn({ saleNo: ok.no, lines: [{ saleItemId: sale!.items[0].id, qty: 1 }] })).rejects.toThrow(/اعتماد/);
    const r = await s.svc.createReturn({ saleNo: ok.no, lines: [{ saleItemId: sale!.items[0].id, qty: 1 }], approval: { userId: owner.id, pin: "1234" } });
    expect(r.total).toBe(4900);
  });

  it("blocks selling after trial ends until a valid key is activated", async () => {
    await ownerLogin();
    t += 15 * DAY;
    await expect(sell(s.svc)).rejects.toThrow(/الترخيص/);
    const wrong = issueLicense({ fp: "OTHER", customer: "c", plan: "both", iat: t, exp: t + 30 * DAY }, priv);
    await expect(s.svc.activate(wrong)).rejects.toThrow(/غير صالح/);
    const ok = issueLicense({ fp: "FP1", customer: "c", plan: "both", iat: t, exp: t + 30 * DAY }, priv);
    expect((await s.svc.activate(ok)).mode).toBe("licensed");
    await expect(sell(s.svc)).resolves.toBeTruthy();
  });

  it("clock rollback blocks selling", async () => {
    await ownerLogin();
    t += 2 * DAY;
    await s.svc.bootstrap();
    t -= 2 * DAY;
    await expect(sell(s.svc)).rejects.toThrow(/الترخيص/);
  });

  it("scale barcodes: weight and price modes", async () => {
    await ownerLogin();
    // 20 + PLU 00123 + 01500 grams + check digit
    expect(await s.svc.scan("2000123015005")).toMatchObject({ id: 1, qty: 1.5 });
    await s.svc.saveSettings({ scale_mode: "price" });
    expect(await s.svc.scan("2000123025005")).toMatchObject({ qty: 0.5 }); // 2500 piastres / 5000 per unit
    expect(await s.svc.scan("2099999015005")).toBeNull();
    expect(await s.svc.scan("111")).toMatchObject({ id: 1 });
  });

  it("credit sales respect the limit; payment clears debt", async () => {
    await ownerLogin();
    const c = await s.svc.addCustomer("أبو علي", "010", 8000);
    await expect(sell(s.svc, { payMethod: "credit" })).rejects.toThrow(/العميل/);
    await sell(s.svc, { payMethod: "credit", customerId: c });
    await expect(s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "credit", customerId: c })).rejects.toThrow(/حد الآجل/);
    expect((await s.svc.listCustomers())[0].balance).toBe(5000); // rejected sale rolled back
    expect(await s.svc.receivePayment(c, 5000, "cash")).toBe(0);
    const noLimit = await s.svc.addCustomer("بدون حد", "", 0);
    await expect(sell(s.svc, { payMethod: "credit", customerId: noLimit })).rejects.toThrow(/مش مسموح/);
  });

  it("shift close builds a report and the drawer difference", async () => {
    await ownerLogin();
    await sell(s.svc);
    const r = await s.svc.closeShift(14000);
    expect(r.summary.expectedCash).toBe(15000);
    expect(r.difference).toBe(-1000);
    expect(r.reportHtml).toContain("عجز");
    expect((await s.svc.bootstrap()).shift).toBeNull();
  });

  it("cashier hands over a shift: sees opening, sales and expected drawer; next cashier receives the counted cash", async () => {
    await cashierLogin();
    await sell(s.svc); await sell(s.svc, { payMethod: "card" });
    const rep = (await s.svc.shiftReport())!;
    expect(rep.summary).toMatchObject({ openingCash: 5000, invoices: 2, totalSales: 10000, cashSales: 5000, cardSales: 5000, expectedCash: 10000 });
    const r = await s.svc.closeShift(9800);
    expect(r.difference).toBe(-200);
    expect(await s.svc.shiftReport()).toBeNull();
    expect((await s.svc.bootstrap()).handover).toMatchObject({ counted: 9800, cashier: "كاشير" });
    // the opening amount is locked to what was handed over; changing it needs a reason and a manager's PIN
    const owner = (await s.svc.bootstrap()).users.find((u) => u.role === "owner")!;
    await expect(s.svc.openShift(9000)).rejects.toThrow(/سبب/);
    await expect(s.svc.openShift(9000, undefined, "ناقص")).rejects.toThrow(/اعتماد/);
    await expect(s.svc.openShift(9000, { userId: owner.id, pin: "0000" }, "ناقص")).rejects.toThrow(/غلط/);
    await s.svc.openShift(9000, { userId: owner.id, pin: "1234" }, "ناقص 8 جنيه");
    const adj = s.db.prepare("SELECT delta, approved_by, note FROM treasury_entries WHERE kind='handover_adjust'").get() as { delta: number; approved_by: number; note: string };
    expect(adj).toMatchObject({ delta: -800, approved_by: owner.id, note: "ناقص 8 جنيه" });
  });

  it("treasury: managers see balances and move money; cashiers cannot; every automatic entry reconciles", async () => {
    const { cashier } = await cashierLogin();
    await sell(s.svc); await sell(s.svc, { payMethod: "card" });
    await expect(s.svc.treasury()).rejects.toThrow(/صلاحية/);
    await expect(s.svc.treasuryDeposit("cash", 100, "")).rejects.toThrow(/صلاحية/);
    await s.svc.logout();
    const owner = (await s.svc.bootstrap()).users.find((u) => u.role === "owner")!;
    await s.svc.login(owner.id, "1234");
    await s.svc.treasuryDeposit("cash", 100000, "رأس مال");
    await s.svc.treasuryTransfer("cash", "bank", 30000, "إيداع");
    await s.svc.addExpense("كهرباء", 2000, "", "bank");
    expect(await s.svc.treasuryCount("cash", 80000, "جرد")).toBe(-(100000 + 5000 - 30000 - 80000));
    const snap = await s.svc.treasury();
    expect(snap).toMatchObject({ cash: 80000, bank: 5000 + 30000 - 2000, check: { ok: true } });
    expect(snap.total).toBe(snap.cash + snap.bank);
    expect(snap.net).toBe(snap.total + snap.receivables - snap.payables);
    const entries = await s.svc.treasuryEntries({ account: "bank" });
    expect(entries.map((x) => x.kind).sort()).toEqual(["expense", "sale", "transfer"]);
    expect(cashier.id).toBeGreaterThan(0);
  });

  it("expenses can come out of the drawer (counts against the shift) or the bank; owner voids with a reversal", async () => {
    await ownerLogin();
    await sell(s.svc);
    await s.svc.addExpense("نثريات", 1000, "", "cash", true);
    await s.svc.addExpense("إنترنت", 500, "", "bank", false);
    const rep = (await s.svc.shiftReport())!;
    expect(rep.summary).toMatchObject({ payouts: 1000, expectedCash: 10000 + 5000 - 1000 });
    const [net] = (await s.svc.listExpenses("today")).filter((e) => e.category === "إنترنت");
    await s.svc.deleteExpense(net.id);
    expect((await s.svc.treasury()).bank).toBe(0);
    expect((await s.svc.listExpenses("today")).some((e) => e.id === net.id)).toBe(false);
    expect((await s.svc.treasury()).check.ok).toBe(true);
  });

  it("only managers see all shifts, analytics and purchase prices", async () => {
    await cashierLogin();
    await sell(s.svc);
    await expect(s.svc.listShifts()).rejects.toThrow(/صلاحية/);
    await expect(s.svc.analytics("today")).rejects.toThrow(/صلاحية/);
    await expect(s.svc.listExpenses("today")).rejects.toThrow(/صلاحية/);
    expect((await s.svc.listProducts("", "all"))[0].cost).toBe(0);
    await s.svc.logout();
    const owner = (await s.svc.bootstrap()).users.find((u) => u.role === "owner")!;
    await s.svc.login(owner.id, "1234");
    expect((await s.svc.listProducts("", "all"))[0].cost).toBe(4000);
    const rows = await s.svc.listShifts();
    expect(rows.some((r) => r.cashier === "كاشير" && r.totalSales === 5000 && r.closedAt === null)).toBe(true);
    expect((await s.svc.analytics("today")).kpi.invoices).toBe(1);
  });

  it("holds and resumes a cart per user", async () => {
    await ownerLogin();
    await s.svc.holdCart("زبون 1", '[{"id":1}]');
    const [h] = await s.svc.listHeld();
    expect(await s.svc.resumeHeld(h.id)).toBe('[{"id":1}]');
    expect(await s.svc.listHeld()).toHaveLength(0);
  });

  it("imports CSV, reports analytics and expenses", async () => {
    await ownerLogin();
    const r = await s.svc.importCsv("barcode,name,price,stock,expiry\n222,سكر,20,5,2026-07-01\n111,شاي,55,0,\n");
    expect(r).toMatchObject({ created: 1, updated: 1 });
    await s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "card" });
    await s.svc.addExpense("كهرباء", 1000, "");
    const a = await s.svc.analytics("today");
    expect(a.kpi).toMatchObject({ sales: 5500, invoices: 1, expenses: 1000 });
    expect(a.integrity.ok).toBe(true);
    expect(a.expiring.length).toBe(1); // sugar expires within 30 days
    expect(await s.svc.listExpenses("today")).toHaveLength(1);
  });

  it("owner manages users; cannot disable self", async () => {
    const o = await ownerLogin();
    await s.svc.addUser("م2", "manager", "2222");
    const m = (await s.svc.bootstrap()).users.find((u) => u.name === "م2")!;
    await s.svc.setUserActive(m.id, false);
    expect((await s.svc.bootstrap()).users.find((u) => u.id === m.id)).toBeUndefined();
    await expect(s.svc.setUserActive(o.id, false)).rejects.toThrow(/نفسك/);
  });

  it("debt reminder opens a wa.me link for the customer's number", async () => {
    await ownerLogin();
    const c = await s.svc.addCustomer("أبو علي", "01012345678", 100000);
    await s.svc.checkout({ lines: [{ productId: 1, qty: 1 }], payMethod: "credit", customerId: c });
    await s.svc.remindCustomer(c);
    expect(s.opened[0]).toMatch(/^https:\/\/wa\.me\/201012345678\?text=/);
    expect(decodeURIComponent(s.opened[0])).toContain("50.00");
    const none = await s.svc.addCustomer("بدون رقم", "", 0);
    await expect(s.svc.remindCustomer(none)).rejects.toThrow(/تليفون/);
  });

  it("support opens wa.me for the primary contact by default, or the second engineer on request", async () => {
    await s.svc.contactSupport();
    expect(s.opened[0]).toMatch(/^https:\/\/wa\.me\/201159858866\?text=/);
    expect(decodeURIComponent(s.opened[0])).toContain("FP1");
    await s.svc.contactSupport("secondary");
    expect(s.opened[1]).toMatch(/^https:\/\/wa\.me\/201555262127\?text=/);
  });
});

describe("backups", () => {
  it("auto backup runs once per day and keeps files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-"));
    const { svc } = setup({ backupDir: dir });
    await svc.autoBackup();
    await svc.autoBackup();
    expect(readdirSync(dir)).toHaveLength(1);
    t += DAY;
    await svc.autoBackup();
    expect(readdirSync(dir)).toHaveLength(2);
  });
});
