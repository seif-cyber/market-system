import type { Db } from "./types";

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
  expectedCash: number;
}

export function openShift(db: Db, userId: number, openingCash: number, now = Date.now()): number {
  if (openingCash < 0) throw new Error("مبلغ افتتاح غلط");
  if (currentShift(db, userId)) throw new Error("فيه وردية مفتوحة بالفعل");
  return Number(db.prepare("INSERT INTO shifts(user_id,opened_at,opening_cash) VALUES(?,?,?)").run(userId, now, openingCash).lastInsertRowid);
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
  return {
    openingCash: sh.openingCash, invoices: s.n, totalSales: s.total, cashSales, cardSales: s.card, creditSales: s.credit,
    cashReturns: r.cash, cardReturns: r.card, debtPayments: p.v,
    expectedCash: sh.openingCash + cashSales + p.v - r.cash,
  };
}

export function closeShift(db: Db, shiftId: number, countedCash: number, now = Date.now()) {
  if (countedCash < 0) throw new Error("المبلغ المعدود غلط");
  return db.transaction(() => {
    const open = db.prepare("SELECT id FROM shifts WHERE id=? AND closed_at IS NULL").get(shiftId);
    if (!open) throw new Error("الوردية مقفولة بالفعل");
    const summary = shiftSummary(db, shiftId);
    db.prepare("UPDATE shifts SET closed_at=?, counted_cash=?, expected_cash=? WHERE id=?").run(now, countedCash, summary.expectedCash, shiftId);
    return { summary, counted: countedCash, difference: countedCash - summary.expectedCash };
  })();
}
