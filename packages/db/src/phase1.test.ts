import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chainHash, GENESIS_HASH } from "@market/core";
import {
  addCustomer, addExpense, addPayment, addProduct, adjustStock, analytics, closeShift, createReturn, createSale, createUser,
  expiringBatches, getSaleForReturn, importProducts, listCustomers, listProducts, openDb, openShift, rangeFor, receiveStock,
  saveProduct, shiftSummary, statement, validateBackup, verifySalesChain,
} from "./index";

const DAY = 86_400_000;
function fixture() {
  const db = openDb(":memory:");
  const owner = createUser(db, "المالك", "owner", "1234");
  const tea = addProduct(db, { name: "شاي", price: 5000, cost: 4000, stock: 100, barcodes: ["111"] });
  const sugar = addProduct(db, { name: "سكر", price: 2000, cost: 1500, stock: 50, barcodes: ["222"] });
  const shift = openShift(db, owner, 10000);
  return { db, owner, tea, sugar, shift };
}

describe("migration 002 on a database that already has sales", () => {
  it("keeps old sales, hash chain and immutability", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkt-"));
    const file = join(dir, "old.db");
    const old = new Database(file);
    old.exec(readFileSync(new URL("../migrations/001_init.sql", import.meta.url), "utf8"));
    old.pragma("user_version = 1");
    old.prepare("INSERT INTO users(name,role,pin_hash,pin_salt) VALUES('m','owner','x','y')").run();
    old.prepare("INSERT INTO products(name,price) VALUES('p',1000)").run();
    const payload = { no: 1, userId: 1, subtotal: 1000, discount: 0, tax: 0, total: 1000, lines: [[1, 1000, 1, 0]], createdAt: 5 };
    const hash = chainHash(GENESIS_HASH, payload);
    old.prepare("INSERT INTO sales(no,user_id,subtotal,discount,tax,total,pay_method,created_at,prev_hash,hash) VALUES(1,1,1000,0,0,1000,'cash',5,?,?)").run(GENESIS_HASH, hash);
    old.prepare("INSERT INTO sale_items(sale_id,product_id,name,unit_price,qty,discount) VALUES(1,1,'p',1000,1,0)").run();
    old.close();

    const db = openDb(file); // runs 002
    expect((db.prepare("SELECT paid FROM sales WHERE no=1").get() as any).paid).toBe(1000);
    expect(verifySalesChain(db)).toEqual({ ok: true, checked: 1, brokenAt: null });
    expect(() => db.prepare("DELETE FROM sales").run()).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM sale_items").run()).toThrow(/immutable/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.prepare("INSERT INTO shifts(user_id,opened_at,opening_cash) VALUES(1,1,0)").run();
    createSale(db, { userId: 1, lines: [{ productId: 1, qty: 1 }], payMethod: "credit", customerId: addCustomer(db, { name: "ع", creditLimit: 5000 }), shiftId: 1 });
    expect(verifySalesChain(db).ok).toBe(true);
  });
});

describe("shifts", () => {
  it("computes expected cash and the difference", () => {
    const { db, owner, tea, shift } = fixture();
    createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 2 }], payMethod: "cash" }); // 10000 cash
    createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 1 }], payMethod: "card" }); // 5000 card
    const s = shiftSummary(db, shift);
    expect(s).toMatchObject({ openingCash: 10000, cashSales: 10000, cardSales: 5000, expectedCash: 20000, invoices: 2 });
    const r = closeShift(db, shift, 19000);
    expect(r.difference).toBe(-1000);
    expect(() => closeShift(db, shift, 1)).toThrow(/مقفولة/);
    expect(() => openShift(db, owner, 0)).not.toThrow(); // can open a new one after closing
    expect(() => openShift(db, owner, 0)).toThrow(/مفتوحة/);
  });
});

describe("credit sales and customer ledger", () => {
  it("tracks debt, partial payment and refuses overpayment", () => {
    const { db, owner, tea, shift } = fixture();
    const c = addCustomer(db, { name: "أبو علي", creditLimit: 100000 });
    const sale = createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 2 }], payMethod: "credit", customerId: c, paidNow: 3000 });
    expect(sale.paid).toBe(3000);
    expect(listCustomers(db)[0].balance).toBe(7000);
    expect(addPayment(db, { customerId: c, amount: 2000, method: "cash", shiftId: shift, userId: owner })).toBe(5000);
    expect(() => addPayment(db, { customerId: c, amount: 9999, method: "cash", userId: owner })).toThrow(/أكبر/);
    expect(statement(db, c).map((e) => e.balanceAfter)).toEqual([7000, 5000]);
    // drawer: opening 10000 + 3000 paid at counter + 2000 collected
    expect(shiftSummary(db, shift).expectedCash).toBe(15000);
    expect(() => createSale(db, { userId: owner, lines: [{ productId: tea, qty: 1 }], payMethod: "credit" })).toThrow(/العميل/);
  });
});

