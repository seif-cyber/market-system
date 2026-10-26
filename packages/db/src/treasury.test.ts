import Database from "better-sqlite3";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addCustomer, addExpense, addPayment, addProduct, balances, closeShift, countAdjust, createReturn, createSale, createUser, deposit,
  getSaleForReturn, listEntries, openDb, openShift, shiftSummary, transfer, verifyTreasury, voidExpense, withdraw,
} from "./index";

function shop() {
  const db = openDb(":memory:");
  const owner = createUser(db, "المالك", "owner", "1234");
  const cashier = createUser(db, "كاشير", "cashier", "1111");
  const tea = addProduct(db, { name: "شاي", price: 5000, cost: 4000, stock: 100, barcodes: ["1"] });
  const cust = addCustomer(db, { name: "عميل", creditLimit: 1_000_000 });
  return { db, owner, cashier, tea, cust };
}
const sell = (s: ReturnType<typeof shop>, shift: number, payMethod: "cash" | "card" | "credit", extra: object = {}, qty = 1) =>
  createSale(s.db, { userId: s.cashier, shiftId: shift, lines: [{ productId: s.tea, qty }], payMethod, ...extra });

describe("treasury: every event posts the right entry", () => {
  it("sales: cash and credit-paid go to cash (in drawer), card to bank, unpaid credit to neither", () => {
    const s = shop(); const sh = openShift(s.db, s.cashier, 10000);
    sell(s, sh, "cash", {}, 2);                                                       // +10000 cash
    sell(s, sh, "card");                                                              // +5000 bank
    sell(s, sh, "credit", { customerId: s.cust, paidNow: 3000 });                     // +3000 cash, 2000 stays on credit
    expect(balances(s.db)).toEqual({ cash: 13000, bank: 5000, total: 18000 });
    expect(shiftSummary(s.db, sh).expectedCash).toBe(10000 + 13000);
    expect(verifyTreasury(s.db).ok).toBe(true);
  });

  it("returns: cash refund leaves the drawer, card refund leaves the bank, credit refund moves nothing", () => {
    const s = shop(); const sh = openShift(s.db, s.cashier, 0);
    const a = sell(s, sh, "cash", {}, 2), b = sell(s, sh, "card"), c = sell(s, sh, "credit", { customerId: s.cust });
    const ret = (no: number, qty: number) => createReturn(s.db, { saleNo: no, userId: s.cashier, shiftId: sh, lines: [{ saleItemId: getSaleForReturn(s.db, no)!.items[0].id, qty }] });
    ret(a.no, 1); ret(b.no, 1); ret(c.no, 1);
    expect(balances(s.db)).toEqual({ cash: 10000 - 5000, bank: 0, total: 5000 });
    expect(shiftSummary(s.db, sh).expectedCash).toBe(5000);
    expect(verifyTreasury(s.db).ok).toBe(true);
  });

  it("customer payments: cash into drawer, card into bank", () => {
    const s = shop(); const sh = openShift(s.db, s.cashier, 0);
    sell(s, sh, "credit", { customerId: s.cust }, 2);
    addPayment(s.db, { customerId: s.cust, amount: 4000, method: "cash", shiftId: sh, userId: s.cashier });
    addPayment(s.db, { customerId: s.cust, amount: 6000, method: "card", userId: s.cashier });
    expect(balances(s.db)).toEqual({ cash: 4000, bank: 6000, total: 10000 });
    expect(shiftSummary(s.db, sh).expectedCash).toBe(4000);
  });

  it("expenses: from safe, from bank, from the drawer (hits expected cash), and void reverses", () => {
    const s = shop(); const sh = openShift(s.db, s.cashier, 0);
    sell(s, sh, "cash", {}, 4);                                                       // +20000
    const e1 = addExpense(s.db, { category: "كهرباء", amount: 3000, userId: s.owner, paidFrom: "bank" });
    addExpense(s.db, { category: "نثريات", amount: 1000, userId: s.cashier, paidFrom: "cash", fromDrawer: true, shiftId: sh });
    addExpense(s.db, { category: "إيجار", amount: 5000, userId: s.owner, paidFrom: "cash" });
    expect(balances(s.db)).toEqual({ cash: 20000 - 1000 - 5000, bank: -3000, total: 11000 });
    const sum = shiftSummary(s.db, sh);
    expect(sum.payouts).toBe(1000);
    expect(sum.expectedCash).toBe(19000);                                             // only the drawer expense, not the safe one
    expect(() => addExpense(s.db, { category: "x", amount: 1, userId: s.owner, paidFrom: "bank", fromDrawer: true, shiftId: sh })).toThrow(/الدرج/);
    voidExpense(s.db, e1, s.owner);
    expect(balances(s.db).bank).toBe(0);
    expect(() => voidExpense(s.db, e1, s.owner)).toThrow(/ملغي/);
    expect(verifyTreasury(s.db).ok).toBe(true);
  });

  it("manual: deposit, withdraw, transfer nets to zero, count posts the difference", () => {
    const s = shop();
    deposit(s.db, { account: "cash", amount: 100000, userId: s.owner, note: "رأس مال" });
    withdraw(s.db, { account: "cash", amount: 15000, userId: s.owner });
    transfer(s.db, { from: "cash", to: "bank", amount: 40000, userId: s.owner });
    expect(balances(s.db)).toEqual({ cash: 45000, bank: 40000, total: 85000 });
    expect(() => transfer(s.db, { from: "cash", to: "cash", amount: 1, userId: s.owner })).toThrow();
    expect(() => deposit(s.db, { account: "cash", amount: 0, userId: s.owner })).toThrow();
    expect(countAdjust(s.db, { account: "cash", counted: 44000, userId: s.owner })).toBe(-1000);
    expect(balances(s.db).cash).toBe(44000);
    expect(countAdjust(s.db, { account: "cash", counted: 44000, userId: s.owner })).toBe(0); // nothing to fix, nothing posted
    expect(verifyTreasury(s.db).ok).toBe(true);
  });
});

