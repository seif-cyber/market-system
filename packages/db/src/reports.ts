import type { ReportCol, ReportFilterKey, ReportFilters, ReportResult } from "@market/core";
import type { Db } from "./types";
import { expiringBatches } from "./inventory";
import { listEntries } from "./treasury";
import { listExpenses } from "./expenses";
import { listPurchases, supplierDues } from "./purchases";
import { shiftHistory } from "./shifts";
import type { Account } from "./treasury";

type Row = Record<string, string | number | null>;
interface Def {
  id: string; group: "sales" | "purchases" | "inventory" | "finance"; title: string; filters: ReportFilterKey[];
  columns: ReportCol[]; sum?: string[];
  rows: (db: Db, p: Params, now: number) => Row[];
}
export interface Params { from: number; to: number; user: number | null; party: number | null; product: number | null; category: number | null; pay: string | null; account: string | null }

const c = (key: string, label: string, type: ReportCol["type"] = "text"): ReportCol => ({ key, label, type });
const all = (db: Db, sql: string, p: object) => db.prepare(sql).all(p) as Row[];
const SALE_F = "s.created_at BETWEEN @from AND @to AND (@user IS NULL OR s.user_id=@user) AND (@party IS NULL OR s.customer_id=@party) AND (@pay IS NULL OR s.pay_method=@pay)";
const ITEM_F = `${SALE_F} AND (@product IS NULL OR si.product_id=@product) AND (@category IS NULL OR p.category_id=@category)`;
const ITEM_FROM = "FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN products p ON p.id=si.product_id";
const REV = "(si.unit_price*si.qty - si.discount)";
const PAY_AR = "CASE s.pay_method WHEN 'cash' THEN 'نقدي' WHEN 'card' THEN 'فيزا' WHEN 'credit' THEN 'آجل' ELSE 'مختلط' END";
const DAY = 86_400_000;

const REASON: Record<string, string> = { sale: "بيع", return: "مرتجع", purchase: "استلام بضاعة", adjust: "جرد", purchase_void: "إلغاء فاتورة شراء" };
const KIND: Record<string, string> = {
  sale: "بيع", sale_return: "مرتجع", customer_payment: "سداد عميل", expense: "مصروف", expense_void: "إلغاء مصروف", deposit: "إيداع", withdrawal: "سحب",
  transfer: "تحويل", count_adjust: "جرد", shift_diff: "فرق وردية", handover_adjust: "تعديل استلام الدرج", supplier_payment: "دفع مورد", supplier_payment_void: "إلغاء دفعة مورد",
};
const STATUS: Record<string, string> = { paid: "مدفوعة", partial: "جزئي", unpaid: "آجل", overdue: "متأخرة", voided: "ملغية" };
const SALE_FILTERS: ReportFilterKey[] = ["range", "userId", "partyId", "payMethod"];
const ITEM_FILTERS: ReportFilterKey[] = [...SALE_FILTERS, "productId", "categoryId"];

