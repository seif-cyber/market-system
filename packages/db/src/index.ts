import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { calcInvoice, chainHash, GENESIS_HASH, type LineInput } from "@market/core";

import type { Db, Role } from "./types";
import { consumeBatches } from "./inventory";
import { postSalePayment } from "./treasury";
import { ensureCategory } from "./categories";
import { recordImportItem } from "./imports";
export type { Db, Role } from "./types";
export * from "./shifts";
export * from "./customers";
export * from "./inventory";
export * from "./returns";
export * from "./expenses";
export * from "./analytics";
export * from "./treasury";
export * from "./categories";
export * from "./purchases";
export * from "./promotions";
export * from "./reports";
export * from "./imports";

export function openDb(path: string, migrationsDir?: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db, migrationsDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
  return db;
}

function migrate(db: Db, dir: string) {
  const current = db.pragma("user_version", { simple: true }) as number;
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  files.forEach((f, i) => {
    if (i < current) return;
    const sql = readFileSync(join(dir, f), "utf8");
    // Table rebuilds need FK enforcement off (it cannot be toggled inside a transaction).
    const noFk = sql.startsWith("-- migrate:no-fk");
    if (noFk) db.pragma("foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.exec(sql);
        if (noFk && (db.pragma("foreign_key_check") as unknown[]).length) throw new Error(`migration ${f}: foreign key check failed`);
        db.pragma(`user_version = ${i + 1}`);
      })();
    } finally {
      if (noFk) db.pragma("foreign_keys = ON");
    }
  });
}

