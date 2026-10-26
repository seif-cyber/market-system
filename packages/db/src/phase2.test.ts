import { describe, expect, it } from "vitest";
import { applyPromotions, type Promo } from "@market/core";
import {
  addCategory, addPayment, addProduct, importParties, addSupplierOpening, analytics, balances, createPurchase, createSale, createUser, daysFrom, deleteCategory,
  ensureCategory, getParty, importProducts, listActivePromotions, listParties, listProducts, listPurchases, openDb, openShift, paySupplier, rangeFor,
  renameCategory, saveParty, savePromotion, saveProduct, seedDefaultCategories, setPartyActive, setPromotionActive, shiftSummary, supplierBalance,
  supplierDues, supplierStatement, totalPayables, verifyTreasury, voidPurchase, deposit,
} from "./index";

const DAY = 86_400_000;
function shop() {
  const db = openDb(":memory:");
  const owner = createUser(db, "المالك", "owner", "1234");
  const tea = addProduct(db, { name: "شاي", price: 5000, cost: 4000, stock: 10, barcodes: ["1"] });
  const sugar = addProduct(db, { name: "سكر", price: 2000, cost: 1500, stock: 0, barcodes: ["2"] });
  const sup = saveParty(db, { name: "شركة النور", phone: "0100", isCustomer: false, isSupplier: true });
  const shift = openShift(db, owner, 0);
  deposit(db, { account: "cash", amount: 1_000_000, userId: owner });
  deposit(db, { account: "bank", amount: 1_000_000, userId: owner });
  return { db, owner, tea, sugar, sup, shift };
}

describe("parties: one record for customers and suppliers", () => {
  it("can be a customer, a supplier, or both, with a net balance", () => {
    const { db, owner, tea, shift } = shop();
    const both = saveParty(db, { name: "الحاج محمود", isCustomer: true, isSupplier: true, creditLimit: 100000, taxNo: "123", address: "القاهرة" });
    createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 2 }], payMethod: "credit", customerId: both });   // he owes us 10000
    createPurchase(db, { supplierId: both, invoiceDate: Date.now(), items: [{ productId: tea, qty: 1, unitCost: 3000 }], userId: owner }); // we owe him 3000
    const p = getParty(db, both)!;
    expect(p).toMatchObject({ receivable: 10000, payable: 3000, net: 7000, isCustomer: true, isSupplier: true, taxNo: "123" });
    expect(listParties(db, { type: "supplier" }).map((x) => x.name)).toEqual(expect.arrayContaining(["الحاج محمود", "شركة النور"]));
    expect(listParties(db, { type: "customer" }).map((x) => x.name)).toEqual(["الحاج محمود"]);
    expect(() => saveParty(db, { id: both, name: "x", isCustomer: false, isSupplier: true })).toThrow(/مديونية/);
    expect(() => setPartyActive(db, both, false)).toThrow(/رصيد/);
    expect(() => saveParty(db, { name: "y", isCustomer: false, isSupplier: false })).toThrow(/عميل أو مورد/);
  });
});

