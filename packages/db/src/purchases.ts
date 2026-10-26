import type { Db } from "./types";
import { postEntry, type Account } from "./treasury";

export interface PurchaseItemInput { productId: number; qty: number; unitCost: number; expiry?: number }
export interface PaymentInput { amount: number; account: Account; inDrawer?: boolean; shiftId?: number | null }
export interface PurchaseInput {
  supplierId: number; supplierRef?: string; invoiceDate: number; dueDate?: number | null; note?: string;
  items: PurchaseItemInput[]; paid?: PaymentInput; userId: number; createdAt?: number;
}

const DAY = 86_400_000;

function requireSupplier(db: Db, id: number) {
  const s = db.prepare("SELECT id FROM customers WHERE id=? AND is_supplier=1 AND active=1").get(id);
  if (!s) throw new Error("المورد غير موجود");
}

export function supplierBalance(db: Db, supplierId: number): number {
  return (db.prepare("SELECT COALESCE(SUM(delta),0) v FROM supplier_ledger WHERE supplier_id=?").get(supplierId) as { v: number }).v;
}

/** What we owe all suppliers (positive balances only). */
export function totalPayables(db: Db): number {
  return (db.prepare("SELECT COALESCE(SUM(b),0) v FROM (SELECT SUM(delta) b FROM supplier_ledger GROUP BY supplier_id HAVING b>0)").get() as { v: number }).v;
}

