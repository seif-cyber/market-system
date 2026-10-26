import {
  addCustomer, addExpense, addPayment, adjustStock, closeShift, createReturn, createSale, createUser, getCustomer,
  getSaleForReturn, openShift, receiveStock, saveProduct, setSetting, shiftSummary, type Db,
} from "@market/db";

const DAY = 86_400_000, HOUR = 3_600_000;

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// name, price EGP, cost EGP, barcode, popularity (0 = never sold -> dead stock), weighed
const CATALOG: [string, number, number, string, number, boolean][] = [
  ["شاي العروسة 40 جم", 12, 10, "6221001", 10, false], ["شاي ليبتون 100 جم", 38, 32, "6221002", 5, false],
  ["سكر 1 كجم", 32, 27, "6221003", 9, false], ["أرز مصري 1 كجم", 34, 29, "6221004", 8, false],
  ["زيت عافية 800 مل", 78, 68, "6221005", 6, false], ["مكرونة ريجينا 400 جم", 11, 9, "6221006", 9, false],
  ["لبن جهينة 1 لتر", 36, 31, "6221007", 10, false], ["زبادي جهينة 105 جم", 7, 5.5, "6221008", 8, false],
  ["جبنة رومي كجم", 280, 245, "123", 3, true], ["جبنة بيضاء كجم", 120, 100, "124", 5, true],
  ["طماطم كجم", 18, 12, "125", 7, true], ["بطاطس كجم", 22, 15, "126", 6, true],
  ["موز كجم", 40, 30, "127", 4, true], ["لحمة مفرومة كجم", 340, 295, "128", 2, true],
  ["بيض (طبق 30)", 135, 118, "6221009", 6, false], ["عيش توست", 24, 19, "6221010", 5, false],
  ["بيبسي 1 لتر", 19, 15, "6221011", 9, false], ["مياه معدنية 1.5 لتر", 8, 5.5, "6221012", 10, false],
  ["شيبسي 25 جم", 5, 3.8, "6221013", 9, false], ["بسكويت أولكر", 6, 4.5, "6221014", 7, false],
  ["صابون لوكس", 14, 10.5, "6221015", 4, false], ["شامبو 200 مل", 62, 50, "6221016", 3, false],
  ["منظف ديتول 500 مل", 70, 58, "6221017", 3, false], ["مناديل فاين", 25, 19, "6221018", 5, false],
  ["معجون أسنان", 33, 26, "6221019", 4, false], ["نسكافيه 3 في 1", 6, 4.5, "6221020", 8, false],
  ["عدس 1 كجم", 45, 38, "6221021", 3, false], ["فول معلب", 14, 11, "6221022", 4, false],
  ["تونة معلبة", 48, 40, "6221023", 3, false], ["حلاوة طحينية", 22, 17, "6221024", 0, false],
  ["شوكولاتة مستوردة", 90, 70, "6221025", 0, false], ["عطر جيب", 150, 110, "6221026", 0, false],
  ["علبة هدايا", 210, 160, "6221027", 0, false], ["شاي أخضر", 52, 41, "6221028", 0, false],
];
const DAIRY = ["لبن جهينة 1 لتر", "زبادي جهينة 105 جم", "جبنة بيضاء كجم", "جبنة رومي كجم"];
const HOUR_W: Record<number, number> = { 9: 3, 10: 5, 11: 6, 12: 8, 13: 10, 14: 10, 15: 8, 16: 7, 17: 8, 18: 10, 19: 13, 20: 13, 21: 10, 22: 6, 23: 2 };