describe("purchases and supplier payments", () => {
  it("cash purchase: stock up, average cost, treasury down, nothing owed", () => {
    const { db, owner, tea, sup, shift } = shop();
    const r = createPurchase(db, { supplierId: sup, invoiceDate: Date.now(), items: [{ productId: tea, qty: 10, unitCost: 5000 }], paid: { amount: 50000, account: "cash" }, userId: owner });
    expect(r).toMatchObject({ total: 50000, paid: 50000, remaining: 0 });
    expect(db.prepare("SELECT stock, cost FROM products WHERE id=?").get(tea)).toEqual({ stock: 20, cost: 4500 });   // (10*4000 + 10*5000)/20
    expect(balances(db).cash).toBe(1_000_000 - 50000);
    expect(supplierBalance(db, sup)).toBe(0);
    expect(listPurchases(db)[0].status).toBe("paid");
    expect(shift).toBeGreaterThan(0);
    expect(verifyTreasury(db).ok).toBe(true);
  });

  it("credit purchase, then partial payments settle the oldest invoice first", () => {
    const { db, owner, tea, sugar, sup } = shop();
    const now = Date.now();
    const a = createPurchase(db, { supplierId: sup, supplierRef: "A-1", invoiceDate: now - 20 * DAY, dueDate: now - 5 * DAY, items: [{ productId: tea, qty: 10, unitCost: 4000 }], userId: owner });   // 40000 overdue
    const b = createPurchase(db, { supplierId: sup, supplierRef: "B-2", invoiceDate: now - 2 * DAY, dueDate: daysFrom(10, now), items: [{ productId: sugar, qty: 20, unitCost: 1500 }], paid: { amount: 10000, account: "bank" }, userId: owner }); // 30000, paid 10000
    expect(a.remaining).toBe(40000); expect(b.remaining).toBe(20000);
    expect(supplierBalance(db, sup)).toBe(60000);
    expect(totalPayables(db)).toBe(60000);
    expect(supplierDues(db, now)[0]).toMatchObject({ balance: 60000, overdue: 40000 });
    expect(() => paySupplier(db, { supplierId: sup, amount: 70000, account: "cash", userId: owner })).toThrow(/أكبر/);
    paySupplier(db, { supplierId: sup, amount: 45000, account: "cash", userId: owner });      // 40000 to A, 5000 to B
    const rows = Object.fromEntries(listPurchases(db, {}, now).map((p) => [p.supplierRef, p]));
    expect(rows["A-1"]).toMatchObject({ remaining: 0, status: "paid" });
    expect(rows["B-2"]).toMatchObject({ remaining: 15000, status: "partial" });
    expect(supplierBalance(db, sup)).toBe(15000);
    expect(supplierDues(db, now)[0].overdue).toBe(0);
    expect(balances(db)).toEqual({ cash: 1_000_000 - 45000, bank: 1_000_000 - 10000, total: 2_000_000 - 55000 });
    expect(supplierStatement(db, sup).at(-1)!.balanceAfter).toBe(15000);
    expect(verifyTreasury(db).ok).toBe(true);
  });

  it("paying from the drawer counts against the shift's expected cash", () => {
    const { db, owner, tea, sup, shift } = shop();
    createPurchase(db, { supplierId: sup, invoiceDate: Date.now(), items: [{ productId: tea, qty: 1, unitCost: 4000 }], userId: owner });
    paySupplier(db, { supplierId: sup, amount: 1500, account: "cash", inDrawer: true, shiftId: shift, userId: owner });
    expect(shiftSummary(db, shift)).toMatchObject({ payouts: 1500, expectedCash: -1500 });
    expect(() => paySupplier(db, { supplierId: sup, amount: 100, account: "bank", inDrawer: true, shiftId: shift, userId: owner })).toThrow(/الدرج/);
  });

  it("voiding an invoice reverses stock, supplier balance and the money paid", () => {
    const { db, owner, tea, sup } = shop();
    const r = createPurchase(db, { supplierId: sup, invoiceDate: Date.now(), items: [{ productId: tea, qty: 10, unitCost: 5000, expiry: Date.now() + 30 * DAY }], paid: { amount: 20000, account: "cash" }, userId: owner });
    expect(balances(db).cash).toBe(1_000_000 - 20000);
    voidPurchase(db, r.id, owner);
    expect((db.prepare("SELECT stock FROM products WHERE id=?").get(tea) as any).stock).toBe(10);
    expect(supplierBalance(db, sup)).toBe(0);
    expect(balances(db).cash).toBe(1_000_000);
    expect((db.prepare("SELECT SUM(qty) q FROM batches").get() as any).q).toBe(0);
    expect(() => voidPurchase(db, r.id, owner)).toThrow(/ملغية/);
    expect(listPurchases(db)[0].status).toBe("voided");
    expect(verifyTreasury(db).ok).toBe(true);
  });

  it("validates input and supports an opening balance", () => {
    const { db, owner, tea, sup } = shop();
    const base = { supplierId: sup, invoiceDate: Date.now(), userId: owner };
    expect(() => createPurchase(db, { ...base, items: [] })).toThrow(/أصناف/);
    expect(() => createPurchase(db, { ...base, items: [{ productId: tea, qty: 1, unitCost: 100 }], paid: { amount: 500, account: "cash" } })).toThrow(/أكبر/);
    expect(() => createPurchase(db, { ...base, supplierId: 999, items: [{ productId: tea, qty: 1, unitCost: 100 }] })).toThrow(/المورد/);
    addSupplierOpening(db, sup, 25000, owner);
    paySupplier(db, { supplierId: sup, amount: 25000, account: "cash", userId: owner });   // no invoice behind it -> unallocated payment
    expect(supplierBalance(db, sup)).toBe(0);
    expect(verifyTreasury(db).ok).toBe(true);
  });
});

