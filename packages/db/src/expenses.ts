import type { Db } from "./types";

export function addExpense(db: Db, e: { category: string; amount: number; note?: string; userId: number; createdAt?: number }): number {
  if (!e.category.trim()) throw new Error("اختار نوع المصروف");
  if (!(e.amount > 0)) throw new Error("المبلغ لازم يكون أكبر من صفر");
  return Number(db.prepare("INSERT INTO expenses(category,amount,note,user_id,created_at) VALUES(?,?,?,?,?)").run(e.category.trim(), e.amount, e.note ?? "", e.userId, e.createdAt ?? Date.now()).lastInsertRowid);
}

export function listExpenses(db: Db, from: number, to: number) {
  return db
    .prepare("SELECT e.id, e.category, e.amount, e.note, e.created_at createdAt, u.name userName FROM expenses e JOIN users u ON u.id=e.user_id WHERE e.created_at BETWEEN ? AND ? ORDER BY e.created_at DESC, e.id DESC LIMIT 500")
    .all(from, to) as { id: number; category: string; amount: number; note: string; createdAt: number; userName: string }[];
}

export function deleteExpense(db: Db, id: number) {
  db.prepare("DELETE FROM expenses WHERE id=?").run(id);
}