describe("treasury: shifts and handover", () => {
  it("closing books the shortage on the treasury; next opening is locked to the counted cash", () => {
    const s = shop();
    const sh = openShift(s.db, s.cashier, 10000);
    sell(s, sh, "cash", {}, 2);                                                       // expected 20000
    const r = closeShift(s.db, sh, 19500);
    expect(r.difference).toBe(-500);
    expect(balances(s.db).cash).toBe(10000 - 500);                                    // sales 10000 + diff, float is already inside
    expect(() => openShift(s.db, s.owner, 20000)).toThrow(/اتسلّم/);
    expect(() => openShift(s.db, s.owner, 19000)).toThrow(/اتسلّم/);
    const sh2 = openShift(s.db, s.owner, 19500);
    expect(shiftSummary(s.db, sh2).expectedCash).toBe(19500);
    expect(verifyTreasury(s.db).ok).toBe(true);
  });

  it("a different opening needs a manager approval and is booked as a handover adjustment", () => {
    const s = shop();
    const sh = openShift(s.db, s.cashier, 5000); closeShift(s.db, sh, 5000);
    const before = balances(s.db).cash;
    const sh2 = openShift(s.db, s.owner, 4000, Date.now(), { approvedBy: s.owner, reason: "ناقص 10 جنيه" });
    expect(balances(s.db).cash).toBe(before - 1000);
    const e = listEntries(s.db, { kind: "handover_adjust" })[0];
    expect(e).toMatchObject({ delta: -1000, note: "ناقص 10 جنيه", approvedByName: "المالك" });
    expect(shiftSummary(s.db, sh2).expectedCash).toBe(4000);
  });
});

