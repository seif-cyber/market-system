import type { Db } from "./types";
import { postEntry } from "./treasury";
import { recordImportItem } from "./imports";

export interface CustomerRow { id: number; name: string; phone: string; creditLimit: number; balance: number }

const BAL = "(SELECT COALESCE(SUM(delta),0) FROM customer_ledger l WHERE l.customer_id=c.id)";

export function listCustomers(db: Db, q = ""): CustomerRow[] {
  return db
    .prepare(`SELECT c.id, c.name, c.phone, c.credit_limit AS creditLimit, ${BAL} AS balance FROM customers c WHERE c.active=1 AND c.is_customer=1 AND (c.name LIKE ? OR c.phone LIKE ?) ORDER BY c.name LIMIT 200`)
    .all(`%${q}%`, `%${q}%`) as CustomerRow[];
}

/** What customers owe us in total (only positive balances). */
export function totalReceivables(db: Db): number {
  return (db.prepare("SELECT COALESCE(SUM(b),0) v FROM (SELECT SUM(delta) b FROM customer_ledger GROUP BY customer_id HAVING b>0)").get() as { v: number }).v;
}

export function getCustomer(db: Db, id: number): CustomerRow | undefined {
  return db.prepare(`SELECT c.id, c.name, c.phone, c.credit_limit AS creditLimit, ${BAL} AS balance FROM customers c WHERE c.id=? AND c.active=1 AND c.is_customer=1`).get(id) as CustomerRow | undefined;
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

// ---- parties: one record for a customer, a supplier, or both ----
export interface PartyRow {
  id: number; code: string; name: string; phone: string; taxNo: string; address: string; email: string; notes: string;
  isCustomer: boolean; isSupplier: boolean; active: boolean; creditLimit: number;
  receivable: number; // what the party owes us (customer ledger)
  payable: number;    // what we owe the party (supplier ledger)
  net: number;        // receivable - payable
}
export interface PartyInput {
  id?: number; name: string; phone?: string; code?: string; taxNo?: string; address?: string; email?: string; notes?: string;
  isCustomer: boolean; isSupplier: boolean; creditLimit?: number;
}

const PARTY_SQL = `SELECT c.id, c.code, c.name, c.phone, c.tax_no taxNo, c.address, c.email, c.notes, c.is_customer isCustomer, c.is_supplier isSupplier,
  c.active, c.credit_limit creditLimit,
  (SELECT COALESCE(SUM(delta),0) FROM customer_ledger l WHERE l.customer_id=c.id) receivable,
  (SELECT COALESCE(SUM(delta),0) FROM supplier_ledger s WHERE s.supplier_id=c.id) payable FROM customers c`;

const toParty = (r: any): PartyRow => ({ ...r, isCustomer: !!r.isCustomer, isSupplier: !!r.isSupplier, active: !!r.active, net: r.receivable - r.payable });

export function listParties(db: Db, f: { q?: string; type?: "all" | "customer" | "supplier"; includeInactive?: boolean } = {}): PartyRow[] {
  const type = f.type === "customer" ? "AND c.is_customer=1" : f.type === "supplier" ? "AND c.is_supplier=1" : "";
  const q = `%${f.q ?? ""}%`;
  return (db.prepare(`${PARTY_SQL} WHERE (${f.includeInactive ? "1" : "c.active=1"}) ${type} AND (c.name LIKE ? OR c.phone LIKE ? OR c.code LIKE ?) ORDER BY c.name LIMIT 500`).all(q, q, q) as any[]).map(toParty);
}

export function getParty(db: Db, id: number): PartyRow | undefined {
  const r = db.prepare(`${PARTY_SQL} WHERE c.id=?`).get(id);
  return r ? toParty(r) : undefined;
}

export function saveParty(db: Db, p: PartyInput, now = Date.now()): number {
  if (!p.name.trim()) throw new Error("اكتب الاسم");
  if (!p.isCustomer && !p.isSupplier) throw new Error("اختار عميل أو مورد (أو الاتنين)");
  const limit = p.isCustomer ? p.creditLimit ?? 0 : 0;
  if (limit < 0) throw new Error("حد الآجل غلط");
  const f = [p.name.trim(), p.phone ?? "", p.code ?? "", p.taxNo ?? "", p.address ?? "", p.email ?? "", p.notes ?? "", p.isCustomer ? 1 : 0, p.isSupplier ? 1 : 0, limit];
  if (p.id) {
    const cur = getParty(db, p.id);
    if (!cur) throw new Error("غير موجود");
    if (cur.isCustomer && !p.isCustomer && cur.receivable !== 0) throw new Error("العميل عليه مديونية، مينفعش تشيل خانة عميل");
    if (cur.isSupplier && !p.isSupplier && cur.payable !== 0) throw new Error("فيه مستحقات للمورد، مينفعش تشيل خانة مورد");
    db.prepare("UPDATE customers SET name=?, phone=?, code=?, tax_no=?, address=?, email=?, notes=?, is_customer=?, is_supplier=?, credit_limit=? WHERE id=?").run(...f, p.id);
    return p.id;
  }
  return Number(db.prepare("INSERT INTO customers(name,phone,code,tax_no,address,email,notes,is_customer,is_supplier,credit_limit,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(...f, now).lastInsertRowid);
}

/** Upsert by code when given, otherwise by exact name. */
export function importParties(db: Db, rows: { code: string; name: string; phone: string; taxNo: string; address: string; email: string; isCustomer: boolean; isSupplier: boolean; creditLimit: number }[], now = Date.now(), batchId?: number) {
  let created = 0, updated = 0;
  db.transaction(() => {
    for (const r of rows) {
      const hit = (r.code ? db.prepare("SELECT id FROM customers WHERE code=?").get(r.code) : db.prepare("SELECT id FROM customers WHERE name=?").get(r.name)) as { id: number } | undefined;
      if (hit) {
        const cur = getParty(db, hit.id)!;
        if (batchId) recordImportItem(db, batchId, hit.id, "updated", { name: cur.name, phone: cur.phone, code: cur.code, taxNo: cur.taxNo, address: cur.address, email: cur.email, isCustomer: cur.isCustomer ? 1 : 0, isSupplier: cur.isSupplier ? 1 : 0, creditLimit: cur.creditLimit });
        saveParty(db, { ...r, id: hit.id, isCustomer: r.isCustomer || (cur.isCustomer && cur.receivable !== 0), isSupplier: r.isSupplier || (cur.isSupplier && cur.payable !== 0) }, now);
        updated++;
      } else { const id = saveParty(db, r, now); if (batchId) recordImportItem(db, batchId, id, "created"); created++; }
    }
  })();
  return { created, updated };
}

/** "Delete" = deactivate, and only when nothing is owed either way. */
export function setPartyActive(db: Db, id: number, active: boolean) {
  const p = getParty(db, id);
  if (!p) throw new Error("غير موجود");
  if (!active && (p.receivable !== 0 || p.payable !== 0)) throw new Error("عليه رصيد، سدّد الأول وبعدين وقّفه");
  db.prepare("UPDATE customers SET active=? WHERE id=?").run(active ? 1 : 0, id);
}