describe("categories", () => {
  it("manages categories and assigns them to products, CSV import creates them", () => {
    const { db, tea } = shop();
    expect(seedDefaultCategories(db)).toBe(8);
    expect(seedDefaultCategories(db)).toBe(0);
    const drinks = ensureCategory(db, "مشروبات");
    saveProduct(db, { id: tea, name: "شاي", barcode: "1", price: 5000, cost: 4000, minStock: 0, byWeight: false, categoryId: drinks });
    expect(listProducts(db, "", "all", 300, drinks).map((p) => p.name)).toEqual(["شاي"]);
    expect(listProducts(db, "", "all", 300, addCategory(db, "فاضي"))).toHaveLength(0);
    expect(() => deleteCategory(db, drinks)).toThrow(/صنف/);
    expect(() => renameCategory(db, drinks, "شيبسي وسناكس")).toThrow(/نفس الاسم/);
    importProducts(db, [{ barcode: "777", name: "جبنة", price: 9000, cost: 7000, stock: 5, category: "أجبان جديدة" }]);
    expect(listProducts(db, "جبنة")[0].category).toBe("أجبان جديدة");
  });
  it("analytics splits sales by category", () => {
    const { db, owner, tea, sugar, shift } = shop();
    saveProduct(db, { id: tea, name: "شاي", barcode: "1", price: 5000, cost: 4000, minStock: 0, byWeight: false, categoryId: ensureCategory(db, "مشروبات") });
    createSale(db, { userId: owner, shiftId: shift, lines: [{ productId: tea, qty: 2 }, { productId: sugar, qty: 1 }], payMethod: "cash" });
    const a = analytics(db, rangeFor("today", Date.now() + 1000), Date.now() + 1000);
    expect(a.categories).toEqual([{ name: "مشروبات", qty: 2, revenue: 10000, profit: 2000 }, { name: "بدون قسم", qty: 1, revenue: 2000, profit: 500 }]);
    expect(a.position.payables).toBe(0);
  });
});

