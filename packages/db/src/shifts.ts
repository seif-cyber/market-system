import type { Db } from "./types";
import { postEntry } from "./treasury";

export interface ShiftSummaryRow {
  openingCash: number;
  invoices: number;
  totalSales: number;
  cashSales: number;   // cash drawer in: cash sales + cash part of credit sales
  cardSales: number;
  creditSales: number; // amount left on credit
  cashReturns: number;
  cardReturns: number;
  debtPayments: number; // cash collected from customers' debts
  payouts: number;      // cash paid out of the drawer (expenses, suppliers)
  expectedCash: number;
}

/**
 * The opening amount is locked to what the previous cashier counted. A different amount needs a manager's approval and
 * is posted to the treasury as a handover adjustment (so the books always match the cash actually in the drawer).
 * The very first shift has nothing to compare with: the float simply moves from the safe to the drawer.
 */
export function openShift(db: Db, userId: number, openingCash: number, now = Date.now(), opts: { approvedBy?: number; reason?: string } = {}): number {
  if (!Number.isInteger(openingCash) || openingCash < 0) throw new Error("مبلغ افتتاح غلط");
  if (currentShift(db, userId)) throw new Error("فيه وردية مفتوحة بالفعل");
  return db.transaction(() => {
    const prev = lastClosedShift(db);
    const diff = prev ? openingCash - prev.counted : 0;
    if (diff !== 0 && !opts.approvedBy) throw new Error("المبلغ لازم يساوي اللي اتسلّم من الوردية السابقة، أو يعتمده المدير");
    const id = Number(db.prepare("INSERT INTO shifts(user_id,opened_at,opening_cash) VALUES(?,?,?)").run(userId, now, openingCash).lastInsertRowid);
    if (diff !== 0)
      postEntry(db, { account: "cash", delta: diff, kind: "handover_adjust", refTable: "shifts", refId: id, shiftId: id, userId, approvedBy: opts.approvedBy, note: opts.reason || "تعديل مبلغ استلام الدرج", createdAt: now });
    return id;
  })();
}

export function currentShift(db: Db, userId: number) {
  return db.prepare("SELECT id, opened_at AS openedAt, opening_cash AS openingCash FROM shifts WHERE user_id=? AND closed_at IS NULL").get(userId) as
    | { id: number; openedAt: number; openingCash: number }
    | undefined;
}

export function shiftSummary(db: Db, shiftId: number): ShiftSummaryRow {
  const sh = db.prepare("SELECT opening_cash AS openingCash FROM shifts WHERE id=?").get(shiftId) as { openingCash: number } | undefined;
  if (!sh) throw new Error("وردية غير موجودة");
  const s = db.prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(total),0) total,
       COALESCE(SUM(CASE WHEN pay_method='cash' THEN total END),0) cash,
       COALESCE(SUM(CASE WHEN pay_method='card' THEN total END),0) card,
       COALESCE(SUM(CASE WHEN pay_method='credit' THEN total-paid END),0) credit,
       COALESCE(SUM(CASE WHEN pay_method='credit' THEN paid END),0) creditPaid
     FROM sales WHERE shift_id=?`,
  ).get(shiftId) as any;
  const r = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN refund_method='cash' THEN total END),0) cash,
            COALESCE(SUM(CASE WHEN refund_method='card' THEN total END),0) card
     FROM returns WHERE shift_id=?`,
  ).get(shiftId) as any;
  const p = db.prepare("SELECT COALESCE(SUM(-delta),0) v FROM customer_ledger WHERE shift_id=? AND kind='payment' AND method='cash'").get(shiftId) as any;
  const cashSales = s.cash + s.creditPaid;
  // Single source of truth: everything that moved through this drawer is in the treasury ledger.
  const drawer = db.prepare("SELECT COALESCE(SUM(delta),0) v FROM treasury_entries WHERE shift_id=? AND in_drawer=1 AND account='cash'").get(shiftId) as { v: number };
  const out = db.prepare("SELECT COALESCE(SUM(-delta),0) v FROM treasury_entries WHERE shift_id=? AND in_drawer=1 AND kind IN ('expense','expense_void','supplier_payment')").get(shiftId) as { v: number };
  return {
    openingCash: sh.openingCash, invoices: s.n, totalSales: s.total, cashSales, cardSales: s.card, creditSales: s.credit,
    cashReturns: r.cash, cardReturns: r.card, debtPayments: p.v, payouts: out.v,
    expectedCash: sh.openingCash + drawer.v,
  };
}

export function closeShift(db: Db, shiftId: number, countedCash: number, now = Date.now()) {
  if (countedCash < 0) throw new Error("المبلغ المعدود غلط");
  return db.transaction(() => {
    const open = db.prepare("SELECT id, user_id FROM shifts WHERE id=? AND closed_at IS NULL").get(shiftId) as { id: number; user_id: number } | undefined;
    if (!open) throw new Error("الوردية مقفولة بالفعل");
    const summary = shiftSummary(db, shiftId);
    db.prepare("UPDATE shifts SET closed_at=?, counted_cash=?, expected_cash=? WHERE id=?").run(now, countedCash, summary.expectedCash, shiftId);
    const difference = countedCash - summary.expectedCash;
    // A shortage or surplus is real money missing from / extra in the treasury, booked on the closing cashier.
    postEntry(db, { account: "cash", delta: difference, kind: "shift_diff", refTable: "shifts", refId: shiftId, shiftId, userId: open.user_id, createdAt: now });
    return { summary, counted: countedCash, difference };
  })();
}

/** The most recently closed shift (anyone's): its counted cash is what the next cashier should receive. */
export function lastClosedShift(db: Db) {
  return db
    .prepare("SELECT u.name cashier, sh.counted_cash counted, sh.closed_at closedAt FROM shifts sh JOIN users u ON u.id=sh.user_id WHERE sh.closed_at IS NOT NULL ORDER BY sh.closed_at DESC, sh.id DESC LIMIT 1")
    .get() as { cashier: string; counted: number; closedAt: number } | undefined;
}

export interface ShiftHistoryRow {
  id: number; cashier: string; openedAt: number; closedAt: number | null; openingCash: number;
  totalSales: number; invoices: number; cashSales: number; cardSales: number; creditSales: number; returns: number;
  expected: number; counted: number | null; difference: number | null;
}

/** Newest first; open shifts are included with null counted/difference. */
export function shiftHistory(db: Db, limit = 100): ShiftHistoryRow[] {
  const rows = db
    .prepare("SELECT sh.id, u.name cashier, sh.opened_at openedAt, sh.closed_at closedAt, sh.opening_cash openingCash, sh.counted_cash counted FROM shifts sh JOIN users u ON u.id=sh.user_id ORDER BY sh.id DESC LIMIT ?")
    .all(limit) as { id: number; cashier: string; openedAt: number; closedAt: number | null; openingCash: number; counted: number | null }[];
  return rows.map((r) => {
    const s = shiftSummary(db, r.id);
    return {
      ...r, totalSales: s.totalSales, invoices: s.invoices, cashSales: s.cashSales, cardSales: s.cardSales, creditSales: s.creditSales,
      returns: s.cashReturns + s.cardReturns, expected: s.expectedCash, difference: r.counted === null ? null : r.counted - s.expectedCash,
    };
  });
}
