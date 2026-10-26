import type { Promo } from "@market/core";
import type { Db } from "./types";

const SEL = "SELECT id, name, type, target, target_id targetId, value, buy_qty buyQty, get_qty getQty, starts_at startsAt, ends_at endsAt, active FROM promotions";
const toPromo = (r: any): Promo => ({ ...r, active: !!r.active });

export function listPromotions(db: Db): Promo[] {
  return (db.prepare(`${SEL} ORDER BY active DESC, ends_at DESC, id DESC`).all() as any[]).map(toPromo);
}

export function listActivePromotions(db: Db, now = Date.now()): Promo[] {
  return (db.prepare(`${SEL} WHERE active=1 AND starts_at<=? AND ends_at>=?`).all(now, now) as any[]).map(toPromo);
}

export function savePromotion(db: Db, p: Omit<Promo, "id" | "active"> & { id?: number }, userId: number, now = Date.now()): number {
  if (!p.name.trim()) throw new Error("اكتب اسم العرض");
  if (p.type === "percent" && !(p.value >= 1 && p.value <= 100)) throw new Error("النسبة من 1 لـ 100");
  if (p.type === "amount" && !(Number.isInteger(p.value) && p.value > 0)) throw new Error("قيمة الخصم لازم تكون أكبر من صفر");
  if (p.type === "bxgy" && !(p.buyQty >= 1 && p.getQty >= 1)) throw new Error("اكتب كمية الشراء وكمية الهدية");
  if (p.endsAt < p.startsAt) throw new Error("تاريخ النهاية قبل البداية");
  const exists = p.target === "product" ? db.prepare("SELECT 1 FROM products WHERE id=? AND active=1").get(p.targetId) : db.prepare("SELECT 1 FROM categories WHERE id=?").get(p.targetId);
  if (!exists) throw new Error(p.target === "product" ? "الصنف غير موجود" : "القسم غير موجود");
  const f = [p.name.trim(), p.type, p.target, p.targetId, p.value, p.buyQty, p.getQty, p.startsAt, p.endsAt];
  if (p.id) {
    db.prepare("UPDATE promotions SET name=?, type=?, target=?, target_id=?, value=?, buy_qty=?, get_qty=?, starts_at=?, ends_at=? WHERE id=?").run(...f, p.id);
    return p.id;
  }
  return Number(db.prepare("INSERT INTO promotions(name,type,target,target_id,value,buy_qty,get_qty,starts_at,ends_at,user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(...f, userId, now).lastInsertRowid);
}

export function setPromotionActive(db: Db, id: number, active: boolean) {
  db.prepare("UPDATE promotions SET active=? WHERE id=?").run(active ? 1 : 0, id);
}
