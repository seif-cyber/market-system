import { useCallback, useEffect, useState } from "react";
import type { Expense, RangePreset } from "@market/core";
import { api, egp, errMsg, toPiastres } from "../api";
import { dateTimeAr } from "../fmt";
import { RANGES } from "../components/DashboardView";
import { Toast, useToast } from "../components/ui";

const CATS = ["إيجار", "مرتبات", "كهرباء", "مياه", "إنترنت وتليفون", "صيانة", "مواصلات", "نثريات", "أخرى"];

export function Expenses({ isOwner }: { isOwner: boolean }) {
  const [range, setRange] = useState<RangePreset>("month");
  const [rows, setRows] = useState<Expense[]>([]);
  const [cat, setCat] = useState(CATS[0]);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const toast = useToast();
  const load = useCallback(() => api.listExpenses(range).then(setRows).catch((e) => toast.fail(errMsg(e))), [range]); // eslint-disable-line
  useEffect(() => { load(); }, [load]);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <div className="page-wide">
      <div className="card wide">
        <h2>تسجيل مصروف</h2>
        <p className="muted">المصاريف بتتخصم من الربح، فتعرف صافي الربح الحقيقي في لوحة التحكم.</p>
        <div className="row">
          <label className="grow">النوع<select value={cat} onChange={(e) => setCat(e.target.value)}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="grow">المبلغ (جنيه)<input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label className="grow">ملاحظة<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        <button className="primary" disabled={!(parseFloat(amount) > 0)} onClick={() => api.addExpense(cat, toPiastres(amount), note).then(() => { setAmount(""); setNote(""); load(); toast.ok("اتسجّل المصروف"); }).catch((e) => toast.fail(errMsg(e)))}>إضافة</button>
      </div>
      <div className="row toolbar"><div className="tabs">{RANGES.map((r) => <button key={r.id} className={range === r.id ? "on" : ""} onClick={() => setRange(r.id)}>{r.label}</button>)}</div><div className="pill">الإجمالي: <b>{egp(total)}</b></div></div>
      <table>
        <thead><tr><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>ملاحظة</th><th>سجّله</th>{isOwner && <th />}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}><td>{dateTimeAr(r.createdAt)}</td><td>{r.category}</td><td>{egp(r.amount)}</td><td>{r.note}</td><td>{r.userName}</td>
              {isOwner && <td><button onClick={() => confirm("حذف المصروف ده؟") && api.deleteExpense(r.id).then(load)}>حذف</button></td>}</tr>
          ))}
          {!rows.length && <tr><td colSpan={6} className="muted">لا توجد مصاريف في الفترة دي.</td></tr>}
        </tbody>
      </table>
      <Toast msg={toast.msg} />
    </div>
  );
}
