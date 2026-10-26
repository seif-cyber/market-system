import { useEffect, useState } from "react";
import type { ShiftHistoryRow } from "@market/core";
import { api, egp, errMsg, num } from "../api";
import { dateTimeAr } from "../fmt";

export function Shifts() {
  const [rows, setRows] = useState<ShiftHistoryRow[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api.listShifts().then(setRows).catch((e) => setErr(errMsg(e))); }, []);
  if (err) return <div className="error">{err}</div>;
  if (!rows) return <div className="muted">...</div>;
  return (
    <div className="page-wide">
      <p className="muted">كل وردية: الكاشير استلم الدرج بكام، باع بكام، المفروض يبقى في الدرج كام، وعدّ كام. الفروق بتظهر بالأحمر.</p>
      <div className="scroll">
        <table>
          <thead><tr><th>الكاشير</th><th>الفتح</th><th>التسليم</th><th>استلم الدرج</th><th>فواتير</th><th>المبيعات</th><th>نقدي</th><th>فيزا</th><th>آجل</th><th>المتوقع</th><th>المعدود</th><th>الفرق</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.cashier}</td><td>{dateTimeAr(r.openedAt)}</td><td>{r.closedAt ? dateTimeAr(r.closedAt) : <span className="pill warn">مفتوحة</span>}</td>
                <td>{egp(r.openingCash)}</td><td>{num(r.invoices)}</td><td><b>{egp(r.totalSales)}</b></td><td>{egp(r.cashSales)}</td><td>{egp(r.cardSales)}</td><td>{egp(r.creditSales)}</td>
                <td>{egp(r.expected)}</td><td>{r.counted === null ? "—" : egp(r.counted)}</td>
                <td className={r.difference === null ? "" : r.difference < 0 ? "down" : r.difference > 0 ? "warn" : "up"}>{r.difference === null ? "—" : r.difference === 0 ? "مظبوط" : (r.difference > 0 ? "+" : "") + egp(r.difference)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={12} className="muted">لا توجد ورديات لسه.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