const DEFS: Def[] = [
  // ---- sales ----
  { id: "sales_by_product", group: "sales", title: "المبيعات حسب الصنف", filters: ITEM_FILTERS, sum: ["qty", "revenue", "cost", "profit"],
    columns: [c("name", "الصنف"), c("category", "القسم"), c("qty", "الكمية", "qty"), c("revenue", "المبيعات", "money"), c("cost", "التكلفة", "money"), c("profit", "الربح", "money")],
    rows: (db, p) => all(db, `SELECT si.name name, COALESCE(cat.name,'') category, SUM(si.qty) qty, CAST(ROUND(SUM${REV}) AS INTEGER) revenue,
        CAST(ROUND(SUM(si.cost*si.qty)) AS INTEGER) cost, CAST(ROUND(SUM(${REV} - si.cost*si.qty)) AS INTEGER) profit
        ${ITEM_FROM} LEFT JOIN categories cat ON cat.id=p.category_id WHERE ${ITEM_F} GROUP BY si.product_id ORDER BY revenue DESC`, p) },
  { id: "sales_by_category", group: "sales", title: "المبيعات حسب القسم", filters: ITEM_FILTERS, sum: ["qty", "revenue", "profit"],
    columns: [c("name", "القسم"), c("qty", "الكمية", "qty"), c("revenue", "المبيعات", "money"), c("profit", "الربح", "money")],
    rows: (db, p) => all(db, `SELECT COALESCE(cat.name,'بدون قسم') name, SUM(si.qty) qty, CAST(ROUND(SUM${REV}) AS INTEGER) revenue, CAST(ROUND(SUM(${REV} - si.cost*si.qty)) AS INTEGER) profit
        ${ITEM_FROM} LEFT JOIN categories cat ON cat.id=p.category_id WHERE ${ITEM_F} GROUP BY cat.id ORDER BY revenue DESC`, p) },
  { id: "sales_by_customer", group: "sales", title: "المبيعات حسب العميل", filters: SALE_FILTERS, sum: ["invoices", "total", "discount"],
    columns: [c("name", "العميل"), c("invoices", "فواتير", "int"), c("total", "الإجمالي", "money"), c("discount", "الخصم", "money")],
    rows: (db, p) => all(db, `SELECT COALESCE(cu.name,'نقدي (بدون عميل)') name, COUNT(*) invoices, SUM(s.total) total, SUM(s.discount) discount
        FROM sales s LEFT JOIN customers cu ON cu.id=s.customer_id WHERE ${SALE_F} GROUP BY s.customer_id ORDER BY total DESC`, p) },
  { id: "sales_by_cashier", group: "sales", title: "المبيعات حسب الكاشير", filters: SALE_FILTERS, sum: ["invoices", "total", "discounts"],
    columns: [c("name", "الكاشير"), c("invoices", "فواتير", "int"), c("total", "الإجمالي", "money"), c("discounts", "الخصومات", "money")],
    rows: (db, p) => all(db, `SELECT u.name name, COUNT(*) invoices, SUM(s.total) total,
        SUM(s.discount) + COALESCE((SELECT SUM(si.discount) FROM sale_items si JOIN sales s2 ON s2.id=si.sale_id WHERE s2.user_id=u.id AND s2.created_at BETWEEN @from AND @to),0) discounts
        FROM sales s JOIN users u ON u.id=s.user_id WHERE ${SALE_F} GROUP BY s.user_id ORDER BY total DESC`, p) },
  { id: "sales_daily", group: "sales", title: "المبيعات اليومية", filters: SALE_FILTERS, sum: ["invoices", "total", "returns", "net"],
    columns: [c("day", "اليوم"), c("invoices", "فواتير", "int"), c("total", "المبيعات", "money"), c("returns", "المرتجعات", "money"), c("net", "الصافي", "money")],
    rows: (db, p) => all(db, `SELECT d day, SUM(n) invoices, SUM(t) total, SUM(r) returns, SUM(t)-SUM(r) net FROM (
          SELECT date(s.created_at/1000,'unixepoch','localtime') d, COUNT(*) n, SUM(s.total) t, 0 r FROM sales s WHERE ${SALE_F} GROUP BY d
          UNION ALL SELECT date(r.created_at/1000,'unixepoch','localtime'), 0, 0, SUM(r.total) FROM returns r JOIN sales s ON s.id=r.sale_id WHERE ${SALE_F.replace("s.created_at", "r.created_at")} GROUP BY 1)
        GROUP BY d ORDER BY d DESC`, p) },
  { id: "payment_types", group: "sales", title: "أنواع الدفع", filters: SALE_FILTERS, sum: ["invoices", "total"],
    columns: [c("method", "طريقة الدفع"), c("invoices", "فواتير", "int"), c("total", "الإجمالي", "money")],
    rows: (db, p) => all(db, `SELECT ${PAY_AR} method, COUNT(*) invoices, SUM(s.total) total FROM sales s WHERE ${SALE_F} GROUP BY s.pay_method ORDER BY total DESC`, p) },
  { id: "returns", group: "sales", title: "المرتجعات", filters: ["range", "userId"], sum: ["total"],
    columns: [c("at", "التاريخ", "date"), c("no", "فاتورة", "int"), c("user", "الكاشير"), c("approved", "اعتمده"), c("method", "الرد"), c("reason", "السبب"), c("total", "المبلغ", "money")],
    rows: (db, p) => all(db, `SELECT r.created_at at, s.no no, u.name user, COALESCE(a.name,'') approved, CASE r.refund_method WHEN 'cash' THEN 'نقدي' WHEN 'card' THEN 'فيزا' ELSE 'خصم من الدين' END method,
        COALESCE(r.reason,'') reason, r.total total FROM returns r JOIN sales s ON s.id=r.sale_id JOIN users u ON u.id=r.user_id LEFT JOIN users a ON a.id=r.approved_by
        WHERE r.created_at BETWEEN @from AND @to AND (@user IS NULL OR r.user_id=@user) ORDER BY r.created_at DESC`, p) },
  { id: "discounts_given", group: "sales", title: "الخصومات الممنوحة", filters: ["range", "userId", "partyId"], sum: ["invoiceDiscount", "itemDiscount", "promo"],
    columns: [c("at", "التاريخ", "date"), c("no", "فاتورة", "int"), c("cashier", "الكاشير"), c("invoiceDiscount", "خصم الفاتورة", "money"), c("itemDiscount", "خصم الأصناف", "money"), c("promo", "منها عروض", "money")],
    rows: (db, p) => all(db, `SELECT s.created_at at, s.no no, u.name cashier, s.discount invoiceDiscount,
        COALESCE((SELECT SUM(si.discount) FROM sale_items si WHERE si.sale_id=s.id),0) itemDiscount, COALESCE((SELECT SUM(si.promo_discount) FROM sale_items si WHERE si.sale_id=s.id),0) promo
        FROM sales s JOIN users u ON u.id=s.user_id WHERE s.created_at BETWEEN @from AND @to AND (@user IS NULL OR s.user_id=@user) AND (@party IS NULL OR s.customer_id=@party)
        AND (s.discount>0 OR EXISTS(SELECT 1 FROM sale_items si WHERE si.sale_id=s.id AND si.discount>0)) ORDER BY s.created_at DESC`, p) },
  { id: "promotions_applied", group: "sales", title: "العروض المطبّقة", filters: ["range", "userId"], sum: ["qty", "discount"],
    columns: [c("name", "العرض"), c("qty", "كمية الأصناف", "qty"), c("discount", "قيمة الخصم", "money")],
    rows: (db, p) => all(db, `SELECT pr.name name, SUM(si.qty) qty, SUM(si.promo_discount) discount FROM sale_items si JOIN sales s ON s.id=si.sale_id JOIN promotions pr ON pr.id=si.promo_id
        WHERE si.promo_discount>0 AND s.created_at BETWEEN @from AND @to AND (@user IS NULL OR s.user_id=@user) GROUP BY pr.id ORDER BY discount DESC`, p) },
  { id: "profit_margin", group: "sales", title: "هامش الربح", filters: ITEM_FILTERS, sum: ["revenue", "cost", "profit"],
    columns: [c("name", "الصنف"), c("revenue", "المبيعات", "money"), c("cost", "التكلفة", "money"), c("profit", "الربح", "money"), c("margin", "الهامش", "percent")],
    rows: (db, p) => all(db, `SELECT si.name name, CAST(ROUND(SUM${REV}) AS INTEGER) revenue, CAST(ROUND(SUM(si.cost*si.qty)) AS INTEGER) cost, CAST(ROUND(SUM(${REV} - si.cost*si.qty)) AS INTEGER) profit,
        ROUND(100.0*SUM(${REV} - si.cost*si.qty)/NULLIF(SUM${REV},0),1) margin ${ITEM_FROM} WHERE ${ITEM_F} GROUP BY si.product_id ORDER BY profit DESC`, p) },
  // ---- purchases ----
  { id: "purchase_invoices", group: "purchases", title: "فواتير الموردين", filters: ["range", "partyId"], sum: ["total", "paid", "remaining"],
    columns: [c("at", "التاريخ", "date"), c("supplier", "المورد"), c("ref", "رقم فاتورة المورد"), c("total", "الإجمالي", "money"), c("paid", "المدفوع", "money"), c("remaining", "المتبقي", "money"), c("due", "الاستحقاق", "date"), c("status", "الحالة")],
    rows: (db, p, now) => listPurchases(db, { supplierId: p.party ?? undefined, from: p.from, to: p.to, limit: 5000 }, now).filter((x) => !x.voided)
      .map((x) => ({ at: x.invoiceDate, supplier: x.supplier, ref: x.supplierRef, total: x.total, paid: x.paid, remaining: x.remaining, due: x.dueDate, status: STATUS[x.status] })) },
  { id: "purchases_by_product", group: "purchases", title: "المشتريات حسب الصنف", filters: ["range", "partyId", "productId", "categoryId"], sum: ["qty", "total"],
    columns: [c("name", "الصنف"), c("qty", "الكمية", "qty"), c("total", "إجمالي الشراء", "money"), c("avg", "متوسط سعر الشراء", "money")],
    rows: (db, p) => all(db, `SELECT pr.name name, SUM(i.qty) qty, CAST(ROUND(SUM(i.qty*i.unit_cost)) AS INTEGER) total, CAST(ROUND(SUM(i.qty*i.unit_cost)/SUM(i.qty)) AS INTEGER) avg
        FROM purchase_items i JOIN purchase_invoices v ON v.id=i.purchase_id JOIN products pr ON pr.id=i.product_id
        WHERE v.voided=0 AND v.invoice_date BETWEEN @from AND @to AND (@party IS NULL OR v.supplier_id=@party) AND (@product IS NULL OR i.product_id=@product) AND (@category IS NULL OR pr.category_id=@category)
        GROUP BY i.product_id ORDER BY total DESC`, p) },
  { id: "supplier_dues", group: "purchases", title: "مستحقات الموردين", filters: [], sum: ["balance", "overdue"],
    columns: [c("name", "المورد"), c("phone", "التليفون"), c("balance", "المستحق", "money"), c("overdue", "منه متأخر", "money"), c("nextDue", "أقرب استحقاق", "date")],
    rows: (db, _p, now) => supplierDues(db, now).map((d) => ({ name: d.name, phone: d.phone, balance: d.balance, overdue: d.overdue, nextDue: d.nextDue })) },
  // ---- inventory ----
  { id: "stock_movements", group: "inventory", title: "حركة المخزون", filters: ["range", "productId", "categoryId"],
    columns: [c("at", "التاريخ", "date"), c("name", "الصنف"), c("reason", "النوع"), c("delta", "الكمية", "qty")],
    rows: (db, p) => all(db, `SELECT m.created_at at, pr.name name, m.reason reason, m.delta delta FROM stock_movements m JOIN products pr ON pr.id=m.product_id
        WHERE m.created_at BETWEEN @from AND @to AND (@product IS NULL OR m.product_id=@product) AND (@category IS NULL OR pr.category_id=@category) ORDER BY m.created_at DESC, m.id DESC LIMIT 5000`, p)
      .map((r) => ({ ...r, reason: REASON[r.reason as string] ?? r.reason })) },
  { id: "low_stock", group: "inventory", title: "النواقص", filters: ["categoryId"],
    columns: [c("name", "الصنف"), c("stock", "المخزون", "qty"), c("minStock", "الحد الأدنى", "qty")],
    rows: (db, p) => all(db, "SELECT name, stock, min_stock minStock FROM products pr WHERE active=1 AND min_stock>0 AND stock<=min_stock AND (@category IS NULL OR category_id=@category) ORDER BY stock/min_stock", p) },
  { id: "expiry", group: "inventory", title: "الصلاحية (خلال 60 يوم)", filters: [],
    columns: [c("name", "الصنف"), c("qty", "الكمية", "qty"), c("expiry", "تاريخ الانتهاء", "date"), c("daysLeft", "الأيام المتبقية", "int")],
    rows: (db, _p, now) => expiringBatches(db, 60, now, 1000).map((e) => ({ name: e.name, qty: e.qty, expiry: e.expiry, daysLeft: e.daysLeft })) },
  { id: "dead_stock", group: "inventory", title: "المخزون الراكد (30 يوم)", filters: ["categoryId"], sum: ["value"],
    columns: [c("name", "الصنف"), c("stock", "المخزون", "qty"), c("cost", "سعر الشراء", "money"), c("value", "القيمة", "money")],
    rows: (db, p, now) => all(db, `SELECT pr.name name, pr.stock stock, pr.cost cost, CAST(ROUND(pr.stock*pr.cost) AS INTEGER) value FROM products pr
        WHERE pr.active=1 AND pr.stock>0 AND (@category IS NULL OR pr.category_id=@category)
        AND NOT EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE si.product_id=pr.id AND s.created_at>=@since) ORDER BY value DESC`, { ...p, since: now - 30 * DAY }) },
  { id: "stock_valuation", group: "inventory", title: "تقييم المخزون", filters: ["categoryId"], sum: ["value"],
    columns: [c("name", "الصنف"), c("category", "القسم"), c("stock", "المخزون", "qty"), c("cost", "سعر الشراء", "money"), c("value", "القيمة", "money")],
    rows: (db, p) => all(db, `SELECT pr.name name, COALESCE(cat.name,'') category, pr.stock stock, pr.cost cost, CAST(ROUND(MAX(pr.stock,0)*pr.cost) AS INTEGER) value
        FROM products pr LEFT JOIN categories cat ON cat.id=pr.category_id WHERE pr.active=1 AND (@category IS NULL OR pr.category_id=@category) ORDER BY value DESC`, p) },
  // ---- finance ----
  { id: "treasury_movements", group: "finance", title: "حركة الخزنة", filters: ["range", "account"], sum: ["in", "out"],
    columns: [c("at", "التاريخ", "date"), c("account", "الحساب"), c("kind", "النوع"), c("note", "البيان"), c("in", "داخل", "money"), c("out", "خارج", "money"), c("balance", "الرصيد بعده", "money"), c("user", "سجّله")],
    rows: (db, p) => listEntries(db, { account: (p.account as Account | null) ?? undefined, from: p.from, to: p.to, limit: 5000 })
      .map((e) => ({ at: e.createdAt, account: e.account === "cash" ? "كاش" : "بنك / فيزا", kind: KIND[e.kind] ?? e.kind, note: e.note ?? "", in: e.delta > 0 ? e.delta : 0, out: e.delta < 0 ? -e.delta : 0, balance: e.balanceAfter, user: e.userName ?? "" })) },
  { id: "expenses", group: "finance", title: "المصاريف", filters: ["range"], sum: ["amount"],
    columns: [c("at", "التاريخ", "date"), c("category", "النوع"), c("amount", "المبلغ", "money"), c("source", "اتدفع من"), c("note", "ملاحظة"), c("user", "سجّله")],
    rows: (db, p) => listExpenses(db, p.from, p.to).map((e) => ({ at: e.createdAt, category: e.category, amount: e.amount, source: e.paidFrom === "bank" ? "البنك" : e.fromDrawer ? "الدرج" : "الخزنة", note: e.note, user: e.userName })) },
  { id: "shifts", group: "finance", title: "الورديات والفروق", filters: ["range", "userId"], sum: ["totalSales", "difference"],
    columns: [c("cashier", "الكاشير"), c("openedAt", "الفتح", "date"), c("closedAt", "التسليم", "date"), c("openingCash", "استلم الدرج", "money"), c("invoices", "فواتير", "int"), c("totalSales", "المبيعات", "money"), c("expected", "المتوقع", "money"), c("counted", "المعدود", "money"), c("difference", "الفرق", "money")],
    rows: (db, p) => shiftHistory(db, 1000).filter((s) => s.openedAt >= p.from && s.openedAt <= p.to && (p.user === null || (db.prepare("SELECT user_id FROM shifts WHERE id=?").get(s.id) as { user_id: number }).user_id === p.user))
      .map((s) => ({ cashier: s.cashier, openedAt: s.openedAt, closedAt: s.closedAt, openingCash: s.openingCash, invoices: s.invoices, totalSales: s.totalSales, expected: s.expected, counted: s.counted, difference: s.difference })) },
  { id: "customer_debts", group: "finance", title: "ديون العملاء", filters: [], sum: ["balance"],
    columns: [c("name", "العميل"), c("phone", "التليفون"), c("creditLimit", "حد الآجل", "money"), c("balance", "المديونية", "money"), c("last", "آخر حركة", "date")],
    rows: (db) => all(db, `SELECT cu.name name, cu.phone phone, cu.credit_limit creditLimit, SUM(l.delta) balance, MAX(l.created_at) last FROM customers cu JOIN customer_ledger l ON l.customer_id=cu.id
        WHERE cu.active=1 GROUP BY cu.id HAVING balance>0 ORDER BY balance DESC`, {}) },
];

export const listReports = () => DEFS.map(({ id, group, title, filters }) => ({ id, group, title, filters }));

/** Resolves the preset/custom range of the UI into absolute bounds. */
export function toParams(f: ReportFilters, now: number, rangeFor: (p: "today" | "7d" | "30d" | "month", n: number) => { from: number; to: number }): Params {
  let from = 0, to = now;
  if (f.range === "custom") { from = f.from ?? 0; to = f.to ?? now; }
  else if (f.range && f.range !== "all") ({ from, to } = rangeFor(f.range, now));
  return { from, to, user: f.userId ?? null, party: f.partyId ?? null, product: f.productId ?? null, category: f.categoryId ?? null, pay: f.payMethod ?? null, account: f.account ?? null };
}

export function runReport(db: Db, id: string, p: Params, now = Date.now()): ReportResult {
  const d = DEFS.find((x) => x.id === id);
  if (!d) throw new Error("تقرير غير موجود");
  const rows = d.rows(db, p, now);
  const totals = d.sum ? Object.fromEntries(d.sum.map((k) => [k, rows.reduce((s, r) => s + (Number(r[k]) || 0), 0)])) : null;
  return { id: d.id, title: d.title, columns: d.columns, rows, totals, from: p.from, to: p.to };
}