describe("returns", () => {
  it("refunds proportionally, restores stock, blocks over-return", () => {
    const { db, owner, tea, shift } = fixture();
    const sale = createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 4 }], payMethod: "cash", taxRate: 0.1 }); // 20000 + 2000
    expect(sale.total).toBe(22000);
    const info = getSaleForReturn(db, sale.no)!;
    const r = createReturn(db, { saleNo: sale.no, userId: owner, shiftId: shift, lines: [{ saleItemId: info.items[0].id, qty: 1 }] });
    expect(r.total).toBe(5500);
    expect((db.prepare("SELECT stock FROM products WHERE id=?").get(tea) as any).stock).toBe(97);
    expect(shiftSummary(db, shift).cashReturns).toBe(5500);
    expect(() => createReturn(db, { saleNo: sale.no, userId: owner, lines: [{ saleItemId: info.items[0].id, qty: 4 }] })).toThrow(/أكبر/);
    createReturn(db, { saleNo: sale.no, userId: owner, lines: [{ saleItemId: info.items[0].id, qty: 3 }] });
    const total = (db.prepare("SELECT SUM(total) v FROM returns").get() as any).v;
    expect(total).toBeLessThanOrEqual(22000);
    expect(() => db.prepare("DELETE FROM returns").run()).toThrow(/immutable/);
  });
  it("credit sale refund reduces the customer's debt", () => {
    const { db, owner, tea, shift } = fixture();
    const c = addCustomer(db, { name: "س", creditLimit: 99999 });
    const sale = createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 2 }], payMethod: "credit", customerId: c });
    const info = getSaleForReturn(db, sale.no)!;
    const r = createReturn(db, { saleNo: sale.no, userId: owner, lines: [{ saleItemId: info.items[0].id, qty: 1 }] });
    expect(r.method).toBe("credit");
    expect(listCustomers(db)[0].balance).toBe(5000);
  });
});

describe("inventory, FEFO batches and expiry alerts", () => {
  it("sells from the soonest-expiring batch first", () => {
    const { db, owner, tea } = fixture();
    const now = Date.now();
    receiveStock(db, { productId: tea, qty: 5, expiry: now + 90 * DAY });
    receiveStock(db, { productId: tea, qty: 5, expiry: now + 10 * DAY });
    createSale(db, { userId: owner, lines: [{ productId: tea, qty: 6 }], payMethod: "cash" });
    const left = db.prepare("SELECT qty, expiry FROM batches ORDER BY expiry").all() as any[];
    expect(left[0].qty).toBe(0);
    expect(left[1].qty).toBe(4);
    expect(expiringBatches(db, 30, now)).toHaveLength(0); // the 10-day batch was used up
    receiveStock(db, { productId: tea, qty: 3, expiry: now - DAY });
    expect(expiringBatches(db, 30, now)[0]).toMatchObject({ qty: 3, daysLeft: -1 });
  });
  it("saves products, rejects duplicate barcode, adjusts stock", () => {
    const { db, tea } = fixture();
    expect(() => saveProduct(db, { name: "x", barcode: "111", price: 100, cost: 0, minStock: 0, byWeight: false })).toThrow(/مستخدم/);
    saveProduct(db, { id: tea, name: "شاي جديد", barcode: "111", price: 6000, cost: 4500, minStock: 120, byWeight: false });
    expect(listProducts(db, "", "low").map((p) => p.name)).toEqual(["شاي جديد"]);
    expect(adjustStock(db, tea, 90)).toBe(-10);
  });
  it("imports CSV rows with expiry and min stock", () => {
    const { db } = fixture();
    const exp = Date.now() + 20 * DAY;
    importProducts(db, [{ barcode: "999", name: "لبن", price: 3000, cost: 2500, stock: 12, minStock: 5, expiry: exp }]);
    expect((db.prepare("SELECT qty FROM batches").get() as any).qty).toBe(12);
  });
});

describe("analytics", () => {
  it("computes profit, net of returns and expenses; detects tampering", () => {
    const { db, owner, tea, sugar, shift } = fixture();
    const now = Date.now();
    createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 2 }, { productId: sugar, qty: 1 }], payMethod: "cash" }); // 12000, cost 9500
    const s2 = createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 1 }], payMethod: "card" }); // 5000, cost 4000
    const item = getSaleForReturn(db, s2.no)!.items[0];
    createReturn(db, { saleNo: s2.no, userId: owner, shiftId: shift, lines: [{ saleItemId: item.id, qty: 1 }] }); // refund 5000
    addExpense(db, { category: "كهرباء", amount: 1000, userId: owner });
    const a = analytics(db, rangeFor("today", now + 1000), now + 1000);
    expect(a.kpi).toMatchObject({ sales: 17000, invoices: 2, returns: 5000, netSales: 12000, expenses: 1000 });
    expect(a.kpi.grossProfit).toBe(2500); // (17000-5000) - (13500-4000)
    expect(a.kpi.netProfit).toBe(1500);
    expect(a.topProducts[0].name).toBe("شاي");
    expect(a.integrity.ok).toBe(true);
    expect(a.daily.at(-1)!.sales).toBe(12000);
    // tamper directly, bypassing triggers
    db.exec("DROP TRIGGER sales_no_update");
    db.prepare("UPDATE sales SET total=1 WHERE no=1").run();
    expect(analytics(db, rangeFor("today", now + 1000), now + 1000).integrity).toMatchObject({ ok: false, brokenAt: 1 });
  });
});

describe("backup validation", () => {
  it("accepts a real db and rejects junk", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkt-"));
    const file = join(dir, "a.db");
    openDb(file).close();
    expect(validateBackup(file)).toEqual({ ok: true });
    expect(validateBackup(join(dir, "missing.db")).ok).toBe(false);
    new Database(join(dir, "other.db")).exec("CREATE TABLE t(x)");
    expect(validateBackup(join(dir, "other.db")).ok).toBe(false);
  });
});
