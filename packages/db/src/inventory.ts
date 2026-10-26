import type { ExpiringBatch } from "@market/core";
import type { Db } from "./types";
export type { ExpiringBatch } from "@market/core";

export interface InventoryRow {
  id: number; name: string; barcode: string; price: number; cost: number;
  stock: number; minStock: number; byWeight: boolean;
}

export function listProducts(db: Db, q = "", filter: "all" | "low" | "out" = "all", limit = 300): InventoryRow[] {
  const where = filter === "low" ? "AND p.min_stock>0 AND p.stock<=p.min_stock" : filter === "out" ? "AND p.stock<=0" : "";
  const rows = db
    .prepare(
      `SELECT p.id, p.name, COALESCE((SELECT code FROM barcodes WHERE product_id=p.id ORDER BY rowid LIMIT 1),'') barcode,
              p.price, p.cost, p.stock, p.min_stock minStock, p.by_weight byWeight
       FROM products p
       WHERE p.active=1 ${where} AND (p.name LIKE ? OR EXISTS(SELECT 1 FROM barcodes b WHERE b.product_id=p.id AND b.code LIKE ?))
       ORDER BY p.name LIMIT ?`,
    )
    .all(`%${q}%`, `%${q}%`, limit) as any[];
  return rows.map((r) => ({ ...r, byWeight: !!r.byWeight }));
}

export function saveProduct(
  db: Db,
  p: { id?: number; name: string; barcode: string; price: number; cost: number; minStock: number; byWeight: boolean },
): number {
  if (!p.name.trim()) throw new Error("اكتب اسم الصنف");
  if (!(p.price > 0)) throw new Error("السعر لازم يكون أكبر من صفر");
  if (p.cost < 0 || p.minStock < 0) throw new Error("قيمة غلط");
  const code = p.barcode.trim();
  return db.transaction(() => {
    let id = p.id;
    if (id) {
      db.prepare("UPDATE products SET name=?, price=?, cost=?, min_stock=?, by_weight=? WHERE id=?").run(p.name.trim(), p.price, p.cost, p.minStock, p.byWeight ? 1 : 0, id);
    } else {
      id = Number(db.prepare("INSERT INTO products(name,price,cost,min_stock,by_weight) VALUES(?,?,?,?,?)").run(p.name.trim(), p.price, p.cost, p.minStock, p.byWeight ? 1 : 0).lastInsertRowid);
    }
    if (code) {
      const owner = db.prepare("SELECT product_id FROM barcodes WHERE code=?").get(code) as { product_id: number } | undefined;
      if (owner && owner.product_id !== id) throw new Error("الباركود ده مستخدم في صنف تاني");
      if (!owner) {
        db.prepare("DELETE FROM barcodes WHERE product_id=? AND rowid=(SELECT MIN(rowid) FROM barcodes WHERE product_id=?)").run(id, id);
        db.prepare("INSERT INTO barcodes(code,product_id) VALUES(?,?)").run(code, id);
      }
    }
    return id;
  })();
}

export function receiveStock(db: Db, r: { productId: number; qty: number; cost?: number; expiry?: number; now?: number }) {
  if (!(r.qty > 0)) throw new Error("الكمية لازم تكون أكبر من صفر");
  const now = r.now ?? Date.now();
  db.transaction(() => {
    const p = db.prepare("SELECT id FROM products WHERE id=? AND active=1").get(r.productId);
    if (!p) throw new Error("الصنف غير موجود");
    db.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(r.qty, r.productId);
    if (r.cost !== undefined && r.cost >= 0) db.prepare("UPDATE products SET cost=? WHERE id=?").run(r.cost, r.productId);
    db.prepare("INSERT INTO stock_movements(product_id,delta,reason,created_at) VALUES(?,?,?,?)").run(r.productId, r.qty, "purchase", now);
    if (r.expiry) db.prepare("INSERT INTO batches(product_id,qty,expiry,created_at) VALUES(?,?,?,?)").run(r.productId, r.qty, r.expiry, now);
  })();
}

/** Stocktake: sets the counted quantity and logs the difference. */
export function adjustStock(db: Db, productId: number, actual: number, now = Date.now()): number {
  if (actual < 0) throw new Error("الكمية غلط");
  return db.transaction(() => {
    const p = db.prepare("SELECT stock FROM products WHERE id=?").get(productId) as { stock: number } | undefined;
    if (!p) throw new Error("الصنف غير موجود");
    const delta = actual - p.stock;
    db.prepare("UPDATE products SET stock=? WHERE id=?").run(actual, productId);
    if (delta !== 0) db.prepare("INSERT INTO stock_movements(product_id,delta,reason,created_at) VALUES(?,?,?,?)").run(productId, delta, "adjust", now);
    return delta;
  })();
}

/** First-expiry-first-out: sale quantity is taken from the soonest-expiring batches. */
export function consumeBatches(db: Db, productId: number, qty: number) {
  let left = qty;
  const rows = db.prepare("SELECT id, qty FROM batches WHERE product_id=? AND qty>0 ORDER BY expiry, id").all(productId) as { id: number; qty: number }[];
  for (const b of rows) {
    if (left <= 1e-9) break;
    const take = Math.min(b.qty, left);
    db.prepare("UPDATE batches SET qty=qty-? WHERE id=?").run(take, b.id);
    left -= take;
  }
}

/** Batches that already expired or expire within `withinDays` (daysLeft < 0 = expired). */
export function expiringBatches(db: Db, withinDays: number, now = Date.now(), limit = 50): ExpiringBatch[] {
  const rows = db
    .prepare("SELECT b.product_id productId, p.name, SUM(b.qty) qty, b.expiry FROM batches b JOIN products p ON p.id=b.product_id WHERE b.qty>0.0001 AND b.expiry<=? GROUP BY b.product_id, b.expiry ORDER BY b.expiry LIMIT ?")
    .all(now + withinDays * 86_400_000, limit) as { productId: number; name: string; qty: number; expiry: number }[];
  return rows.map((r) => ({ ...r, daysLeft: Math.floor((r.expiry - now) / 86_400_000) }));
}
