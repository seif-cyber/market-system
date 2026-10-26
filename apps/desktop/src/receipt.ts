import type { BrandSettings } from "@market/core";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const egp = (p: number) => (p / 100).toFixed(2);

export interface ReceiptData {
  brand: BrandSettings;
  no: number;
  cashier: string;
  createdAt: number;
  items: { name: string; qty: number; unitPrice: number; discount: number }[];
  subtotal: number; discount: number; tax: number; total: number;
  payMethod: string;
  customerName?: string;
  paid?: number; // credit sales: paid at the counter
}

const PAY: Record<string, string> = { cash: "نقدي", card: "فيزا", mixed: "مختلط", credit: "آجل" };

/** 80mm thermal receipt as HTML (printed through the Windows printer driver, so Arabic just works). */
export function buildReceiptHtml(r: ReceiptData): string {
  const b = r.brand;
  const rows = r.items
    .map((i) => `<tr><td>${esc(i.name)}<br><small>${i.qty} × ${egp(i.unitPrice)}${i.discount ? ` − ${egp(i.discount)}` : ""}</small></td><td class="n">${egp(Math.round(i.unitPrice * i.qty) - i.discount)}</td></tr>`)
    .join("");
  const line = (l: string, v: number, cls = "") => `<tr class="${cls}"><td>${l}</td><td class="n">${egp(v)}</td></tr>`;
  return `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><style>
@page{size:80mm auto;margin:0}body{width:72mm;margin:0 auto;font:13px Tahoma,Arial,sans-serif;color:#000}
.c{text-align:center}img{max-width:60mm;max-height:24mm;filter:grayscale(1) contrast(2)}
table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top}.n{text-align:left;white-space:nowrap}
hr{border:0;border-top:1px dashed #000}.t td{font-size:16px;font-weight:bold}small{color:#333}</style><body>
<div class="c">${b.logo ? `<img src="${b.logo}"><br>` : ""}<b style="font-size:17px">${esc(b.brand_name)}</b><br>
${b.address ? esc(b.address) + "<br>" : ""}${b.phone ? "ت: " + esc(b.phone) + "<br>" : ""}${b.tax_no ? "الرقم الضريبي: " + esc(b.tax_no) : ""}</div><hr>
فاتورة رقم: <b>${r.no}</b><br>${new Date(r.createdAt).toLocaleString("ar-EG")}<br>الكاشير: ${esc(r.cashier)}<hr>
<table>${rows}</table><hr><table>
${line("الإجمالي", r.subtotal)}${r.discount ? line("الخصم", r.discount) : ""}${r.tax ? line("الضريبة", r.tax) : ""}${line("المطلوب", r.total, "t")}
<tr><td>الدفع</td><td class="n">${PAY[r.payMethod] ?? r.payMethod}</td></tr>
${r.payMethod === "credit" ? `<tr><td>العميل</td><td class="n">${esc(r.customerName ?? "")}</td></tr>${line("المدفوع", r.paid ?? 0)}${line("المتبقي (آجل)", r.total - (r.paid ?? 0), "t")}` : ""}</table><hr>
<div class="c">${esc(b.footer || "شكراً لزيارتكم")}</div></body></html>`;
}

export interface ShiftReportData {
  brand: BrandSettings; cashier: string; openedAt: number; closedAt: number;
  summary: { openingCash: number; invoices: number; totalSales: number; cashSales: number; cardSales: number; creditSales: number; cashReturns: number; cardReturns: number; debtPayments: number; payouts: number; expectedCash: number };
  counted: number; difference: number;
}

/** End-of-shift (Z) report, 80mm. */
export function buildShiftReportHtml(r: ShiftReportData): string {
  const s = r.summary;
  const row = (l: string, v: number, cls = "") => `<tr class="${cls}"><td>${l}</td><td class="n">${egp(v)}</td></tr>`;
  const diff = r.difference === 0 ? "مظبوط" : r.difference > 0 ? `زيادة ${egp(r.difference)}` : `عجز ${egp(-r.difference)}`;
  return `<!doctype html><html dir="rtl" lang="ar"><meta charset="utf-8"><style>
@page{size:80mm auto;margin:0}body{width:72mm;margin:0 auto;font:13px Tahoma,Arial,sans-serif;color:#000}
table{width:100%;border-collapse:collapse}td{padding:2px 0}.n{text-align:left}hr{border:0;border-top:1px dashed #000}.t td{font-weight:bold;font-size:15px}.c{text-align:center}</style><body>
<div class="c"><b style="font-size:16px">${esc(r.brand.brand_name)}</b><br>تقرير إقفال الوردية</div><hr>
الكاشير: ${esc(r.cashier)}<br>فتح: ${new Date(r.openedAt).toLocaleString("ar-EG")}<br>قفل: ${new Date(r.closedAt).toLocaleString("ar-EG")}<hr>
<table>${row("عدد الفواتير", 0).replace(egp(0), String(s.invoices))}${row("إجمالي المبيعات", s.totalSales)}${row("نقدي (داخل الدرج)", s.cashSales)}${row("فيزا", s.cardSales)}${row("آجل", s.creditSales)}
${row("تحصيل ديون نقدي", s.debtPayments)}${row("مرتجع نقدي", s.cashReturns)}${s.payouts ? row("مدفوعات من الدرج", s.payouts) : ""}${row("مرتجع فيزا", s.cardReturns)}</table><hr>
<table>${row("رصيد الافتتاح", s.openingCash)}${row("المتوقع في الدرج", s.expectedCash)}${row("المعدود فعليًا", r.counted)}${row("الفرق: " + diff, Math.abs(r.difference), "t")}</table><hr>
<div class="c">توقيع الكاشير: ____________</div></body></html>`;
}
