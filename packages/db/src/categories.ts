import type { Db } from "./types";

export const DEFAULT_CATEGORIES = ["مشروبات", "شيبسي وسناكس", "ألبان وأجبان", "بقالة", "منظفات", "مجمدات", "خضار وفاكهة", "لحوم ودواجن"];

export function listCategories(db: Db) {
  return db.prepare("SELECT c.id, c.name, (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id AND p.active=1) products FROM categories c ORDER BY c.name").all() as { id: number; name: string; products: number }[];
}

export function addCategory(db: Db, name: string): number {
  const n = name.trim();
  if (!n) throw new Error("اكتب اسم القسم");
  if (db.prepare("SELECT 1 FROM categories WHERE name=?").get(n)) throw new Error("القسم ده موجود");
  return Number(db.prepare("INSERT INTO categories(name) VALUES(?)").run(n).lastInsertRowid);
}

export function renameCategory(db: Db, id: number, name: string) {
  const n = name.trim();
  if (!n) throw new Error("اكتب اسم القسم");
  const other = db.prepare("SELECT id FROM categories WHERE name=? AND id<>?").get(n, id);
  if (other) throw new Error("فيه قسم تاني بنفس الاسم");
  db.prepare("UPDATE categories SET name=? WHERE id=?").run(n, id);
}

export function deleteCategory(db: Db, id: number) {
  const n = (db.prepare("SELECT COUNT(*) n FROM products WHERE category_id=? AND active=1").get(id) as { n: number }).n;
  if (n > 0) throw new Error(`القسم فيه ${n} صنف. انقلهم لقسم تاني الأول`);
  db.prepare("UPDATE products SET category_id=NULL WHERE category_id=?").run(id);
  db.prepare("DELETE FROM categories WHERE id=?").run(id);
}

/** Id of the category with this name, creating it when missing (used by CSV import). */
export function ensureCategory(db: Db, name: string): number {
  const n = name.trim();
  const hit = db.prepare("SELECT id FROM categories WHERE name=?").get(n) as { id: number } | undefined;
  return hit?.id ?? addCategory(db, n);
}

export function seedDefaultCategories(db: Db): number {
  let added = 0;
  for (const n of DEFAULT_CATEGORIES) if (!db.prepare("SELECT 1 FROM categories WHERE name=?").get(n)) { addCategory(db, n); added++; }
  return added;
}
