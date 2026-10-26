// Pure helpers, shared with the cloud site (no window.api here).
export const egp = (p: number) => (p / 100).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const egp0 = (p: number) => (p / 100).toLocaleString("ar-EG", { maximumFractionDigits: 0 });
export const num = (n: number) => n.toLocaleString("ar-EG", { maximumFractionDigits: 3 });
export const toPiastres = (s: string) => Math.round(parseFloat(s || "0") * 100) || 0;
export const fromPiastres = (p: number) => String(p / 100);
export const dateAr = (t: number) => new Date(t).toLocaleDateString("ar-EG", { day: "numeric", month: "short" });
export const dateLongAr = (t: number) => new Date(t).toLocaleDateString("ar-EG", { day: "numeric", month: "long", year: "numeric" });
export const dateTimeAr = (t: number) => new Date(t).toLocaleString("ar-EG", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
export const PAY_LABEL: Record<string, string> = { cash: "نقدي", card: "فيزا", credit: "آجل", mixed: "مختلط" };
export const ago = (t: number, now = Date.now()) => {
  const m = Math.max(0, Math.round((now - t) / 60_000));
  if (m < 1) return "دلوقتي";
  if (m < 60) return `من ${num(m)} دقيقة`;
  const h = Math.round(m / 60);
  return h < 48 ? `من ${num(h)} ساعة` : `من ${num(Math.round(h / 24))} يوم`;
};

const TIME_KEYS = new Set(["at", "openedAt", "closedAt", "last"]);
/** Cell text for a report column (Arabic digits); mirrors the PDF/print formatting in the main process. */
export function fmtCell(col: { key: string; type: string }, v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "";
  if (col.type === "text") return String(v);
  const n = Number(v);
  if (col.type === "money") return egp(n);
  if (col.type === "percent") return n.toLocaleString("ar-EG", { maximumFractionDigits: 1 }) + "٪";
  if (col.type === "date") return TIME_KEYS.has(col.key) ? dateTimeAr(n) : dateLongAr(n);
  return num(n);
}