/** Payment row + the matching treasury entry; the caller books the supplier ledger. */
function recordPayment(db: Db, p: PaymentInput & { supplierId: number; purchaseId: number | null; userId: number; note?: string; createdAt: number }): number {
  if (!Number.isInteger(p.amount) || p.amount <= 0) throw new Error("المبلغ لازم يكون أكبر من صفر");
  if (p.inDrawer && (p.account !== "cash" || !p.shiftId)) throw new Error("الدفع من الدرج محتاج وردية مفتوحة وكاش");
  const id = Number(
    db.prepare("INSERT INTO supplier_payments(supplier_id,purchase_id,amount,account,in_drawer,shift_id,user_id,note,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(p.supplierId, p.purchaseId, p.amount, p.account, p.inDrawer ? 1 : 0, p.shiftId ?? null, p.userId, p.note ?? "", p.createdAt).lastInsertRowid,
  );
  postEntry(db, { account: p.account, delta: -p.amount, kind: "supplier_payment", refTable: "supplier_payments", refId: id, shiftId: p.shiftId, inDrawer: !!p.inDrawer, userId: p.userId, note: p.note, createdAt: p.createdAt });
  return id;
}

/**
 * Receives goods from a supplier: stock goes up, product cost becomes the weighted average, and the invoice total is booked
 * as owed to the supplier. Whatever is paid now (cash / bank / part of it) leaves the treasury immediately.
 */
export function createPurchase(db: Db, i: PurchaseInput): { id: number; total: number; paid: number; remaining: number } {
  return db.transaction(() => {
    requireSupplier(db, i.supplierId);
    if (!i.items.length) throw new Error("ضيف أصناف للفاتورة");
    const at = i.createdAt ?? Date.now();
    if (i.dueDate && i.dueDate < i.invoiceDate) throw new Error("تاريخ الاستحقاق قبل تاريخ الفاتورة");
    let total = 0;
    for (const it of i.items) {
      if (!(it.qty > 0)) throw new Error("الكمية لازم تكون أكبر من صفر");
      if (!Number.isInteger(it.unitCost) || it.unitCost < 0) throw new Error("سعر الشراء غلط");
      total += Math.round(it.qty * it.unitCost);
    }
    const paid = i.paid?.amount ?? 0;
    if (paid < 0 || paid > total) throw new Error("المدفوع أكبر من إجمالي الفاتورة");
    const id = Number(
      db.prepare("INSERT INTO purchase_invoices(supplier_id,supplier_ref,invoice_date,due_date,total,note,user_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
        .run(i.supplierId, i.supplierRef ?? "", i.invoiceDate, i.dueDate ?? null, total, i.note ?? "", i.userId, at).lastInsertRowid,
    );
    for (const it of i.items) {
      const p = db.prepare("SELECT stock, cost FROM products WHERE id=? AND active=1").get(it.productId) as { stock: number; cost: number } | undefined;
      if (!p) throw new Error("صنف غير موجود في الفاتورة");
      const base = Math.max(p.stock, 0); // negative stock carries no cost
      const cost = base + it.qty > 0 ? Math.round((base * p.cost + it.qty * it.unitCost) / (base + it.qty)) : it.unitCost;
      db.prepare("UPDATE products SET stock=stock+?, cost=? WHERE id=?").run(it.qty, cost, it.productId);
      db.prepare("INSERT INTO stock_movements(product_id,delta,reason,ref_id,created_at) VALUES(?,?,?,?,?)").run(it.productId, it.qty, "purchase", id, at);
      db.prepare("INSERT INTO purchase_items(purchase_id,product_id,qty,unit_cost,expiry) VALUES(?,?,?,?,?)").run(id, it.productId, it.qty, it.unitCost, it.expiry ?? null);
      if (it.expiry) db.prepare("INSERT INTO batches(product_id,qty,expiry,created_at,purchase_id) VALUES(?,?,?,?,?)").run(it.productId, it.qty, it.expiry, at, id);
    }
    db.prepare("INSERT INTO supplier_ledger(supplier_id,delta,kind,ref_id,user_id,created_at) VALUES(?,?,?,?,?,?)").run(i.supplierId, total, "purchase", id, i.userId, at);
    if (paid > 0) {
      recordPayment(db, { ...i.paid!, supplierId: i.supplierId, purchaseId: id, userId: i.userId, createdAt: at, note: i.supplierRef ? `فاتورة ${i.supplierRef}` : "دفعة فاتورة شراء" });
      db.prepare("INSERT INTO supplier_ledger(supplier_id,delta,kind,ref_id,user_id,created_at) VALUES(?,?,?,?,?,?)").run(i.supplierId, -paid, "payment", id, i.userId, at);
    }
    return { id, total, paid, remaining: total - paid };
  })();
}

/** Pays a supplier later; the amount settles the oldest unpaid invoices first. */
export function paySupplier(db: Db, p: PaymentInput & { supplierId: number; userId: number; note?: string; createdAt?: number }) {
  return db.transaction(() => {
    requireSupplier(db, p.supplierId);
    const at = p.createdAt ?? Date.now();
    const bal = supplierBalance(db, p.supplierId);
    if (!(p.amount > 0)) throw new Error("المبلغ لازم يكون أكبر من صفر");
    if (p.amount > bal) throw new Error("المبلغ أكبر من المستحق للمورد");
    let left = p.amount;
    const open = db.prepare(
      `SELECT id, remaining FROM (SELECT p.id, p.invoice_date, p.total - COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.purchase_id=p.id AND sp.voided=0),0) remaining
                                   FROM purchase_invoices p WHERE p.supplier_id=? AND p.voided=0) WHERE remaining>0 ORDER BY invoice_date, id`,
    ).all(p.supplierId) as { id: number; remaining: number }[];
    for (const inv of open) {
      if (left <= 0) break;
      const part = Math.min(left, inv.remaining);
      recordPayment(db, { ...p, purchaseId: inv.id, createdAt: at, amount: part });
      left -= part;
    }
    if (left > 0) recordPayment(db, { ...p, purchaseId: null, createdAt: at, amount: left }); // e.g. against an opening balance
    db.prepare("INSERT INTO supplier_ledger(supplier_id,delta,kind,user_id,note,created_at) VALUES(?,?,?,?,?,?)").run(p.supplierId, -p.amount, "payment", p.userId, p.note ?? null, at);
    return bal - p.amount;
  })();
}

/** A balance owed before the system was used (no invoice behind it). */
export function addSupplierOpening(db: Db, supplierId: number, amount: number, userId: number, note = "رصيد افتتاحي", now = Date.now()) {
  requireSupplier(db, supplierId);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("المبلغ لازم يكون أكبر من صفر");
  db.prepare("INSERT INTO supplier_ledger(supplier_id,delta,kind,user_id,note,created_at) VALUES(?,?,?,?,?,?)").run(supplierId, amount, "adjust", userId, note, now);
}

/** Cancels an invoice: stock comes back out, the unpaid part leaves the supplier's balance, paid money returns to the treasury. */
export function voidPurchase(db: Db, id: number, userId: number, now = Date.now()) {
  db.transaction(() => {
    const inv = db.prepare("SELECT * FROM purchase_invoices WHERE id=?").get(id) as any;
    if (!inv) throw new Error("الفاتورة غير موجودة");
    if (inv.voided) throw new Error("الفاتورة ملغية بالفعل");
    db.prepare("UPDATE purchase_invoices SET voided=1 WHERE id=?").run(id);
    for (const it of db.prepare("SELECT product_id, qty FROM purchase_items WHERE purchase_id=?").all(id) as { product_id: number; qty: number }[]) {
      db.prepare("UPDATE products SET stock=stock-? WHERE id=?").run(it.qty, it.product_id);
      db.prepare("INSERT INTO stock_movements(product_id,delta,reason,ref_id,created_at) VALUES(?,?,?,?,?)").run(it.product_id, -it.qty, "purchase_void", id, now);
    }
    db.prepare("UPDATE batches SET qty=0 WHERE purchase_id=?").run(id);
    let paid = 0;
    for (const pay of db.prepare("SELECT id, amount, account FROM supplier_payments WHERE purchase_id=? AND voided=0").all(id) as { id: number; amount: number; account: Account }[]) {
      db.prepare("UPDATE supplier_payments SET voided=1 WHERE id=?").run(pay.id);
      postEntry(db, { account: pay.account, delta: pay.amount, kind: "supplier_payment_void", refTable: "supplier_payments", refId: pay.id, userId, note: `إلغاء فاتورة شراء #${id}`, createdAt: now });
      paid += pay.amount;
    }
    db.prepare("INSERT INTO supplier_ledger(supplier_id,delta,kind,ref_id,user_id,note,created_at) VALUES(?,?,?,?,?,?,?)").run(inv.supplier_id, -(inv.total - paid), "void", id, userId, "إلغاء فاتورة شراء", now);
  })();
}

export interface PurchaseRow {
  id: number; supplierId: number; supplier: string; supplierRef: string; invoiceDate: number; dueDate: number | null;
  total: number; paid: number; remaining: number; voided: boolean; note: string; status: "paid" | "partial" | "unpaid" | "overdue" | "voided";
}

export function listPurchases(db: Db, f: { supplierId?: number; from?: number; to?: number; limit?: number } = {}, now = Date.now()): PurchaseRow[] {
  const rows = db.prepare(
    `SELECT p.id, p.supplier_id supplierId, c.name supplier, p.supplier_ref supplierRef, p.invoice_date invoiceDate, p.due_date dueDate, p.total, p.voided, p.note,
            COALESCE((SELECT SUM(amount) FROM supplier_payments sp WHERE sp.purchase_id=p.id AND sp.voided=0),0) paid
     FROM purchase_invoices p JOIN customers c ON c.id=p.supplier_id
     WHERE (@s IS NULL OR p.supplier_id=@s) AND p.invoice_date BETWEEN @from AND @to
     ORDER BY p.invoice_date DESC, p.id DESC LIMIT @limit`,
  ).all({ s: f.supplierId ?? null, from: f.from ?? 0, to: f.to ?? 8.64e15, limit: f.limit ?? 200 }) as any[];
  return rows.map((r) => {
    const remaining = r.voided ? 0 : r.total - r.paid;
    const status = r.voided ? "voided" : remaining === 0 ? "paid" : r.dueDate && r.dueDate < now ? "overdue" : r.paid > 0 ? "partial" : "unpaid";
    return { ...r, voided: !!r.voided, remaining, status };
  });
}

export function purchaseItems(db: Db, id: number) {
  return db.prepare("SELECT i.product_id productId, p.name, i.qty, i.unit_cost unitCost, i.expiry FROM purchase_items i JOIN products p ON p.id=i.product_id WHERE i.purchase_id=? ORDER BY i.id").all(id) as
    { productId: number; name: string; qty: number; unitCost: number; expiry: number | null }[];
}

export function supplierStatement(db: Db, supplierId: number) {
  const rows = db.prepare(
    `SELECT l.id, l.delta, l.kind, l.note, l.created_at createdAt, l.ref_id refId, p.supplier_ref supplierRef
     FROM supplier_ledger l LEFT JOIN purchase_invoices p ON p.id=l.ref_id AND l.kind IN ('purchase','void') WHERE l.supplier_id=? ORDER BY l.id`,
  ).all(supplierId) as { id: number; delta: number; kind: string; note: string | null; createdAt: number; refId: number | null; supplierRef: string | null }[];
  let bal = 0;
  return rows.map((r) => ({ ...r, balanceAfter: (bal += r.delta) }));
}

export interface SupplierDue { id: number; name: string; phone: string; balance: number; overdue: number; nextDue: number | null }

/** Who we owe, how much of it is already late, and the next due date. */
export function supplierDues(db: Db, now = Date.now()): SupplierDue[] {
  const rows = db.prepare(
    `SELECT c.id, c.name, c.phone, (SELECT COALESCE(SUM(delta),0) FROM supplier_ledger l WHERE l.supplier_id=c.id) balance FROM customers c WHERE c.is_supplier=1 AND c.active=1`,
  ).all() as { id: number; name: string; phone: string; balance: number }[];
  return rows.filter((r) => r.balance > 0).map((r) => {
    const open = listPurchases(db, { supplierId: r.id, limit: 500 }, now).filter((p) => p.remaining > 0);
    const overdue = Math.min(r.balance, open.filter((p) => p.dueDate && p.dueDate < now).reduce((s, p) => s + p.remaining, 0));
    const next = open.filter((p) => p.dueDate && p.dueDate >= now).map((p) => p.dueDate!).sort((a, b) => a - b)[0] ?? null;
    return { ...r, overdue, nextDue: next };
  }).sort((a, b) => b.overdue - a.overdue || b.balance - a.balance);
}

export const daysFrom = (n: number, now = Date.now()) => now + n * DAY;
