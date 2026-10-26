import type { Db } from "./types";

export type Account = "cash" | "bank";

export interface EntryInput {
  account: Account;
  delta: number;
  kind: string;
  refTable?: string;
  refId?: number;
  shiftId?: number | null;
  inDrawer?: boolean;
  userId?: number | null;
  approvedBy?: number | null;
  note?: string;
  createdAt?: number;
}

/** Every money movement goes through here; the ledger is append-only (see triggers in migration 003). */
export function postEntry(db: Db, e: EntryInput): number {
  if (!Number.isInteger(e.delta)) throw new Error("مبلغ غير صحيح");
  if (e.delta === 0) return 0;
  return Number(
    db.prepare("INSERT INTO treasury_entries(account,delta,kind,ref_table,ref_id,shift_id,in_drawer,user_id,approved_by,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(e.account, e.delta, e.kind, e.refTable ?? null, e.refId ?? null, e.shiftId ?? null, e.inDrawer ? 1 : 0, e.userId ?? null, e.approvedBy ?? null, e.note ?? null, e.createdAt ?? Date.now())
      .lastInsertRowid,
  );
}

/** Where a sale's money lands: cash drawer, bank (card), or only the part paid at the counter for credit sales. */
export function postSalePayment(db: Db, p: { payMethod: string; total: number; paid: number; saleId: number; shiftId?: number | null; userId: number; createdAt: number }) {
  const base = { kind: "sale", refTable: "sales", refId: p.saleId, shiftId: p.shiftId, userId: p.userId, createdAt: p.createdAt };
  if (p.payMethod === "card") postEntry(db, { ...base, account: "bank", delta: p.total });
  else if (p.payMethod === "credit") postEntry(db, { ...base, account: "cash", delta: p.paid, inDrawer: true });
  else postEntry(db, { ...base, account: "cash", delta: p.total, inDrawer: true });
}

export interface Balances { cash: number; bank: number; total: number }

export function balances(db: Db): Balances {
  const rows = db.prepare("SELECT account, COALESCE(SUM(delta),0) v FROM treasury_entries GROUP BY account").all() as { account: Account; v: number }[];
  const cash = rows.find((r) => r.account === "cash")?.v ?? 0;
  const bank = rows.find((r) => r.account === "bank")?.v ?? 0;
  return { cash, bank, total: cash + bank };
}

export function balanceOf(db: Db, account: Account): number {
  return (db.prepare("SELECT COALESCE(SUM(delta),0) v FROM treasury_entries WHERE account=?").get(account) as { v: number }).v;
}

export interface EntryRow {
  id: number; account: Account; delta: number; kind: string; refTable: string | null; refId: number | null;
  shiftId: number | null; inDrawer: boolean; userName: string | null; approvedByName: string | null; note: string | null;
  createdAt: number; balanceAfter: number;
}

/** Newest first, with the running balance of each account at that point. */
export function listEntries(db: Db, f: { account?: Account; kind?: string; from?: number; to?: number; limit?: number } = {}): EntryRow[] {
  const rows = db.prepare(
    `SELECT * FROM (
       SELECT t.id, t.account, t.delta, t.kind, t.ref_table refTable, t.ref_id refId, t.shift_id shiftId, t.in_drawer inDrawer,
              u.name userName, a.name approvedByName, t.note, t.created_at createdAt,
              SUM(t.delta) OVER (PARTITION BY t.account ORDER BY t.created_at, t.id) balanceAfter
       FROM treasury_entries t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN users a ON a.id=t.approved_by
     ) WHERE (@account IS NULL OR account=@account) AND (@kind IS NULL OR kind=@kind) AND createdAt BETWEEN @from AND @to
     ORDER BY createdAt DESC, id DESC LIMIT @limit`,
  ).all({ account: f.account ?? null, kind: f.kind ?? null, from: f.from ?? 0, to: f.to ?? 8.64e15, limit: f.limit ?? 300 }) as any[];
  return rows.map((r) => ({ ...r, inDrawer: !!r.inDrawer }));
}

const positive = (n: number) => { if (!Number.isInteger(n) || n <= 0) throw new Error("المبلغ لازم يكون أكبر من صفر"); };

export function deposit(db: Db, p: { account: Account; amount: number; userId: number; note?: string; createdAt?: number }) {
  positive(p.amount);
  return postEntry(db, { account: p.account, delta: p.amount, kind: "deposit", userId: p.userId, note: p.note, createdAt: p.createdAt });
}

export function withdraw(db: Db, p: { account: Account; amount: number; userId: number; note?: string; createdAt?: number }) {
  positive(p.amount);
  return postEntry(db, { account: p.account, delta: -p.amount, kind: "withdrawal", userId: p.userId, note: p.note, createdAt: p.createdAt });
}

/** Cash <-> bank: two entries that always net to zero. */
export function transfer(db: Db, p: { from: Account; to: Account; amount: number; userId: number; note?: string; createdAt?: number }) {
  positive(p.amount);
  if (p.from === p.to) throw new Error("اختار حسابين مختلفين");
  return db.transaction(() => {
    const at = p.createdAt ?? Date.now();
    const out = postEntry(db, { account: p.from, delta: -p.amount, kind: "transfer", userId: p.userId, note: p.note, createdAt: at });
    postEntry(db, { account: p.to, delta: p.amount, kind: "transfer", refTable: "treasury_entries", refId: out, userId: p.userId, note: p.note, createdAt: at });
    return out;
  })();
}

/** Counting the real money: posts the difference between what the system says and what is really there. */
export function countAdjust(db: Db, p: { account: Account; counted: number; userId: number; note?: string; createdAt?: number }) {
  if (!Number.isInteger(p.counted) || p.counted < 0) throw new Error("المبلغ المعدود غلط");
  return db.transaction(() => {
    const diff = p.counted - balanceOf(db, p.account);
    postEntry(db, { account: p.account, delta: diff, kind: "count_adjust", userId: p.userId, note: p.note, createdAt: p.createdAt });
    return diff;
  })();
}

export interface TreasuryCheck {
  ok: boolean;
  checked: number;
  mismatches: { kind: string; account: Account; expected: number; actual: number }[];
}

/**
 * Re-derives every automatic entry kind from the source tables (sales, returns, customer payments, expenses, shifts)
 * and compares with what the ledger holds. Manual kinds (deposit, withdrawal, count, handover) have no source;
 * for transfers we check both legs exist and net to zero.
 */
export function verifyTreasury(db: Db): TreasuryCheck {
  const one = (sql: string) => (db.prepare(sql).get() as { v: number }).v;
  const actual = (kind: string, account: Account) =>
    (db.prepare("SELECT COALESCE(SUM(delta),0) v FROM treasury_entries WHERE kind=? AND account=?").get(kind, account) as { v: number }).v;
  const expected: [string, Account, number][] = [
    ["sale", "cash", one("SELECT COALESCE(SUM(CASE WHEN pay_method IN ('cash','mixed') THEN total WHEN pay_method='credit' THEN paid ELSE 0 END),0) v FROM sales")],
    ["sale", "bank", one("SELECT COALESCE(SUM(total),0) v FROM sales WHERE pay_method='card'")],
    ["sale_return", "cash", -one("SELECT COALESCE(SUM(total),0) v FROM returns WHERE refund_method='cash'")],
    ["sale_return", "bank", -one("SELECT COALESCE(SUM(total),0) v FROM returns WHERE refund_method='card'")],
    ["customer_payment", "cash", -one("SELECT COALESCE(SUM(delta),0) v FROM customer_ledger WHERE kind='payment' AND COALESCE(method,'cash')<>'card'")],
    ["customer_payment", "bank", -one("SELECT COALESCE(SUM(delta),0) v FROM customer_ledger WHERE kind='payment' AND method='card'")],
    ["expense", "cash", -one("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE paid_from='cash'")],
    ["expense", "bank", -one("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE paid_from='bank'")],
    ["expense_void", "cash", one("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE paid_from='cash' AND voided=1")],
    ["expense_void", "bank", one("SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE paid_from='bank' AND voided=1")],
    ["shift_diff", "cash", one("SELECT COALESCE(SUM(counted_cash-expected_cash),0) v FROM shifts WHERE closed_at IS NOT NULL")],
  ];
  const mismatches: TreasuryCheck["mismatches"] = [];
  for (const [kind, account, exp] of expected) {
    const act = actual(kind, account);
    if (act !== exp) mismatches.push({ kind, account, expected: exp, actual: act });
  }
  const net = one("SELECT COALESCE(SUM(delta),0) v FROM treasury_entries WHERE kind='transfer'");
  if (net !== 0) mismatches.push({ kind: "transfer", account: "cash", expected: 0, actual: net });
  return { ok: mismatches.length === 0, checked: one("SELECT COUNT(*) v FROM treasury_entries"), mismatches };
}
