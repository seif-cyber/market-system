export type PromoType = "percent" | "amount" | "bxgy";

export interface Promo {
  id: number; name: string; type: PromoType; target: "product" | "category"; targetId: number;
  value: number;   // percent (1-100) or piastres off per unit
  buyQty: number; getQty: number; // buy X get Y free
  startsAt: number; endsAt: number; active: boolean;
}
export interface PromoLine { productId: number; categoryId: number | null; unitPrice: number; qty: number }
export interface PromoResult { discount: number; promoId: number | null; name: string | null }

export const isRunning = (p: Promo, now: number) => p.active && p.startsAt <= now && now <= p.endsAt;

const matches = (p: Promo, l: PromoLine) => (p.target === "product" ? p.targetId === l.productId : l.categoryId !== null && p.targetId === l.categoryId);

function discountFor(p: Promo, l: PromoLine): number {
  const gross = Math.round(l.unitPrice * l.qty);
  let d = 0;
  if (p.type === "percent") d = Math.round((gross * p.value) / 100);
  else if (p.type === "amount") d = Math.round(p.value * l.qty);
  else if (p.buyQty > 0 && p.getQty > 0) d = Math.floor(l.qty / (p.buyQty + p.getQty)) * p.getQty * l.unitPrice;
  return Math.max(0, Math.min(d, gross));
}

/**
 * Best running promotion per line (promotions never stack on the same line).
 * Pure and deterministic, so the cart preview and the server's checkout always agree.
 */
export function applyPromotions(lines: PromoLine[], promos: Promo[], now: number): PromoResult[] {
  const running = promos.filter((p) => isRunning(p, now));
  return lines.map((l) => {
    let best: PromoResult = { discount: 0, promoId: null, name: null };
    for (const p of running) {
      if (!matches(p, l)) continue;
      const d = discountFor(p, l);
      if (d > best.discount) best = { discount: d, promoId: p.id, name: p.name };
    }
    return best;
  });
}