describe("treasury: verification catches tampering and is immutable", () => {
  it("ledger rows cannot be edited or deleted", () => {
    const s = shop(); deposit(s.db, { account: "cash", amount: 100, userId: s.owner });
    expect(() => s.db.prepare("UPDATE treasury_entries SET delta=999").run()).toThrow(/immutable/);
    expect(() => s.db.prepare("DELETE FROM treasury_entries").run()).toThrow(/immutable/);
  });
  it("detects a sale whose money entry was removed, and an expense changed behind the app's back", () => {
    const s = shop(); const sh = openShift(s.db, s.cashier, 0);
    sell(s, sh, "cash"); const e = addExpense(s.db, { category: "x", amount: 700, userId: s.owner });
    expect(verifyTreasury(s.db).ok).toBe(true);
    s.db.prepare("UPDATE expenses SET amount=100 WHERE id=?").run(e);               // source row edited, ledger not
    const v = verifyTreasury(s.db);
    expect(v.ok).toBe(false);
    expect(v.mismatches[0]).toMatchObject({ kind: "expense", account: "cash", expected: -100, actual: -700 });
    s.db.exec("DROP TRIGGER treasury_no_delete"); s.db.prepare("DELETE FROM treasury_entries WHERE kind='sale'").run();
    expect(verifyTreasury(s.db).mismatches.some((m) => m.kind === "sale")).toBe(true);
  });
});

describe("migration 003 backfills history", () => {
  it("a database with sales, returns, payments, expenses and shift differences gets consistent balances", () => {
    const dir = mkdtempSync(join(tmpdir(), "mkt-"));
    const file = join(dir, "v2.db");
    const old = new Database(file);
    for (const f of ["001_init.sql", "002_phase1.sql"]) old.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8").replace("-- migrate:no-fk", ""));
    old.pragma("user_version = 2");
    old.exec(`
      INSERT INTO users(id,name,role,pin_hash,pin_salt) VALUES (1,'م','owner','x','y');
      INSERT INTO products(id,name,price,cost,stock) VALUES (1,'p',5000,4000,100);
      INSERT INTO customers(id,name,credit_limit,created_at) VALUES (1,'c',100000,1);
      INSERT INTO shifts(id,user_id,opened_at,closed_at,opening_cash,counted_cash,expected_cash) VALUES (1,1,1,9,1000,12900,13000);
      INSERT INTO sales(id,no,user_id,subtotal,discount,tax,total,pay_method,created_at,prev_hash,hash,shift_id,paid) VALUES
        (1,1,1,10000,0,0,10000,'cash',2,'0','a',1,10000), (2,2,1,5000,0,0,5000,'card',3,'a','b',1,5000), (3,3,1,5000,0,0,5000,'credit',4,'b','c',1,2000);
      INSERT INTO returns(id,sale_id,user_id,shift_id,total,tax,refund_method,created_at) VALUES (1,1,1,1,5000,0,'cash',5), (2,2,1,1,2500,0,'card',6), (3,3,1,1,1000,0,'credit',7);
      INSERT INTO customer_ledger(customer_id,delta,kind,method,shift_id,user_id,created_at) VALUES (1,3000,'sale',NULL,1,1,4), (1,-1500,'payment','cash',1,1,8), (1,-500,'payment','card',1,1,9);
      INSERT INTO expenses(category,amount,user_id,created_at) VALUES ('إيجار',4000,1,10);
    `);
    old.close();
    const db = openDb(file);
    // cash: 10000 + 2000 (paid part of credit) - 5000 refund + 1500 payment - 4000 expense - 100 shift diff
    expect(balances(db)).toEqual({ cash: 10000 + 2000 - 5000 + 1500 - 4000 - 100, bank: 5000 - 2500 + 500, total: 4400 + 3000 });
    expect(verifyTreasury(db).ok).toBe(true);
    expect(shiftSummary(db, 1).expectedCash).toBe(1000 + 10000 + 2000 - 5000 + 1500); // same as the old formula (expenses weren't drawer-linked)
  });
});
