import { chainHash, GENESIS_HASH, type Analytics } from "@market/core";
import type { Db } from "./types";
import { expiringBatches } from "./inventory";
import { balances, verifyTreasury } from "./treasury";
import { totalReceivables } from "./customers";
import { totalPayables } from "./purchases";

export type RangePreset = "today" | "7d" | "30d" | "month";
const DAY = 86_400_000;

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function rangeFor(preset: RangePreset, now = Date.now()): { from: number; to: number } {
  const today = startOfDay(now);
  if (preset === "today") return { from: today, to: now };
  if (preset === "7d") return { from: startOfDay(today - 6 * DAY), to: now };
  if (preset === "30d") return { from: startOfDay(today - 29 * DAY), to: now };
  const d = new Date(now); d.setDate(1); d.setHours(0, 0, 0, 0);
  return { from: d.getTime(), to: now };
}

/** Recomputes every invoice hash. `brokenAt` is the invoice number where tampering is first detected. */
export function verifySalesChain(db: Db): { ok: boolean; checked: number; brokenAt: number | null } {
  const sales = db.prepare("SELECT * FROM sales ORDER BY no").all() as any[];
  const itemStmt = db.prepare("SELECT product_id, unit_price, qty, discount FROM sale_items WHERE sale_id=? ORDER BY id");
  let prev = GENESIS_HASH;
  for (const s of sales) {
    const lines = (itemStmt.all(s.id) as any[]).map((i) => [i.product_id, i.unit_price, i.qty, i.discount]);
    const payload = { no: s.no, userId: s.user_id, subtotal: s.subtotal, discount: s.discount, tax: s.tax, total: s.total, lines, createdAt: s.created_at };
    if (s.prev_hash !== prev || chainHash(prev, payload) !== s.hash) return { ok: false, checked: sales.length, brokenAt: s.no };
    prev = s.hash;
  }
  return { ok: true, checked: sales.length, brokenAt: null };
}

