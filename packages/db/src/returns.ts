import type { Db } from "./types";

export function getSaleForReturn(db: Db, no: number) {
  const s = db
    .prepare("SELECT s.id, s.no, s.created_at createdAt, s.total, s.pay_method payMethod, c.name customerName FROM sales s LEFT JOIN customers c ON c.id=s.customer_id WHERE s.no=?")
    .get(no) as { id: number; no: number; createdAt: number; total: number; payMethod: string; customerName: string | null } | undefined;
  if (!s) return null;
  const items = db
    .prepare(
      `SELECT si.id, si.name, si.unit_price unitPrice, si.qty, si.discount,
              COALESCE((SELECT SUM(ri.qty) FROM return_items ri WHERE ri.sale_item_id=si.id),0) returned
       FROM sale_items si WHERE si.sale_id=? ORDER BY si.id`,
    )
    .all(s.id) as { id: number; name: string; unitPrice: number; qty: number; discount: number; returned: number }[];
  return { ...s, items };
}

export function createReturn(
  db: Db,
  i: { saleNo: number; userId: number; approvedBy?: number; shiftId?: number; lines: { saleItemId: number; qty: number }[]; refundMethod?: "cash" | "card"; reason?: string; createdAt?: number },
) {
  return db.transaction(() => {
    const sale = db.prepare("SELECT * FROM sales WHERE no=?").get(i.saleNo) as any;
    if (!sale) throw new Error("الفاتورة غير موجودة");
    if (!i.lines.length) throw new Error("اختار صنف للمرتجع");
    const prior = (db.prepare("SELECT COALESCE(SUM(total),0) v FROM returns WHERE sale_id=?").get(sale.id) as { v: number }).v;
    const picked: { item: any; qty: number; amount: number; cost: number }[] = [];
    let sumLines = 0;
    for (const l of i.lines) {
      const item = db.prepare("SELECT * FROM sale_items WHERE id=? AND sale_id=?").get(l.saleItemId, sale.id) as any;
      if (!item) throw new Error("صنف مش في الفاتورة دي");
      const returned = (db.prepare("SELECT COALESCE(SUM(qty),0) v FROM return_items WHERE sale_item_id=?").get(item.id) as { v: number }).v;
      if (!(l.qty > 0) || l.qty > item.qty - returned + 1e-9) throw new Error(`كمية المرتجع أكبر من المتاح (${item.name})`);
      const lineNet = Math.round(item.unit_price * item.qty) - item.discount;
      const amount = Math.round((lineNet * l.qty) / item.qty);
      sumLines += amount;
      picked.push({ item, qty: l.qty, amount, cost: Math.round(item.cost * l.qty) });
    }
    const ratio = sale.subtotal > 0 ? sale.total / sale.subtotal : 1; // spreads invoice discount and tax
    const total = Math.min(Math.round(sumLines * ratio), sale.total - prior);
    if (total <= 0) throw new Error("مفيش مبلغ متاح للمرتجع");
    const tax = sale.total > 0 ? Math.round((sale.tax * total) / sale.total) : 0;
    const method: "cash" | "card" | "credit" = sale.pay_method === "credit" ? "credit" : (i.refundMethod ?? (sale.pay_method === "card" ? "card" : "cash"));
    const now = i.createdAt ?? Date.now();
    const rid = Number(
      db.prepare("INSERT INTO returns(sale_id,user_id,approved_by,shift_id,total,tax,refund_method,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(sale.id, i.userId, i.approvedBy ?? null, i.shiftId ?? null, total, tax, method, i.reason ?? null, now).lastInsertRowid,
    );
    for (const p of picked) {
      db.prepare("INSERT INTO return_items(return_id,sale_item_id,product_id,qty,amount,cost) VALUES(?,?,?,?,?,?)").run(rid, p.item.id, p.item.product_id, p.qty, p.amount, p.cost);
      db.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(p.qty, p.item.product_id);
      db.prepare("INSERT INTO stock_movements(product_id,delta,reason,ref_id,created_at) VALUES(?,?,?,?,?)").run(p.item.product_id, p.qty, "return", rid, now);
    }
    if (method === "credit" && sale.customer_id)
      db.prepare("INSERT INTO customer_ledger(customer_id,delta,kind,ref_id,user_id,note,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(sale.customer_id, -total, "adjust", rid, i.userId, `مرتجع فاتورة ${sale.no}`, now);
    return { id: rid, total, method };
  })();
}
