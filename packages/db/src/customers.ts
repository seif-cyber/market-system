import type { Db } from "./types";
import { postEntry } from "./treasury";

export interface CustomerRow { id: number; name: string; phone: string; creditLimit: number; balance: number }

const BAL = "(SELECT COALESCE(SUM(delta),0) FROM customer_ledger l WHERE l.customer_id=c.id)";

export function listCustomers(db: Db, q = ""): CustomerRow[] {
  return db
    .prepare(`SELECT c.id, c.name, c.phone, c.credit_limit AS creditLimit, ${BAL} AS balance FROM customers c WHERE c.active=1 AND (c.name LIKE ? OR c.phone LIKE ?) ORDER BY c.name LIMIT 200`)
    .all(`%${q}%`, `%${q}%`) as CustomerRow[];
}

/** What customers owe us in total (only positive balances). */
export function totalReceivables(db: Db): number {
  return (db.prepare("SELECT COALESCE(SUM(b),0) v FROM (SELECT SUM(delta) b FROM customer_ledger GROUP BY customer_id HAVING b>0)").get() as { v: number }).v;
}

export function getCustomer(db: Db, id: number): CustomerRow | undefined {
  return db.prepare(`SELECT c.id, c.name, c.phone, c.credit_limit AS creditLimit, ${BAL} AS balance FROM customers c WHERE c.id=? AND c.active=1`).get(id) as CustomerRow | undefined;
}

export function addCustomer(db: Db, c: { name: string; phone?: string; creditLimit?: number }, now = Date.now()): number {
  if (!c.name.trim()) throw new Error("اكتب اسم العميل");
  return Number(db.prepare("INSERT INTO customers(name,phone,credit_limit,created_at) VALUES(?,?,?,?)").run(c.name.trim(), c.phone ?? "", c.creditLimit ?? 0, now).lastInsertRowid);
}

export function setCreditLimit(db: Db, id: number, limit: number) {
  db.prepare("UPDATE customers SET credit_limit=? WHERE id=?").run(limit, id);
}

export function addPayment(db: Db, p: { customerId: number; amount: number; method: "cash" | "card"; shiftId?: number; userId: number; createdAt?: number }) {
  if (!(p.amount > 0)) throw new Error("المبلغ لازم يكون أكبر من صفر");
  return db.transaction(() => {
    const c = getCustomer(db, p.customerId);
    if (!c) throw new Error("العميل غير موجود");
    if (p.amount > c.balance) throw new Error("المبلغ أكبر من المديونية");
    const at = p.createdAt ?? Date.now();
    const lid = Number(
      db.prepare("INSERT INTO customer_ledger(customer_id,delta,kind,method,shift_id,user_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(p.customerId, -p.amount, "payment", p.method, p.shiftId ?? null, p.userId, at).lastInsertRowid,
    );
    postEntry(db, { account: p.method === "card" ? "bank" : "cash", delta: p.amount, kind: "customer_payment", refTable: "customer_ledger", refId: lid, shiftId: p.shiftId, inDrawer: p.method === "cash", userId: p.userId, createdAt: at });
    return c.balance - p.amount;
  })();
}

export function statement(db: Db, customerId: number) {
  const rows = db
    .prepare("SELECT id, delta, kind, method, note, ref_id AS refId, created_at AS createdAt FROM customer_ledger WHERE customer_id=? ORDER BY id")
    .all(customerId) as { id: number; delta: number; kind: string; method: string | null; note: string | null; refId: number | null; createdAt: number }[];
  let bal = 0;
  return rows.map((r) => ({ ...r, balanceAfter: (bal += r.delta) }));
}
