import type { Db } from "./types";

export type ImportKind = "products" | "parties";

export function beginImport(db: Db, kind: ImportKind, label: string, userId: number | null, now = Date.now()): number {
  return Number(db.prepare("INSERT INTO import_batches(kind,label,user_id,created_at) VALUES(?,?,?,?)").run(kind, label, userId, now).lastInsertRowid);
}

export function recordImportItem(db: Db, batchId: number, entityId: number, action: "created" | "updated", before?: unknown, stockDelta = 0) {
  db.prepare("INSERT INTO import_items(batch_id,entity_id,action,before,stock_delta) VALUES(?,?,?,?,?)").run(batchId, entityId, action, before === undefined ? null : JSON.stringify(before), stockDelta);
}

export interface ImportBatchRow { id: number; kind: ImportKind; label: string; createdAt: number; userName: string; created: number; updated: number; undone: boolean; undoable: boolean }

/** Newest first. Only the latest not-yet-undone batch of each kind can be undone (so undoing never overwrites a newer import). */
export function listImports(db: Db, limit = 20): ImportBatchRow[] {
  const rows = db.prepare(
    `SELECT b.id, b.kind, b.label, b.created_at createdAt, COALESCE(u.name,'') userName, b.undone_at undoneAt,
            (SELECT COUNT(*) FROM import_items i WHERE i.batch_id=b.id AND i.action='created') created,
            (SELECT COUNT(*) FROM import_items i WHERE i.batch_id=b.id AND i.action='updated') updated
     FROM import_batches b LEFT JOIN users u ON u.id=b.user_id ORDER BY b.id DESC LIMIT ?`,
  ).all(limit) as any[];
  const latest = new Map<string, number>();
  for (const r of db.prepare("SELECT kind, MAX(id) id FROM import_batches WHERE undone_at IS NULL GROUP BY kind").all() as { kind: string; id: number }[]) latest.set(r.kind, r.id);
  return rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, createdAt: r.createdAt, userName: r.userName, created: r.created, updated: r.updated, undone: r.undoneAt !== null, undoable: latest.get(r.kind) === r.id }));
}

const PARTY_REFS = [
  "SELECT 1 FROM sales WHERE customer_id=@id", "SELECT 1 FROM customer_ledger WHERE customer_id=@id", "SELECT 1 FROM supplier_ledger WHERE supplier_id=@id",
  "SELECT 1 FROM purchase_invoices WHERE supplier_id=@id", "SELECT 1 FROM supplier_payments WHERE supplier_id=@id",
];
const PRODUCT_REFS = [
  "SELECT 1 FROM sale_items WHERE product_id=@id", "SELECT 1 FROM purchase_items WHERE product_id=@id", "SELECT 1 FROM return_items WHERE product_id=@id",
  "SELECT 1 FROM promotions WHERE target='product' AND target_id=@id",
];

/**
 * Puts things back as they were before the import: new records are removed, updated ones get their old values back
 * (and the stock the import added is taken out again). New products that were sold/bought/returned since are kept and reported.
 */
export function undoImport(db: Db, batchId: number, now = Date.now()): { removed: number; restored: number; skipped: number } {
  return db.transaction(() => {
    const batch = db.prepare("SELECT * FROM import_batches WHERE id=?").get(batchId) as { kind: ImportKind; undone_at: number | null } | undefined;
    if (!batch) throw new Error("الاستيراد غير موجود");
    if (batch.undone_at) throw new Error("الاستيراد ده اتلغى قبل كده");
    const latest = db.prepare("SELECT MAX(id) id FROM import_batches WHERE kind=? AND undone_at IS NULL").get(batch.kind) as { id: number };
    if (latest.id !== batchId) throw new Error("تقدر تتراجع عن آخر استيراد بس");
    const items = db.prepare("SELECT * FROM import_items WHERE batch_id=? ORDER BY id").all(batchId) as { entity_id: number; action: string; before: string | null; stock_delta: number }[];
    let removed = 0, restored = 0, skipped = 0;
    for (const it of items) {
      const id = it.entity_id;
      if (batch.kind === "products") {
        if (it.action === "created") {
          const used = PRODUCT_REFS.some((q) => db.prepare(q).get({ id })) ||
            db.prepare("SELECT 1 FROM stock_movements WHERE product_id=? AND (import_id IS NULL OR import_id<>?)").get(id, batchId);
          if (used || !db.prepare("SELECT 1 FROM products WHERE id=?").get(id)) { skipped++; continue; }
          db.prepare("DELETE FROM batches WHERE product_id=?").run(id);
          db.prepare("DELETE FROM stock_movements WHERE product_id=?").run(id);
          db.prepare("DELETE FROM barcodes WHERE product_id=?").run(id);
          db.prepare("DELETE FROM products WHERE id=?").run(id);
          removed++;
        } else {
          const b = JSON.parse(it.before!) as { name: string; price: number; cost: number; min_stock: number; category_id: number | null };
          db.prepare("UPDATE products SET name=?, price=?, cost=?, min_stock=?, category_id=?, stock=stock-? WHERE id=?").run(b.name, b.price, b.cost, b.min_stock, b.category_id, it.stock_delta, id);
          db.prepare("DELETE FROM stock_movements WHERE product_id=? AND import_id=?").run(id, batchId);
          db.prepare("DELETE FROM batches WHERE product_id=? AND import_id=?").run(id, batchId);
          restored++;
        }
      } else if (it.action === "created") {
        if (PARTY_REFS.some((q) => db.prepare(q).get({ id }))) { skipped++; continue; }
        db.prepare("DELETE FROM customers WHERE id=?").run(id);
        removed++;
      } else {
        const b = JSON.parse(it.before!) as Record<string, string | number>;
        db.prepare("UPDATE customers SET name=?, phone=?, code=?, tax_no=?, address=?, email=?, is_customer=?, is_supplier=?, credit_limit=? WHERE id=?")
          .run(b.name, b.phone, b.code, b.taxNo, b.address, b.email, b.isCustomer, b.isSupplier, b.creditLimit, id);
        restored++;
      }
    }
    db.prepare("UPDATE import_batches SET undone_at=? WHERE id=?").run(now, batchId);
    return { removed, restored, skipped };
  })();
}