describe("promotions engine", () => {
  const now = 1_000_000;
  const mk = (o: Partial<Promo>): Promo => ({ id: 1, name: "عرض", type: "percent", target: "product", targetId: 1, value: 10, buyQty: 0, getQty: 0, startsAt: now - 10, endsAt: now + 10, active: true, ...o });
  const line = (o = {}) => ({ productId: 1, categoryId: 5, unitPrice: 1000, qty: 3, ...o });
  it("percent, amount per unit, buy X get Y", () => {
    expect(applyPromotions([line()], [mk({})], now)[0]).toMatchObject({ discount: 300, promoId: 1 });
    expect(applyPromotions([line()], [mk({ type: "amount", value: 150 })], now)[0].discount).toBe(450);
    expect(applyPromotions([line({ qty: 5 })], [mk({ type: "bxgy", buyQty: 2, getQty: 1 })], now)[0].discount).toBe(1000); // 5 = one group of 3 + 2 -> 1 free
    expect(applyPromotions([line({ qty: 6 })], [mk({ type: "bxgy", buyQty: 2, getQty: 1 })], now)[0].discount).toBe(2000);
  });
  it("targets products or categories, honours dates, never stacks, never exceeds the line", () => {
    expect(applyPromotions([line()], [mk({ target: "category", targetId: 5 })], now)[0].discount).toBe(300);
    expect(applyPromotions([line()], [mk({ target: "category", targetId: 9 })], now)[0].discount).toBe(0);
    expect(applyPromotions([line()], [mk({ endsAt: now - 1 })], now)[0].discount).toBe(0);
    expect(applyPromotions([line()], [mk({ startsAt: now + 1 })], now)[0].discount).toBe(0);
    expect(applyPromotions([line()], [mk({ active: false })], now)[0].discount).toBe(0);
    const best = applyPromotions([line()], [mk({ id: 1, value: 10 }), mk({ id: 2, name: "أفضل", value: 25 })], now)[0];
    expect(best).toMatchObject({ discount: 750, promoId: 2, name: "أفضل" });
    expect(applyPromotions([line()], [mk({ type: "amount", value: 99999 })], now)[0].discount).toBe(3000);
  });
  it("is stored with validation and listed only while running", () => {
    const { db, owner, tea } = shop();
    const base = { name: "خصم الشاي", type: "percent" as const, target: "product" as const, targetId: tea, value: 20, buyQty: 0, getQty: 0, startsAt: Date.now() - DAY, endsAt: Date.now() + DAY };
    const id = savePromotion(db, base, owner);
    expect(listActivePromotions(db)).toHaveLength(1);
    setPromotionActive(db, id, false);
    expect(listActivePromotions(db)).toHaveLength(0);
    expect(() => savePromotion(db, { ...base, value: 150 }, owner)).toThrow(/النسبة/);
    expect(() => savePromotion(db, { ...base, targetId: 999 }, owner)).toThrow(/الصنف/);
    expect(() => savePromotion(db, { ...base, endsAt: base.startsAt - 1 }, owner)).toThrow(/النهاية/);
  });
});
void addPayment;

