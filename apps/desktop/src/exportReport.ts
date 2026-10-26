import type ExcelJS from "exceljs";
import type { BrandSettings, ReportCol, ReportResult } from "@market/core";

const TIME_KEYS = new Set(["at", "openedAt", "closedAt", "last"]);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Display text for one cell (Arabic digits), shared by the PDF/print HTML. */
export function formatCell(col: ReportCol, v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "text") return String(v);
  const n = Number(v);
  if (col.type === "money") return (n / 100).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (col.type === "percent") return n.toLocaleString("ar-EG", { maximumFractionDigits: 1 }) + "٪";
  if (col.type === "date") return TIME_KEYS.has(col.key) ? new Date(n).toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "short" }) : new Date(n).toLocaleDateString("ar-EG");
  return n.toLocaleString("ar-EG", { maximumFractionDigits: 3 });
}

const range = (r: ReportResult) => (r.from > 0 ? `من ${new Date(r.from).toLocaleDateString("ar-EG")} إلى ${new Date(r.to).toLocaleDateString("ar-EG")}` : "كل الفترات");

/** A4 RTL report, used for both "print" and "save as PDF". */
export function reportHtml(r: ReportResult, brand: BrandSettings, now = Date.now()): string {
  const head = r.columns.map((c) => `<th>${esc(c.label)}</th>`).join("");
  const body = r.rows.map((row) => `<tr>${r.columns.map((c) => `<td class="${c.type}">${esc(formatCell(c, row[c.key] ?? null))}</td>`).join("")}</tr>`).join("");
  const tot = r.totals
    ? `<tr class="tot">${r.columns.map((c, i) => `<td class="${c.type}">${i === 0 ? "الإجمالي" : c.key in r.totals! ? esc(formatCell(c, r.totals![c.key] as number)) : ""}</td>`).join("")}</tr>`
    : "";
  return `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><title>${esc(r.title)}</title><style>
@page{size:A4 ${r.columns.length > 7 ? "landscape" : "portrait"};margin:14mm}body{font:12px Tahoma,Arial,sans-serif;color:#111}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:2px 0 4px;color:#333}.meta{color:#555;margin-bottom:10px}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:5px 7px;text-align:right}th{background:#eef1f5}
td.money,td.qty,td.int,td.percent{text-align:left;white-space:nowrap}tr.tot td{font-weight:bold;background:#f6f6f6}tr:nth-child(even) td{background:#fafafa}
</style><body><h1>${esc(brand.brand_name)}</h1><h2>${esc(r.title)}</h2>
<div class="meta">${esc(range(r))} • اتطبع ${new Date(now).toLocaleString("ar-EG")} • ${r.rows.length.toLocaleString("ar-EG")} سطر</div>
<table><thead><tr>${head}</tr></thead><tbody>${body}${tot}</tbody></table></body></html>`;
}

/** A real .xlsx (numbers stay numbers, RTL sheet). Money is converted from piastres to pounds. */
export async function reportXlsx(r: ReportResult, brandName: string): Promise<Buffer> {
  const { default: Excel } = await import("exceljs");
  const wb = new Excel.Workbook();
  const ws = wb.addWorksheet(r.title.slice(0, 31), { views: [{ rightToLeft: true, state: "frozen", ySplit: 3 }] });
  ws.addRow([brandName]).font = { bold: true, size: 14 };
  ws.addRow([`${r.title} — ${range(r)}`]);
  const header = ws.addRow(r.columns.map((c) => c.label));
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EDF3" } };
  const cell = (c: ReportCol, v: string | number | null): ExcelJS.CellValue => {
    if (v === null || v === undefined || v === "") return null;
    if (c.type === "money") return Number(v) / 100;
    if (c.type === "date") return new Date(Number(v));
    if (c.type === "text") return String(v);
    return Number(v);
  };
  for (const row of r.rows) ws.addRow(r.columns.map((c) => cell(c, row[c.key] ?? null)));
  if (r.totals) {
    const t = ws.addRow(r.columns.map((c, i) => (i === 0 ? "الإجمالي" : c.key in r.totals! ? cell(c, r.totals![c.key] as number) : null)));
    t.font = { bold: true };
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(12, Math.min(40, c.label.length + 6));
    if (c.type === "money") col.numFmt = "#,##0.00";
    else if (c.type === "qty") col.numFmt = "#,##0.###";
    else if (c.type === "date") col.numFmt = TIME_KEYS.has(c.key) ? "yyyy-mm-dd hh:mm" : "yyyy-mm-dd";
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
