import type { Db } from "./types";
import { postEntry, type Account } from "./treasury";

export function addExpense(
  db: Db,
  e: { category: string; amount: number; note?: string; userId: number; createdAt?: number; paidFrom?: Account; fromDrawer?: boolean; shiftId?: number },
): number {
  if (!e.category.trim()) throw new Error("اختار نوع المصروف");
  if (!(e.amount > 0)) throw new Error("المبلغ لازم يكون أكبر من صفر");
  const paidFrom = e.paidFrom ?? "cash";
  if (e.fromDrawer && (paidFrom !== "cash" || !e.shiftId)) throw new Error("الدفع من الدرج محتاج وردية مفتوحة وكاش");
  const at = e.createdAt ?? Date.now();
  return db.transaction(() => {
    const id = Number(
      db.prepare("INSERT INTO expenses(category,amount,note,user_id,created_at,paid_from,from_drawer,shift_id) VALUES(?,?,?,?,?,?,?,?)")
        .run(e.category.trim(), e.amount, e.note ?? "", e.userId, at, paidFrom, e.fromDrawer ? 1 : 0, e.shiftId ?? null).lastInsertRowid,
    );
    postEntry(db, { account: paidFrom, delta: -e.amount, kind: "expense", refTable: "expenses", refId: id, shiftId: e.shiftId, inDrawer: !!e.fromDrawer, userId: e.userId, note: e.category.trim(), createdAt: at });
    return id;
  })();
}

export function listExpenses(db: Db, from: number, to: number) {
  return db
    .prepare("SELECT e.id, e.category, e.amount, e.note, e.created_at createdAt, e.paid_from paidFrom, e.from_drawer fromDrawer, u.name userName FROM expenses e JOIN users u ON u.id=e.user_id WHERE e.voided=0 AND e.created_at BETWEEN ? AND ? ORDER BY e.created_at DESC, e.id DESC LIMIT 500")
    .all(from, to) as { id: number; category: string; amount: number; note: string; createdAt: number; paidFrom: Account; fromDrawer: number; userName: string }[];
}

/** Expenses are never deleted: voiding keeps the row and posts the opposite treasury entry. */
export function voidExpense(db: Db, id: number, userId: number, now = Date.now()) {
  db.transaction(() => {
    const e = db.prepare("SELECT * FROM expenses WHERE id=?").get(id) as any;
    if (!e) throw new Error("المصروف غير موجود");
    if (e.voided) throw new Error("المصروف ملغي بالفعل");
    db.prepare("UPDATE expenses SET voided=1 WHERE id=?").run(id);
    // If the original came out of a drawer whose shift is still open, the refund goes back into that drawer.
    const open = e.from_drawer && e.shift_id ? db.prepare("SELECT id FROM shifts WHERE id=? AND closed_at IS NULL").get(e.shift_id) : undefined;
    postEntry(db, { account: e.paid_from, delta: e.amount, kind: "expense_void", refTable: "expenses", refId: id, shiftId: open ? e.shift_id : null, inDrawer: !!open, userId, note: `إلغاء: ${e.category}`, createdAt: now });
  })();
}