const one = <T>(db: Db, sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
const all = <T>(db: Db, sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

function netSales(db: Db, from: number, to: number) {
  const s = one<{ n: number; total: number; tax: number }>(db, "SELECT COUNT(*) n, COALESCE(SUM(total),0) total, COALESCE(SUM(tax),0) tax FROM sales WHERE created_at BETWEEN ? AND ?", from, to);
  const r = one<{ total: number; tax: number }>(db, "SELECT COALESCE(SUM(total),0) total, COALESCE(SUM(tax),0) tax FROM returns WHERE created_at BETWEEN ? AND ?", from, to);
  return { sales: s.total, invoices: s.n, returns: r.total, net: s.total - r.total, netExTax: s.total - s.tax - (r.total - r.tax) };
}

export function analytics(db: Db, range: { from: number; to: number }, now = Date.now(), alertDays = 30): Analytics {
  const { from, to } = range;
  const cur = netSales(db, from, to);
  const len = to - from + 1;
  const prev = netSales(db, from - len, from - 1);

  const cogsSold = one<{ v: number }>(db, "SELECT COALESCE(SUM(si.cost*si.qty),0) v FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.created_at BETWEEN ? AND ?", from, to).v;
  const cogsBack = one<{ v: number }>(db, "SELECT COALESCE(SUM(ri.cost),0) v FROM return_items ri JOIN returns r ON r.id=ri.return_id WHERE r.created_at BETWEEN ? AND ?", from, to).v;
  const grossProfit = Math.round(cur.netExTax - (cogsSold - cogsBack));
  const expenses = one<{ v: number }>(db, "SELECT COALESCE(SUM(amount),0) v FROM expenses WHERE voided=0 AND created_at BETWEEN ? AND ?", from, to).v;

  // daily net sales (sales minus refunds), zero-filled
  const dayMap = new Map<string, number>();
  for (const r of all<{ d: string; v: number }>(db, "SELECT date(created_at/1000,'unixepoch','localtime') d, SUM(total) v FROM sales WHERE created_at BETWEEN ? AND ? GROUP BY d", from, to)) dayMap.set(r.d, r.v);
  for (const r of all<{ d: string; v: number }>(db, "SELECT date(created_at/1000,'unixepoch','localtime') d, SUM(total) v FROM returns WHERE created_at BETWEEN ? AND ? GROUP BY d", from, to)) dayMap.set(r.d, (dayMap.get(r.d) ?? 0) - r.v);
  const daily: { day: string; sales: number }[] = [];
  for (let t = startOfDay(from), n = 0; t <= to && n < 400; t += DAY, n++) {
    const d = new Date(t);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    daily.push({ day: key, sales: dayMap.get(key) ?? 0 });
  }

  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, sales: 0, invoices: 0 }));
  for (const r of all<{ h: string; n: number; v: number }>(db, "SELECT strftime('%H', created_at/1000,'unixepoch','localtime') h, COUNT(*) n, SUM(total) v FROM sales WHERE created_at BETWEEN ? AND ? GROUP BY h", from, to)) {
    hourly[+r.h].sales = r.v; hourly[+r.h].invoices = r.n;
  }

  const topProducts = all<Analytics["topProducts"][number]>(
    db,
    `SELECT si.name, SUM(si.qty) qty, SUM(si.unit_price*si.qty - si.discount) revenue,
            SUM(si.unit_price*si.qty - si.discount - si.cost*si.qty) profit
     FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.created_at BETWEEN ? AND ?
     GROUP BY si.product_id ORDER BY revenue DESC LIMIT 10`, from, to,
  ).map((r) => ({ ...r, revenue: Math.round(r.revenue), profit: Math.round(r.profit) }));

  const deadFrom = now - 30 * DAY;
  const deadStock = all<Analytics["deadStock"][number]>(
    db,
    `SELECT p.name, p.stock, CAST(ROUND(p.stock*p.cost) AS INTEGER) value FROM products p
     WHERE p.active=1 AND p.stock>0 AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=p.id AND s.created_at>=?)
     ORDER BY value DESC, p.stock DESC LIMIT 10`, deadFrom,
  );

  const cashiers = all<Analytics["cashiers"][number]>(
    db,
    `SELECT u.name,
       (SELECT COUNT(*) FROM sales s WHERE s.user_id=u.id AND s.created_at BETWEEN @f AND @t) invoices,
       (SELECT COALESCE(SUM(total),0) FROM sales s WHERE s.user_id=u.id AND s.created_at BETWEEN @f AND @t) sales,
       (SELECT COALESCE(SUM(total),0) FROM returns r WHERE r.user_id=u.id AND r.created_at BETWEEN @f AND @t) returns,
       (SELECT COALESCE(SUM(discount),0) FROM sales s WHERE s.user_id=u.id AND s.created_at BETWEEN @f AND @t)
         + (SELECT COALESCE(SUM(si.discount),0) FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.user_id=u.id AND s.created_at BETWEEN @f AND @t) discounts,
       (SELECT COALESCE(SUM(counted_cash-expected_cash),0) FROM shifts sh WHERE sh.user_id=u.id AND sh.closed_at BETWEEN @f AND @t) cashDiff
     FROM users u WHERE u.active=1`,
    { f: from, t: to } as any,
  ).filter((c) => c.invoices > 0 || c.returns > 0 || c.cashDiff !== 0).sort((a, b) => b.sales - a.sales);

  const categories = all<Analytics["categories"][number]>(
    db,
    `SELECT COALESCE(c.name,'بدون قسم') name, SUM(si.qty) qty, CAST(ROUND(SUM(si.unit_price*si.qty - si.discount)) AS INTEGER) revenue,
            CAST(ROUND(SUM(si.unit_price*si.qty - si.discount - si.cost*si.qty)) AS INTEGER) profit
     FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id LEFT JOIN categories c ON c.id=p.category_id
     WHERE s.created_at BETWEEN ? AND ? GROUP BY c.id ORDER BY revenue DESC`, from, to,
  );
  const payments = all<{ method: string; total: number }>(db, "SELECT pay_method method, SUM(total) total FROM sales WHERE created_at BETWEEN ? AND ? GROUP BY pay_method ORDER BY total DESC", from, to);
  const expensesByCategory = all<{ category: string; total: number }>(db, "SELECT category, SUM(amount) total FROM expenses WHERE voided=0 AND created_at BETWEEN ? AND ? GROUP BY category ORDER BY total DESC", from, to);
  const lowStock = all<Analytics["lowStock"][number]>(db, "SELECT id, name, stock, min_stock minStock FROM products WHERE active=1 AND min_stock>0 AND stock<=min_stock ORDER BY stock/min_stock LIMIT 10");

  const debtRows = all<{ name: string; balance: number }>(
    db, "SELECT c.name, SUM(l.delta) balance FROM customers c JOIN customer_ledger l ON l.customer_id=c.id WHERE c.active=1 GROUP BY c.id HAVING balance>0 ORDER BY balance DESC",
  );

  return {
    range,
    kpi: {
      sales: cur.sales, invoices: cur.invoices, avgBasket: cur.invoices ? Math.round(cur.sales / cur.invoices) : 0,
      returns: cur.returns, netSales: cur.net, grossProfit, expenses, netProfit: grossProfit - expenses, prevNetSales: prev.net,
    },
    daily, hourly, topProducts, deadStock, cashiers, payments, expensesByCategory, lowStock,
    expiring: expiringBatches(db, alertDays, now, 10),
    debts: { total: debtRows.reduce((s, r) => s + r.balance, 0), top: debtRows.slice(0, 5) },
    integrity: verifySalesChain(db),
    categories,
    position: { ...balances(db), receivables: totalReceivables(db), payables: totalPayables(db) },
    treasuryCheck: (({ ok, mismatches }) => ({ ok, mismatches: mismatches.length }))(verifyTreasury(db)),
  };
}
