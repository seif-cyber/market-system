// Dev-only: writes apps/cloud/mock-data.json from the demo shop so `npm run build:mock -w @market/cloud` can render a design preview.
import { writeFileSync } from "node:fs";
import { analytics, openDb, rangeFor, shiftHistory } from "@market/db";
import { seedDemo } from "../apps/desktop/src/demo";
const db = openDb(":memory:");
const now = Date.now();
seedDemo(db, now);
const reports: Record<string, unknown> = {};
for (const p of ["today", "7d", "30d", "month"] as const) reports[p] = analytics(db, rangeFor(p, now), now);
const sales = (db.prepare("SELECT s.id, s.no, s.created_at createdAt, s.total, s.discount, s.pay_method payMethod, u.name cashier, COALESCE(c.name,'') customer FROM sales s JOIN users u ON u.id=s.user_id LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.no DESC LIMIT 60").all() as any[])
  .map((s) => ({ ...s, items: db.prepare("SELECT name, qty, unit_price unitPrice, discount FROM sale_items WHERE sale_id=?").all(s.id) }));
const shifts = shiftHistory(db, 30).filter((s) => s.closedAt).map((s) => ({ id: s.id, cashier: s.cashier, openedAt: s.openedAt, closedAt: s.closedAt, openingCash: s.openingCash, counted: s.counted, expected: s.expected }));
writeFileSync(new URL("../apps/cloud/mock-data.json", import.meta.url), JSON.stringify({ status: { brand: "سوبر ماركت النور (تجريبي)", syncedAt: now, integrityOk: true, lastInvoice: sales[0].no }, reports, sales, shifts }));
console.log("fixture ok", sales.length, shifts.length);
