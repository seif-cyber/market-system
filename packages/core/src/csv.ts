/** Minimal RFC4180 parser (quotes, commas/semicolons, CRLF). */
export function parseCsv(text: string): string[][] {
  text = text.replace(/^﻿/, "");
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows;
}

export interface ImportedProduct { barcode: string; name: string; price: number; cost: number; stock: number; minStock?: number; expiry?: number }

const HEAD: Record<string, "barcode" | "name" | "price" | "cost" | "stock" | "min_stock" | "expiry"> = {
  barcode: "barcode", "الباركود": "barcode", "باركود": "barcode",
  name: "name", "الاسم": "name", "اسم الصنف": "name",
  price: "price", "السعر": "price", "سعر البيع": "price",
  cost: "cost", "التكلفة": "cost", "سعر الشراء": "cost",
  stock: "stock", "الكمية": "stock", "المخزون": "stock",
  min_stock: "min_stock", "الحد الأدنى": "min_stock",
  expiry: "expiry", "تاريخ الصلاحية": "expiry", "الصلاحية": "expiry",
};

/** Accepts 2026-12-31 or 31/12/2026; returns epoch ms (end of that day) or undefined. */
export function parseDate(s: string): number | undefined {
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/) ?? s.trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (!m) return undefined;
  const [y, mo, d] = m[1].length === 4 ? [+m[1], +m[2], +m[3]] : [+m[3], +m[2], +m[1]];
  const t = new Date(y, mo - 1, d, 23, 59, 59).getTime();
  return Number.isNaN(t) ? undefined : t;
}

const toPiastres = (s: string) => Math.round(parseFloat(s.replace(/[^\d.\-]/g, "") || "0") * 100);

/** Prices in the file are in pounds; converted to piastres. */
export function parseProductsCsv(text: string): { products: ImportedProduct[]; errors: string[] } {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (rows.length < 2) return { products: [], errors: ["الملف فاضي"] };
  const cols = rows[0].map((h) => HEAD[h.trim().toLowerCase()]);
  for (const need of ["barcode", "name", "price"] as const)
    if (!cols.includes(need)) errors.push(`عمود ناقص: ${need}`);
  if (errors.length) return { products: [], errors };
  const products: ImportedProduct[] = [];
  rows.slice(1).forEach((r, i) => {
    const o: Record<string, string> = {};
    cols.forEach((k, j) => k && (o[k] = (r[j] ?? "").trim()));
    const price = toPiastres(o.price ?? "");
    if (!o.barcode || !o.name || !(price > 0)) return void errors.push(`سطر ${i + 2}: بيانات ناقصة أو سعر غلط`);
    const expiry = o.expiry ? parseDate(o.expiry) : undefined;
    if (o.expiry && !expiry) return void errors.push(`سطر ${i + 2}: تاريخ الصلاحية غلط`);
    products.push({
      barcode: o.barcode, name: o.name, price, cost: toPiastres(o.cost ?? ""), stock: parseFloat(o.stock || "0") || 0,
      ...(o.min_stock ? { minStock: parseFloat(o.min_stock) || 0 } : {}), ...(expiry ? { expiry } : {}),
    });
  });
  return { products, errors };
}
