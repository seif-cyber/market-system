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

export interface ImportedProduct { barcode: string; name: string; price: number; cost: number; stock: number }

const HEAD: Record<string, keyof ImportedProduct> = {
  barcode: "barcode", "الباركود": "barcode", "باركود": "barcode",
  name: "name", "الاسم": "name", "اسم الصنف": "name",
  price: "price", "السعر": "price", "سعر البيع": "price",
  cost: "cost", "التكلفة": "cost", "سعر الشراء": "cost",
  stock: "stock", "الكمية": "stock", "المخزون": "stock",
};

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
    products.push({ barcode: o.barcode, name: o.name, price, cost: toPiastres(o.cost ?? ""), stock: parseFloat(o.stock || "0") || 0 });
  });
  return { products, errors };
}