export function seedDemo(db: Db, now = Date.now(), days = 45) {
  const r = rng(20260101);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const weighted = <T,>(items: T[], w: (x: T) => number) => {
    let x = r() * items.reduce((s, i) => s + w(i), 0);
    for (const i of items) if ((x -= w(i)) < 0) return i;
    return items[0];
  };

  const owner = createUser(db, "المدير", "owner", "1234");
  const ahmed = createUser(db, "أحمد", "cashier", "1111");
  const mona = createUser(db, "منى", "cashier", "2222");
  setSetting(db, "brand_name", "سوبر ماركت النور (نسخة تجريبية)");
  setSetting(db, "address", "شارع التحرير، القاهرة");
  setSetting(db, "phone", "01000000000");
  setSetting(db, "footer", "شكراً لزيارتكم، نورتونا");

  const products = CATALOG.map(([name, price, cost, barcode, pop, weighed]) => {
    const id = saveProduct(db, { name, barcode, price: Math.round(price * 100), cost: Math.round(cost * 100), minStock: weighed ? 5 : 10, byWeight: weighed });
    db.prepare("UPDATE products SET stock=2000 WHERE id=?").run(id); // plenty during the simulation; tuned afterwards
    return { id, name, price: Math.round(price * 100), pop, weighed };
  });
  const sellable = products.filter((p) => p.pop > 0);

  const customers = [
    ["أبو علي", "01011111111", 300000], ["الحاج محمود", "01022222222", 500000], ["أم يوسف", "01033333333", 200000],
    ["مطعم الرحمة", "01044444444", 800000], ["الأستاذ سامي", "01055555555", 150000], ["أم كريم", "01066666666", 100000],
  ].map(([n, p, l]) => ({ id: addCustomer(db, { name: n as string, phone: p as string, creditLimit: l as number }, now - days * DAY), limit: l as number }));

  const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
  const today0 = startToday.getTime();

  for (let d = days; d >= 0; d--) {
    const day0 = today0 - d * DAY;
    const dow = new Date(day0).getDay(); // 5 = Fri, 6 = Sat
    const target = Math.round(28 + (days - d) * 0.35 + (dow === 5 || dow === 6 ? 18 : 0) + r() * 10);
    const shifts: [number, number, number][] = [[ahmed, 9, 15], [mona, 16, 23]];
    for (const [cashier, h0, h1] of shifts) {
      const hours = Object.keys(HOUR_W).map(Number).filter((h) => h >= h0 && h <= h1 && day0 + h * HOUR < now);
      if (!hours.length) continue;
      const opened = day0 + h0 * HOUR - 10 * 60_000;
      const shiftId = openShift(db, cashier, 200000, opened);
      const share = hours.reduce((s, h) => s + HOUR_W[h], 0) / 118;
      const n = Math.round(target * share);
      const times = Array.from({ length: n }, () => {
        const h = weighted(hours, (x) => HOUR_W[x]);
        return day0 + h * HOUR + Math.floor(r() * HOUR);
      }).filter((t) => t < now).sort((a, b) => a - b);

      for (const ts of times) {
        const nLines = weighted([1, 2, 3, 4, 5, 6, 7], (k) => 9 - k);
        const lines = new Map<number, number>();
        for (let i = 0; i < nLines; i++) {
          const p = weighted(sellable, (x) => x.pop);
          lines.set(p.id, p.weighed ? 0.25 * (1 + Math.floor(r() * 10)) : weighted([1, 2, 3], (k) => 4 - k));
        }
        const roll = r();
        let payMethod: "cash" | "card" | "credit" = roll < 0.62 ? "cash" : roll < 0.95 ? "card" : "credit";
        let customerId: number | undefined, paidNow: number | undefined;
        if (payMethod === "credit") {
          const c = pick(customers);
          customerId = c.id; paidNow = r() < 0.4 ? 5000 : 0;
        }
        const cartLines = [...lines].map(([productId, qty]) => ({ productId, qty }));
        const subtotal = cartLines.reduce((s, l) => s + Math.round(products.find((p) => p.id === l.productId)!.price * l.qty), 0);
        try {
          if (payMethod === "credit") {
            const c = getCustomer(db, customerId!)!;
            if (c.balance + subtotal > c.creditLimit) { payMethod = "cash"; customerId = undefined; paidNow = undefined; }
          }
          const sale = createSale(db, {
            userId: cashier, shiftId, lines: cartLines, payMethod, customerId, paidNow, createdAt: ts,
            invoiceDiscount: r() < 0.04 ? Math.round(subtotal * 0.03) : 0,
          });
          if (r() < 0.015) {
            const info = getSaleForReturn(db, sale.no)!;
            const it = info.items[0];
            createReturn(db, { saleNo: sale.no, userId: owner, approvedBy: owner, shiftId, lines: [{ saleItemId: it.id, qty: Math.min(1, it.qty) }], createdAt: ts + 20 * 60_000 });
          }
        } catch { /* skip a sale that would break a limit */ }
      }
      if (r() < 0.12 && customers.length) {
        const c = pick(customers); const cur = getCustomer(db, c.id)!;
        if (cur.balance > 10000) addPayment(db, { customerId: c.id, amount: Math.round(cur.balance * 0.5), method: "cash", shiftId, userId: cashier, createdAt: day0 + (h1 - 1) * HOUR });
      }
      if (day0 + h1 * HOUR + HOUR < now) {
        const exp = shiftSummary(db, shiftId).expectedCash;
        // Mona is short on roughly one day in five; Ahmed is always accurate to the pound.
        const diff = cashier === mona && r() < 0.2 ? -Math.round((50 + r() * 150) * 100) : 0;
        closeShift(db, shiftId, exp + diff, day0 + h1 * HOUR + 30 * 60_000);
      } else {
        closeShift(db, shiftId, shiftSummary(db, shiftId).expectedCash, Math.min(now, day0 + h1 * HOUR));
      }
    }
    const dom = new Date(day0).getDate();
    const exp = (category: string, egp: number, note = "") => addExpense(db, { category, amount: egp * 100, note, userId: owner, createdAt: day0 + 10 * HOUR });
    if (dom === 1) exp("إيجار", 8000);
    if (dom === 5) exp("كهرباء", 1800 + Math.round(r() * 400));
    if (dom === 10) exp("إنترنت وتليفون", 450);
    if (dom === 28) exp("مرتبات", 15000, "مرتبات العمال");
    if (r() < 0.3) exp("نثريات", 50 + Math.round(r() * 350));
  }

  // Final stock: realistic levels, a few low/out, near-expiry dairy.
  products.forEach((p, i) => {
    const target = p.pop === 0 ? 25 + (i % 4) * 10 : i % 9 === 0 ? 3 : i % 13 === 0 ? 0 : 20 + Math.floor(r() * 100);
    adjustStock(db, p.id, p.weighed ? target / 2 : target, now);
  });
  for (const name of DAIRY) {
    const p = products.find((x) => x.name === name)!;
    for (const [offset, qty] of [[-3, 2], [4, 6], [9, 10], [25, 20], [60, 30]] as const)
      db.prepare("INSERT INTO batches(product_id,qty,expiry,created_at) VALUES(?,?,?,?)").run(p.id, qty, now + offset * DAY, now);
  }
  // Pre-open a shift for the demo owner so the register is usable immediately.
  openShift(db, owner, 100000, now);
  setSetting(db, "demo_seeded_at", String(now));
  return { ownerId: owner };
}
