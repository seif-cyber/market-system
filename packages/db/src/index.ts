import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { calcInvoice, chainHash, GENESIS_HASH, type LineInput } from "@market/core";

export type Db = Database.Database;
export type Role = "owner" | "manager" | "cashier";

const here = dirname(fileURLToPath(import.meta.url));

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const dir = join(here, "..", "migrations");
  const current = db.pragma("user_version", { simple: true }) as number;
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  files.forEach((f, i) => {
    if (i < current) return;
    db.transaction(() => {
      db.exec(readFileSync(join(dir, f), "utf8"));
      db.pragma(`user_version = ${i + 1}`);
    })();
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
export interface CartLine { productId: number; qty: number; discount?: number }

export function createSale(
  db: Db,
  input: { userId: number; lines: CartLine[]; payMethod: "cash" | "card" | "mixed"; invoiceDiscount?: number; taxRate?: number; taxInclusive?: boolean },
) {
  return db.transaction(() => {
    const priced: (LineInput & { productId: number; name: string })[] = input.lines.map((l) => {
      const p = db.prepare("SELECT * FROM products WHERE id=? AND active=1").get(l.productId) as any;
      if (!p) throw new Error(`unknown product ${l.productId}`);
      return { productId: p.id, name: p.name, unitPrice: p.price, qty: l.qty, discount: l.discount };
    });
    const t = calcInvoice(priced, input);
    const last = db.prepare("SELECT no, hash FROM sales ORDER BY no DESC LIMIT 1").get() as { no: number; hash: string } | undefined;
    const no = (last?.no ?? 0) + 1;
    const prev = last?.hash ?? GENESIS_HASH;
    const createdAt = Date.now();
    const payload = { no, userId: input.userId, ...t, lines: priced.map((l) => [l.productId, l.unitPrice, l.qty, l.discount ?? 0]), createdAt };
    const hash = chainHash(prev, payload);
    const saleId = Number(
      db.prepare(
        "INSERT INTO sales(no,user_id,subtotal,discount,tax,total,pay_method,created_at,prev_hash,hash) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(no, input.userId, t.subtotal, t.discount, t.tax, t.total, input.payMethod, createdAt, prev, hash).lastInsertRowid,
    );
    for (const l of priced) {
      db.prepare("INSERT INTO sale_items(sale_id,product_id,name,unit_price,qty,discount) VALUES(?,?,?,?,?,?)")
        .run(saleId, l.productId, l.name, l.unitPrice, l.qty, l.discount ?? 0);
      db.prepare("UPDATE products SET stock = stock - ? WHERE id=?").run(l.qty, l.productId);
      db.prepare("INSERT INTO stock_movements(product_id,delta,reason,ref_id,created_at) VALUES(?,?,?,?,?)")
        .run(l.productId, -l.qty, "sale", saleId, createdAt);
    }
    return { saleId, no, ...t };
  })();
}