// ---- settings (brand name, logo, receipt header...) ----
export function getSetting(db: Db, key: string): string | undefined {
  return (db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value;
}
export function setSetting(db: Db, key: string, value: string) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

// ---- users / PIN ----
const hashPin = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString("hex");

export function createUser(db: Db, name: string, role: Role, pin: string): number {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN must be 4-8 digits");
  const salt = randomBytes(16).toString("hex");
  return Number(
    db.prepare("INSERT INTO users(name,role,pin_hash,pin_salt) VALUES(?,?,?,?)").run(name, role, hashPin(pin, salt), salt)
      .lastInsertRowid,
  );
}

export function loginWithPin(db: Db, userId: number, pin: string) {
  const u = db.prepare("SELECT * FROM users WHERE id=? AND active=1").get(userId) as any;
  if (!u) return null;
  const ok = timingSafeEqual(Buffer.from(hashPin(pin, u.pin_salt), "hex"), Buffer.from(u.pin_hash, "hex"));
  return ok ? { id: u.id as number, name: u.name as string, role: u.role as Role } : null;
}

export function audit(db: Db, userId: number | null, action: string, detail?: unknown) {
  db.prepare("INSERT INTO audit_log(user_id,action,detail,created_at) VALUES(?,?,?,?)")
    .run(userId, action, detail === undefined ? null : JSON.stringify(detail), Date.now());
}

// ---- products ----
export function addProduct(db: Db, p: { name: string; price: number; cost?: number; stock?: number; barcodes: string[] }) {
  return db.transaction(() => {
    const id = Number(
      db.prepare("INSERT INTO products(name,price,cost,stock) VALUES(?,?,?,?)").run(p.name, p.price, p.cost ?? 0, p.stock ?? 0)
        .lastInsertRowid,
    );
    for (const b of p.barcodes) db.prepare("INSERT INTO barcodes(code,product_id) VALUES(?,?)").run(b, id);
    return id;
  })();
}

export function findByBarcode(db: Db, code: string) {
  return db
    .prepare("SELECT p.* FROM products p JOIN barcodes b ON b.product_id=p.id WHERE b.code=? AND p.active=1")
    .get(code) as { id: number; name: string; price: number; stock: number; by_weight: number } | undefined;
}

// ---- sales ----
export interface CartLine { productId: number; qty: number; discount?: number; promoId?: number | null; promoDiscount?: number }

export interface SaleInput {
  userId: number;
  lines: CartLine[];
  payMethod: "cash" | "card" | "mixed" | "credit";
  invoiceDiscount?: number;
  taxRate?: number;
  taxInclusive?: boolean;
  shiftId?: number;
  customerId?: number;
  paidNow?: number; // credit sales: amount paid at the counter
  createdAt?: number; // demo seeding only
}

export function createSale(db: Db, input: SaleInput) {
  return db.transaction(() => {
    const priced: (LineInput & { productId: number; name: string; cost: number; promoId: number | null; promoDiscount: number })[] = input.lines.map((l) => {
      const p = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(l.productId) as any;
      if (!p) throw new Error(`unknown product ${l.productId}`);
      if (!(l.qty > 0)) throw new Error("الكمية لازم تكون أكبر من صفر");
      return { productId: p.id, name: p.name, unitPrice: p.price, qty: l.qty, discount: l.discount, cost: p.cost, promoId: l.promoId ?? null, promoDiscount: l.promoDiscount ?? 0 };
    });
    const t = calcInvoice(priced, input);
    if (input.payMethod === "credit" && !input.customerId) throw new Error("اختار العميل للبيع الآجل");
    const paid = input.payMethod === "credit" ? Math.min(Math.max(input.paidNow ?? 0, 0), t.total) : t.total;
    const last = db.prepare("SELECT no, hash FROM sales ORDER BY no DESC LIMIT 1").get() as { no: number; hash: string } | undefined;
    const no = (last?.no ?? 0) + 1;
    const prev = last?.hash ?? GENESIS_HASH;
    const createdAt = input.createdAt ?? Date.now();
    // The hashed payload must stay exactly in this shape: verifySalesChain() rebuilds it.
    const payload = { no, userId: input.userId, ...t, lines: priced.map((l) => [l.productId, l.unitPrice, l.qty, l.discount ?? 0]), createdAt };
    const hash = chainHash(prev, payload);
    const saleId = Number(
      db.prepare(
        "INSERT INTO sales(no,user_id,subtotal,discount,tax,total,pay_method,created_at,prev_hash,hash,shift_id,customer_id,paid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(no, input.userId, t.subtotal, t.discount, t.tax, t.total, input.payMethod, createdAt, prev, hash, input.shiftId ?? null, input.customerId ?? null, paid).lastInsertRowid,
    );
    for (const l of priced) {
      db.prepare("INSERT INTO sale_items(sale_id,product_id,name,unit_price,qty,discount,cost,promo_id,promo_discount) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(saleId, l.productId, l.name, l.unitPrice, l.qty, l.discount ?? 0, l.cost, l.promoId, l.promoDiscount);
      db.prepare("UPDATE products SET stock = stock - ? WHERE id=?").run(l.qty, l.productId);
      db.prepare("INSERT INTO stock_movements(product_id,delta,reason,ref_id,created_at) VALUES(?,?,?,?,?)")
        .run(l.productId, -l.qty, "sale", saleId, createdAt);
      consumeBatches(db, l.productId, l.qty);
    }
    if (t.total - paid > 0)
      db.prepare("INSERT INTO customer_ledger(customer_id,delta,kind,ref_id,shift_id,user_id,created_at) VALUES(?,?,?,?,?,?,?)")
        .run(input.customerId, t.total - paid, "sale", saleId, input.shiftId ?? null, input.userId, createdAt);
    postSalePayment(db, { payMethod: input.payMethod, total: t.total, paid, saleId, shiftId: input.shiftId, userId: input.userId, createdAt });
    return { saleId, no, ...t, paid };
  })();
}

// ---- lookups & bulk import ----
export function listUsers(db: Db) {
  return db.prepare("SELECT id,name,role FROM users WHERE active=1 ORDER BY id").all() as { id: number; name: string; role: Role }[];
}

export function searchProducts(db: Db, q: string, limit = 20) {
  return db
    .prepare("SELECT id,name,price,stock FROM products WHERE active=1 AND name LIKE ? ORDER BY name LIMIT ?")
    .all(`%${q}%`, limit) as { id: number; name: string; price: number; stock: number }[];
}

/** Upsert by barcode: existing barcode updates name/price/cost and adds to stock. */
export function importProducts(
  db: Db,
  rows: { barcode: string; name: string; price: number; cost: number; stock: number; minStock?: number; expiry?: number; category?: string }[],
  now = Date.now(),
  batchId?: number,
) {
  let created = 0, updated = 0;
  db.transaction(() => {
    for (const r of rows) {
      const hit = db.prepare("SELECT product_id FROM barcodes WHERE code=?").get(r.barcode) as { product_id: number } | undefined;
      let id: number;
      if (hit) {
        id = hit.product_id;
        if (batchId) recordImportItem(db, batchId, id, "updated", db.prepare("SELECT name, price, cost, min_stock, category_id FROM products WHERE id=?").get(id), r.stock);
        db.prepare("UPDATE products SET name=?, price=?, cost=?, stock=stock+?, min_stock=COALESCE(?, min_stock) WHERE id=?").run(r.name, r.price, r.cost, r.stock, r.minStock ?? null, id);
        updated++;
      } else {
        id = addProduct(db, { name: r.name, price: r.price, cost: r.cost, stock: r.stock, barcodes: [r.barcode] });
        if (r.minStock) db.prepare("UPDATE products SET min_stock=? WHERE id=?").run(r.minStock, id);
        if (batchId) recordImportItem(db, batchId, id, "created");
        created++;
      }
      if (r.category?.trim()) db.prepare("UPDATE products SET category_id=? WHERE id=?").run(ensureCategory(db, r.category), id);
      if (r.stock) db.prepare("INSERT INTO stock_movements(product_id,delta,reason,created_at,import_id) VALUES(?,?,?,?,?)").run(id, r.stock, "purchase", now, batchId ?? null);
      if (r.expiry && r.stock > 0) db.prepare("INSERT INTO batches(product_id,qty,expiry,created_at,import_id) VALUES(?,?,?,?,?)").run(id, r.stock, r.expiry, now, batchId ?? null);
    }
  })();
  return { created, updated };
}

// ---- user management ----
export function setUserActive(db: Db, userId: number, active: boolean) {
  if (!active) {
    const u = db.prepare("SELECT role FROM users WHERE id=?").get(userId) as { role: Role } | undefined;
    const owners = (db.prepare("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1").get() as { n: number }).n;
    if (u?.role === "owner" && owners <= 1) throw new Error("مينفعش توقف المالك الوحيد");
  }
  db.prepare("UPDATE users SET active=? WHERE id=?").run(active ? 1 : 0, userId);
}

export function setPin(db: Db, userId: number, pin: string) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error("PIN must be 4-8 digits");
  const salt = randomBytes(16).toString("hex");
  db.prepare("UPDATE users SET pin_hash=?, pin_salt=? WHERE id=?").run(hashPin(pin, salt), salt, userId);
}

/** Opens a candidate backup read-only and checks it is a healthy database of this app. */
export function validateBackup(path: string): { ok: true } | { ok: false; reason: string } {
  let b: Database.Database | undefined;
  try {
    b = new Database(path, { readonly: true, fileMustExist: true });
    if (b.pragma("integrity_check", { simple: true }) !== "ok") return { ok: false, reason: "الملف تالف" };
    const tables = (b.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    if (!["sales", "users", "products", "settings"].every((t) => tables.includes(t))) return { ok: false, reason: "الملف ده مش نسخة من البرنامج" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "مش قادر أفتح الملف" };
  } finally {
    b?.close();
  }
}