import { beginImport, listImports, undoImport } from "./index";
describe("undoing an import", () => {
  const exp = Date.now() + 30 * DAY;
  function setup() {
    const s = shop();
    const cat = ensureCategory(s.db, "قديم");
    saveProduct(s.db, { id: s.tea, name: "شاي", barcode: "1", price: 5000, cost: 4000, minStock: 3, byWeight: false, categoryId: cat });
    return { ...s, cat };
  }
  const doImport = (s: ReturnType<typeof setup>, label = "ملف.csv") => {
    const batch = beginImport(s.db, "products", label, s.owner);
    importProducts(s.db, [
      { barcode: "1", name: "شاي جديد الاسم", price: 6500, cost: 5000, stock: 25, minStock: 9, expiry: exp, category: "جديد" },   // existing product
      { barcode: "900", name: "صنف جديد", price: 1000, cost: 700, stock: 40, expiry: exp },                                   // new product
    ], Date.now(), batch);
    return batch;
  };
  const prod = (db: ReturnType<typeof setup>["db"], id: number) => db.prepare("SELECT name, price, cost, stock, min_stock minStock, category_id cat FROM products WHERE id=?").get(id) as any;

  it("restores updated products (fields + stock), removes new ones with their stock history and batches", () => {
    const s = setup();
    const before = prod(s.db, s.tea);
    const batch = doImport(s);
    expect(prod(s.db, s.tea)).toMatchObject({ name: "شاي جديد الاسم", price: 6500, stock: 10 + 25 });
    expect(listImports(s.db)[0]).toMatchObject({ id: batch, kind: "products", created: 1, updated: 1, undone: false, undoable: true });
    expect(undoImport(s.db, batch)).toEqual({ removed: 1, restored: 1, skipped: 0 });
    expect(prod(s.db, s.tea)).toEqual(before);
    expect(s.db.prepare("SELECT COUNT(*) n FROM products WHERE name='صنف جديد'").get()).toEqual({ n: 0 });
    expect(s.db.prepare("SELECT COUNT(*) n FROM barcodes WHERE code='900'").get()).toEqual({ n: 0 });
    expect(s.db.prepare("SELECT COUNT(*) n FROM batches").get()).toEqual({ n: 0 });
    expect(s.db.prepare("SELECT COUNT(*) n FROM stock_movements WHERE reason='purchase'").get()).toEqual({ n: 0 });
    expect(listImports(s.db)[0]).toMatchObject({ undone: true, undoable: false });
    expect(() => undoImport(s.db, batch)).toThrow(/قبل كده/);
    expect(doImport(s)).toBeGreaterThan(batch);      // the same file can be imported again afterwards
  });

  it("only the latest import can be undone", () => {
    const s = setup();
    const first = doImport(s, "أول"), second = doImport(s, "تاني");
    expect(listImports(s.db).map((b) => b.undoable)).toEqual([true, false]);
    expect(() => undoImport(s.db, first)).toThrow(/آخر استيراد/);
    expect(undoImport(s.db, second)).toEqual({ removed: 0, restored: 2, skipped: 0 });   // the second one only updated what the first created
    expect(listImports(s.db).map((b) => b.undoable)).toEqual([false, true]);
    expect(undoImport(s.db, first)).toEqual({ removed: 1, restored: 1, skipped: 0 });    // now the first is the latest
  });

  it("a new product that was sold after the import is kept and reported", () => {
    const s = setup();
    const batch = doImport(s);
    const sold = (s.db.prepare("SELECT product_id id FROM barcodes WHERE code='900'").get() as { id: number }).id;
    createSale(s.db, { userId: s.owner, shiftId: s.shift, lines: [{ productId: sold, qty: 1 }], payMethod: "cash" });
    expect(undoImport(s.db, batch)).toEqual({ removed: 0, restored: 1, skipped: 1 });
    expect(s.db.prepare("SELECT COUNT(*) n FROM products WHERE id=?").get(sold)).toEqual({ n: 1 });
    expect(verifyTreasury(s.db).ok).toBe(true);
  });

  it("undoes a customers/suppliers import too, keeping parties that already have transactions", () => {
    const s = setup();
    const keep = saveParty(s.db, { name: "قديم", phone: "01", isCustomer: true, isSupplier: false, creditLimit: 5000 });
    const batch = beginImport(s.db, "parties", "عملاء.csv", s.owner);
    importParties(s.db, [
      { code: "", name: "قديم", phone: "02", taxNo: "9", address: "x", email: "e", isCustomer: true, isSupplier: true, creditLimit: 9000 },
      { code: "", name: "جديد1", phone: "", taxNo: "", address: "", email: "", isCustomer: false, isSupplier: true, creditLimit: 0 },
      { code: "", name: "جديد2", phone: "", taxNo: "", address: "", email: "", isCustomer: true, isSupplier: false, creditLimit: 0 },
    ], Date.now(), batch);
    const j2 = listParties(s.db).find((p) => p.name === "جديد2")!;
    createSale(s.db, { userId: s.owner, shiftId: s.shift, lines: [{ productId: s.tea, qty: 1 }], payMethod: "credit", customerId: saveParty(s.db, { id: j2.id, name: "جديد2", isCustomer: true, isSupplier: false, creditLimit: 99999 }) });
    expect(undoImport(s.db, batch)).toEqual({ removed: 1, restored: 1, skipped: 1 });
    expect(getParty(s.db, keep)).toMatchObject({ phone: "01", isSupplier: false, creditLimit: 5000, taxNo: "" });
    expect(listParties(s.db).map((p) => p.name)).toEqual(expect.arrayContaining(["قديم", "جديد2", "شركة النور"]));
    expect(listParties(s.db).some((p) => p.name === "جديد1")).toBe(false);
  });
});
